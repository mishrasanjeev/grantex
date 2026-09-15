from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any

import httpx
import jwt
from jwt.algorithms import ECAlgorithm, RSAAlgorithm

from ._errors import GrantexTokenError
from ._types import GrantTokenPayload, VerifiedGrant, VerifyGrantTokenOptions


GRANT_TOKEN_ALGORITHMS: tuple[str, ...] = ("RS256", "ES256")
"""Signature algorithms a grant token may use.

Each maps to exactly one key type: RS256 to an RSA key, ES256 to an EC key on
P-256. ``none``, the HMAC family and every other algorithm are refused.
"""

_KEY_TYPE_FOR_ALGORITHM: dict[str, tuple[str, str | None]] = {
    "RS256": ("RSA", None),
    "ES256": ("EC", "P-256"),
}

_PRODUCTION_JWKS_URI = "https://api.grantex.dev/.well-known/jwks.json"
_PRODUCTION_ISSUER = "https://grantex.dev"

# JWKS caching mirrors JOSE's createRemoteJWKSet (used by the TypeScript SDK):
# a fetched key set is reused for the TTL; a kid the cached set does not know
# (key rotation) triggers one re-fetch, but no more often than the cooldown,
# so a flood of forged kids cannot become a flood of requests against the
# issuer; the map is bounded so caller-supplied URLs cannot grow memory.
_JWKS_CACHE_TTL_SECONDS = 10 * 60.0
_JWKS_REFRESH_COOLDOWN_SECONDS = 30.0
_JWKS_CACHE_MAX_ENTRIES = 64


@dataclass
class _JwksCacheEntry:
    keys: list[dict[str, Any]]
    fetched_at: float


_jwks_cache: dict[str, _JwksCacheEntry] = {}
_jwks_cache_lock = threading.Lock()


def clear_jwks_cache() -> None:
    """Drop every cached JWKS. Intended for deterministic tests."""
    with _jwks_cache_lock:
        _jwks_cache.clear()


def verify_grant_token(
    token: str,
    options: VerifyGrantTokenOptions,
) -> VerifiedGrant:
    """Verify a Grantex grant token locally using remotely retrieved JWKS.

    The signature must be RS256 or ES256 (:data:`GRANT_TOKEN_ALGORITHMS`);
    ``options.algorithms`` can narrow that list but never widen it. The key is
    the JWK Set entry with the token's ``kid`` whose key type (and curve)
    matches the algorithm and whose ``alg``, when published, equals it.

    Raises:
        GrantexTokenError: if the token is invalid, expired, tampered, or
            missing required scopes.
    """
    allowed = _resolve_algorithms(options.algorithms)
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as exc:
        raise GrantexTokenError(
            f"Grant token verification failed: {exc}"
        ) from exc

    alg = header.get("alg")
    if not isinstance(alg, str) or alg not in allowed:
        raise GrantexTokenError(
            f"Grant token uses unsupported algorithm '{alg}'; "
            f"allowed: {', '.join(allowed)}"
        )

    jwks_uri = options.jwks_uri
    expected_issuer = options.issuer
    if options.issuer_did is not None and options.issuer_did.startswith("did:web:"):
        domain = options.issuer_did.removeprefix("did:web:").replace(":", "/")
        jwks_uri = f"https://{domain}/.well-known/jwks.json"
        if expected_issuer is None:
            expected_issuer = f"https://{domain}"
    if expected_issuer is None:
        expected_issuer = _derive_issuer_from_jwks_uri(jwks_uri)

    signing_key = _fetch_signing_key(jwks_uri, header.get("kid"), alg)

    decode_kwargs: dict[str, Any] = {
        # Only the header's algorithm, already checked against the allowlist
        # and against the key's type.
        "algorithms": [alg],
        "leeway": options.clock_tolerance,
        "issuer": expected_issuer,
    }
    if options.audience is not None:
        decode_kwargs["audience"] = options.audience
    else:
        decode_kwargs["options"] = {"verify_aud": False}

    try:
        payload_data: dict[str, Any] = jwt.decode(
            token,
            signing_key,
            **decode_kwargs,
        )
    except jwt.PyJWTError as exc:
        raise GrantexTokenError(
            f"Grant token verification failed: {exc}"
        ) from exc

    payload = _build_payload(payload_data)

    required_scopes = options.required_scopes or []
    if required_scopes:
        missing = [s for s in required_scopes if s not in payload.scp]
        if missing:
            raise GrantexTokenError(
                f"Grant token is missing required scopes: {', '.join(missing)}"
            )

    return _payload_to_verified_grant(payload)


