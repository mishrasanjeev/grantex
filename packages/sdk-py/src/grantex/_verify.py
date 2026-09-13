from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any

import httpx
import jwt
from jwt.algorithms import RSAAlgorithm

from ._errors import GrantexTokenError
from ._types import GrantTokenPayload, VerifiedGrant, VerifyGrantTokenOptions


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

    Algorithm is fixed to RS256 per SPEC §11 and cannot be overridden.

    Raises:
        GrantexTokenError: if the token is invalid, expired, tampered, or
            missing required scopes.
    """
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as exc:
        raise GrantexTokenError(
            f"Grant token verification failed: {exc}"
        ) from exc

    if header.get("alg") != "RS256":
        raise GrantexTokenError(
            f"Grant token uses unsupported algorithm '{header.get('alg')}'; "
            "only RS256 is allowed per SPEC §11"
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

    signing_key = _fetch_signing_key(jwks_uri, header.get("kid"))

    decode_kwargs: dict[str, Any] = {
        "algorithms": ["RS256"],
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


def _fetch_signing_key(jwks_uri: str, kid: str | None) -> Any:
    """Resolve the RSA public key for ``kid`` from the (cached) JWKS."""
    if kid is not None and (not isinstance(kid, str) or not kid):
        raise GrantexTokenError("Grant token kid header must be a non-empty string")

    entry = _get_jwks(jwks_uri)
    matched = _select_key(entry.keys, kid)
    if matched is None and kid is not None:
        # Key rotation: the kid may simply be newer than the cached set. One
        # refresh per cooldown window keeps unknown kids from being a DoS lever.
        if time.monotonic() - entry.fetched_at >= _JWKS_REFRESH_COOLDOWN_SECONDS:
            entry = _get_jwks(jwks_uri, force_refresh=True)
            matched = _select_key(entry.keys, kid)

    if matched is None:
        raise GrantexTokenError(
            f"No matching RSA key found in JWKS (kid={kid!r})"
        )

    try:
        return RSAAlgorithm.from_jwk(matched)
    except Exception as exc:
        raise GrantexTokenError(
            f"Failed to construct RSA key from JWK: {exc}"
        ) from exc


def _select_key(keys: list[dict[str, Any]], kid: str | None) -> dict[str, Any] | None:
    matched: dict[str, Any] | None = None
    if kid is not None:
        # A token that names a key must match that exact RSA key. Falling back
        # to another key turns an unknown/stale kid into an ambiguous trust
        # decision and differs from JOSE resolver behavior in the other SDKs.
        matching_keys = [
            key for key in keys
            if key.get("kid") == kid and key.get("kty") == "RSA"
        ]
        if len(matching_keys) == 1:
            matched = matching_keys[0]
        elif len(matching_keys) > 1:
            raise GrantexTokenError(
                f"JWKS contains multiple RSA keys with kid={kid!r}"
            )
    else:
        rsa_keys = [key for key in keys if key.get("kty") == "RSA"]
        if len(rsa_keys) == 1:
            matched = rsa_keys[0]
        elif len(rsa_keys) > 1:
            raise GrantexTokenError(
                "Grant token header is missing kid and JWKS contains multiple RSA keys"
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
    )
