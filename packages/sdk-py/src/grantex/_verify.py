from __future__ import annotations

import hmac
import json
import threading
import time
import warnings
from dataclasses import dataclass
from typing import Any, Callable, Mapping, TypeVar

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

GRANT_CLAIM = "urn:grantex:grant"
"""Claim holding Grantex's grant record fields (spec/grant-token-0.6.md)."""

LEGACY_CLAIM_ALIASES: Mapping[str, str] = {
    "agt": f"{GRANT_CLAIM}.agent_did",
    "dev": f"{GRANT_CLAIM}.developer_id",
    "grnt": f"{GRANT_CLAIM}.grant_id",
    "scp": "scope",
    "parentAgt": "act.sub",
    "parentGrnt": f"{GRANT_CLAIM}.parent_grant_id",
    "delegationDepth": f"{GRANT_CLAIM}.delegation_depth",
}
"""Legacy claim aliases and the standard claims that replace them."""

_MAX_ACTOR_CHAIN_DEPTH = 10

_T = TypeVar("_T")


class LegacyClaimsWarning(FutureWarning):
    """A grant token was read through a legacy claim alias.

    Reading aliases is deprecated in 0.6 and off by default from 0.7.
    """


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
    if not options.legacy_claims and header.get("typ") != "at+jwt":
        raise GrantexTokenError(
            f"Grant token typ must be at+jwt, got {header.get('typ')!r}"
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

    payload = _build_payload(payload_data, legacy_claims=options.legacy_claims)
    _check_proof_of_possession(payload, options)
    for alias in payload.legacy_claims_used:
        warnings.warn(
            f"Grant token claim {alias!r} is a legacy alias of "
            f"{LEGACY_CLAIM_ALIASES[alias]}. Reading legacy claim aliases is "
            "deprecated and stops by default in 0.7; see docs/migration-0.6.md.",
            LegacyClaimsWarning,
            stacklevel=2,
        )

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


def _check_proof_of_possession(payload: GrantTokenPayload, options: VerifyGrantTokenOptions) -> None:
    if options.require_proof_of_possession and options.proof_jkt is None:
        raise GrantexTokenError(
            "Proof of possession is required but no proof key thumbprint (proof_jkt) was given"
        )
    if options.proof_jkt is None:
        return
    jkt = payload.cnf.get("jkt") if isinstance(payload.cnf, Mapping) else None
    if not isinstance(jkt, str):
        raise GrantexTokenError("Grant token is not key-bound (no cnf.jkt) but proof of possession is required")
    if not hmac.compare_digest(jkt.encode(), options.proof_jkt.encode()):
        raise GrantexTokenError("Grant token cnf.jkt does not match the proof key")


def _reject_null(record: Mapping[str, Any], name: str, label: str) -> None:
    if name in record and record[name] is None:
        raise GrantexTokenError(f"Grant token claim {label} must not be null")


def _string_claim(record: Mapping[str, Any], name: str, label: str) -> str | None:
    _reject_null(record, name, label)
    value = record.get(name)
    if value is None:
        return None
    if not isinstance(value, str) or not value:
        raise GrantexTokenError(f"Grant token claim {label} must be a non-empty string")
    return value


def _depth_claim(record: Mapping[str, Any], name: str, label: str) -> int | None:
    _reject_null(record, name, label)
    value = record.get(name)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise GrantexTokenError(f"Grant token claim {label} must be a non-negative integer")
    return int(value)


def _parse_actor(value: Any) -> Mapping[str, Any]:
    current = value
    depth = 1
    while True:
        if not isinstance(current, Mapping) or not isinstance(current.get("sub"), str) or not current["sub"]:
            raise GrantexTokenError(
                "Grant token act claim must be an object with a non-empty string sub"
            )
        if "act" not in current:
            break
        if depth >= _MAX_ACTOR_CHAIN_DEPTH:
            raise GrantexTokenError(
                f"Grant token act chain is deeper than {_MAX_ACTOR_CHAIN_DEPTH}"
            )
        current = current["act"]
        depth += 1
    return value  # type: ignore[no-any-return]


def _build_payload(data: dict[str, Any], *, legacy_claims: bool = True) -> GrantTokenPayload:
    """Read grant claims: standard claims first, legacy aliases where the
    standard claim is absent (unless ``legacy_claims`` is false). A standard
    claim and an alias that disagree raise :class:`GrantexTokenError`. A claim
    that is present with a null value is refused, never treated as absent."""
    used: list[str] = []
    for name in (GRANT_CLAIM, "scope", "scp", "act", "cnf", "client_id", "aud", "authorization_details"):
        _reject_null(data, name, name)

    def read(alias: str, standard: _T | None, legacy: Callable[[], _T | None]) -> _T | None:
        if not legacy_claims:
            return standard
        alias_value = legacy()
        if (
            standard is not None
            and alias_value is not None
            and json.dumps(standard) != json.dumps(alias_value)
        ):
            raise GrantexTokenError(
                f"Grant token claim {LEGACY_CLAIM_ALIASES[alias]} disagrees with "
                f"its legacy alias {alias}"
            )
        if standard is None and alias_value is not None:
            used.append(alias)
        return standard if standard is not None else alias_value

    raw_grant = data.get(GRANT_CLAIM)
    if raw_grant is not None and not isinstance(raw_grant, Mapping):
        raise GrantexTokenError(f"Grant token claim {GRANT_CLAIM} must be an object")
    grant: Mapping[str, Any] = raw_grant or {}

    raw_scope = data.get("scope")
    if raw_scope is not None and not isinstance(raw_scope, str):
        raise GrantexTokenError("Grant token claim scope must be a space-delimited string")
    standard_scopes = (
        [s for s in raw_scope.split(" ") if s] if raw_scope is not None else None
    )

    def legacy_scopes() -> list[str] | None:
        scp = data.get("scp")
        if scp is None:
            return None
        if not isinstance(scp, (list, tuple)) or not all(isinstance(s, str) for s in scp):
            raise GrantexTokenError("Grant token claim scp must be an array of strings")
        return list(scp)

    if legacy_claims and GRANT_CLAIM not in data and "scp" in data:
        # A pre-0.6 token: scope, when present, is a lossy join of scp.
        scopes: list[str] | None = legacy_scopes()
        used.append("scp")
    else:
        scopes = read("scp", standard_scopes, legacy_scopes)
    agent_did = read(
        "agt",
        _string_claim(grant, "agent_did", f"{GRANT_CLAIM}.agent_did"),
        lambda: _string_claim(data, "agt", "agt"),
    )
    developer_id = read(
        "dev",
        _string_claim(grant, "developer_id", f"{GRANT_CLAIM}.developer_id"),
        lambda: _string_claim(data, "dev", "dev"),
    )
    grant_id = read(
        "grnt",
        _string_claim(grant, "grant_id", f"{GRANT_CLAIM}.grant_id"),
        lambda: _string_claim(data, "grnt", "grnt"),
    )
    parent_grant_id = read(
        "parentGrnt",
        _string_claim(grant, "parent_grant_id", f"{GRANT_CLAIM}.parent_grant_id"),
        lambda: _string_claim(data, "parentGrnt", "parentGrnt"),
    )
    delegation_depth = read(
        "delegationDepth",
        _depth_claim(grant, "delegation_depth", f"{GRANT_CLAIM}.delegation_depth"),
        lambda: _depth_claim(data, "delegationDepth", "delegationDepth"),
    )
    act = _parse_actor(data["act"]) if "act" in data else None
    standard_parent = (
        act.get("sub")
        if act is not None and (parent_grant_id is not None or delegation_depth is not None)
        else None
    )
    parent_agent_did = read(
        "parentAgt", standard_parent, lambda: _string_claim(data, "parentAgt", "parentAgt")
    )

    jti, sub, iat, exp = data.get("jti"), data.get("sub"), data.get("iat"), data.get("exp")
    if (
        not isinstance(jti, str)
        or not isinstance(sub, str)
        or isinstance(iat, bool) or not isinstance(iat, (int, float))
        or isinstance(exp, bool) or not isinstance(exp, (int, float))
        or scopes is None
        or agent_did is None
        or developer_id is None
    ):
        required = (
            "jti, sub, iat, exp, scope or scp, agent_did or agt, developer_id or dev"
            if legacy_claims
            else f"jti, sub, iat, exp, scope, {GRANT_CLAIM}.agent_did, {GRANT_CLAIM}.developer_id"
        )
        raise GrantexTokenError(f"Grant token is missing required claims ({required})")
    cnf = data.get("cnf")
    if cnf is not None and not isinstance(cnf, Mapping):
        raise GrantexTokenError("Grant token claim cnf must be an object")
    client_id = data.get("client_id")
    if client_id is not None and (not isinstance(client_id, str) or not client_id):
        raise GrantexTokenError("Grant token claim client_id must be a non-empty string")
    aud = data.get("aud")
    if aud is not None and not isinstance(aud, str) and not (
        isinstance(aud, list) and all(isinstance(a, str) for a in aud)
    ):
        raise GrantexTokenError("Grant token claim aud must be a string or an array of strings")

    return GrantTokenPayload(
        iss=str(data.get("iss", "")),
        sub=sub,
        agt=agent_did,
        dev=developer_id,
        scp=tuple(scopes),
        iat=int(iat),
        exp=int(exp),
        jti=jti,
        client_id=client_id,
        grnt=grant_id,
        parent_agt=parent_agent_did,
        parent_grnt=parent_grant_id,
        delegation_depth=delegation_depth,
        authorization_details=data.get("authorization_details"),
        act=act,
        cnf=cnf,
        aud=aud,
        legacy_claims_used=tuple(used),
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
        act=payload.act,
        cnf=payload.cnf,
        audience=payload.aud,
        legacy_claims_used=payload.legacy_claims_used,
    )