def _resolve_algorithms(requested: list[str] | None) -> tuple[str, ...]:
    if requested is None:
        return GRANT_TOKEN_ALGORITHMS
    if isinstance(requested, str) or not requested:
        raise GrantexTokenError(
            "algorithms must list at least one of "
            + ", ".join(GRANT_TOKEN_ALGORITHMS)
        )
    unsupported = [a for a in requested if a not in GRANT_TOKEN_ALGORITHMS]
    if unsupported:
        raise GrantexTokenError(
            f"Unsupported grant token algorithm {', '.join(map(str, unsupported))}; "
            f"allowed: {', '.join(GRANT_TOKEN_ALGORITHMS)}"
        )
    return tuple(dict.fromkeys(requested))


def _derive_issuer_from_jwks_uri(jwks_uri: str) -> str:
    """Map the production JWKS alias to its canonical issuer; otherwise
    mirror the TypeScript SDK's URL-derived issuer behavior."""
    from urllib.parse import urlparse

    if jwks_uri.rstrip("/") == _PRODUCTION_JWKS_URI:
        return _PRODUCTION_ISSUER

    parsed = urlparse(jwks_uri)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    path = parsed.path or ""
    suffix = "/.well-known/jwks.json"
    if path.endswith(suffix):
        return f"{origin}{path[: -len(suffix)]}"
    return f"{origin}{path.rstrip('/')}"


def _download_jwks(jwks_uri: str) -> list[dict[str, Any]]:
    """Fetch and validate the key set. Blocking: callers on an event loop
    must run this in a worker thread (see grantex.fastapi)."""
    try:
        resp = httpx.get(jwks_uri, timeout=10.0)
        resp.raise_for_status()
        jwks: dict[str, Any] = resp.json()
    except Exception as exc:
        raise GrantexTokenError(
            f"Failed to fetch JWKS from {jwks_uri}: {exc}"
        ) from exc

    raw_keys = jwks.get("keys", [])
    if not isinstance(raw_keys, list):
        raise GrantexTokenError("JWKS keys must be an array")
    keys: list[dict[str, Any]] = [
        key for key in raw_keys if isinstance(key, dict)
    ]
    if not keys:
        raise GrantexTokenError("JWKS contains no keys")
    return keys


def _get_jwks(jwks_uri: str, *, force_refresh: bool = False) -> _JwksCacheEntry:
    """Return the cached key set for ``jwks_uri``, fetching when stale."""
    now = time.monotonic()
    with _jwks_cache_lock:
        entry = _jwks_cache.get(jwks_uri)
        if (
            entry is not None
            and not force_refresh
            and now - entry.fetched_at < _JWKS_CACHE_TTL_SECONDS
        ):
            return entry

    fresh = _JwksCacheEntry(keys=_download_jwks(jwks_uri), fetched_at=time.monotonic())
    with _jwks_cache_lock:
        _jwks_cache.pop(jwks_uri, None)
        if len(_jwks_cache) >= _JWKS_CACHE_MAX_ENTRIES:
            oldest = next(iter(_jwks_cache))
            del _jwks_cache[oldest]
        _jwks_cache[jwks_uri] = fresh
    return fresh


def _fetch_signing_key(jwks_uri: str, kid: str | None, alg: str = "RS256") -> Any:
    """Resolve the public key for ``kid`` and ``alg`` from the (cached) JWKS."""
    if alg not in _KEY_TYPE_FOR_ALGORITHM:
        raise GrantexTokenError(f"Grant token uses unsupported algorithm '{alg}'")
    if kid is not None and (not isinstance(kid, str) or not kid):
        raise GrantexTokenError("Grant token kid header must be a non-empty string")

    entry = _get_jwks(jwks_uri)
    matched = _select_key(entry.keys, kid, alg)
    if matched is None and kid is not None:
        # Key rotation: the kid may simply be newer than the cached set. One
        # refresh per cooldown window keeps unknown kids from being a DoS lever.
        if time.monotonic() - entry.fetched_at >= _JWKS_REFRESH_COOLDOWN_SECONDS:
            entry = _get_jwks(jwks_uri, force_refresh=True)
            matched = _select_key(entry.keys, kid, alg)

    kty = _KEY_TYPE_FOR_ALGORITHM[alg][0]
    if matched is None:
        raise GrantexTokenError(
            f"No matching {kty} key found in JWKS for {alg} (kid={kid!r})"
        )

    try:
        if kty == "RSA":
            return RSAAlgorithm.from_jwk(matched)
        return ECAlgorithm.from_jwk(matched)
    except Exception as exc:
        raise GrantexTokenError(
            f"Failed to construct {kty} key from JWK: {exc}"
        ) from exc


def _key_matches_algorithm(key: dict[str, Any], alg: str) -> bool:
    kty, crv = _KEY_TYPE_FOR_ALGORITHM[alg]
    if key.get("kty") != kty:
        return False
    if crv is not None and key.get("crv") != crv:
        return False
    # A key published for another algorithm is never used for this one.
    if "alg" in key and key.get("alg") != alg:
        return False
    if "use" in key and key.get("use") != "sig":
        return False
    return True


def _select_key(
    keys: list[dict[str, Any]], kid: str | None, alg: str = "RS256"
) -> dict[str, Any] | None:
    kty = _KEY_TYPE_FOR_ALGORITHM[alg][0]
    matched: dict[str, Any] | None = None
    if kid is not None:
        # A token that names a key must match that exact key, of the type its
        # algorithm requires. Falling back to another key turns an unknown or
        # stale kid into an ambiguous trust decision and differs from JOSE
        # resolver behavior in the other SDKs.
        matching_keys = [
            key for key in keys
            if key.get("kid") == kid and _key_matches_algorithm(key, alg)
        ]
        if len(matching_keys) == 1:
            matched = matching_keys[0]
        elif len(matching_keys) > 1:
            raise GrantexTokenError(
                f"JWKS contains multiple {kty} keys with kid={kid!r}"
            )
    else:
        candidates = [key for key in keys if _key_matches_algorithm(key, alg)]
        if len(candidates) == 1:
            matched = candidates[0]
        elif len(candidates) > 1:
            raise GrantexTokenError(
                f"Grant token header is missing kid and JWKS contains multiple {kty} keys"
            )
    return matched


def _build_payload(data: dict[str, Any]) -> GrantTokenPayload:
    required = ("jti", "sub", "agt", "dev", "scp", "iat", "exp")
    for field in required:
        if field not in data:
            raise GrantexTokenError(
                f"Grant token is missing required claims ({', '.join(required)})"
            )
    raw_depth = data.get("delegationDepth")
    return GrantTokenPayload(
        iss=data.get("iss", ""),
        sub=str(data["sub"]),
        agt=str(data["agt"]),
        dev=str(data["dev"]),
        scp=tuple(data["scp"]),
        iat=int(data["iat"]),
        exp=int(data["exp"]),
        jti=str(data["jti"]),
        client_id=data.get("client_id"),
        grnt=data.get("grnt"),
        parent_agt=data.get("parentAgt"),
        parent_grnt=data.get("parentGrnt"),
        delegation_depth=int(raw_depth) if raw_depth is not None else None,
        authorization_details=data.get("authorization_details"),
    )


def _payload_to_verified_grant(payload: GrantTokenPayload) -> VerifiedGrant:
    return VerifiedGrant(
        token_id=payload.jti,
        grant_id=payload.grnt if payload.grnt is not None else payload.jti,
        principal_id=payload.sub,
        agent_did=payload.agt,
        developer_id=payload.dev,
        scopes=payload.scp,
        issued_at=payload.iat,
        expires_at=payload.exp,
        client_id=payload.client_id,
        parent_agent_did=payload.parent_agt,
        parent_grant_id=payload.parent_grnt,
        delegation_depth=payload.delegation_depth,
        authorization_details=payload.authorization_details,
    )
