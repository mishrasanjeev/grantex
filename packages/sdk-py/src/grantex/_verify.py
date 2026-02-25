from __future__ import annotations

from typing import Any

import httpx
import jwt
from jwt.algorithms import RSAAlgorithm

from ._errors import GrantexTokenError
from ._types import GrantTokenPayload, VerifiedGrant, VerifyGrantTokenOptions


def verify_grant_token(
    token: str,
    options: VerifyGrantTokenOptions,
) -> VerifiedGrant:
    """Verify a Grantex grant token offline using the published JWKS.

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

    signing_key = _fetch_signing_key(options.jwks_uri, header.get("kid"))

    try:
        payload_data: dict[str, Any] = jwt.decode(
            token,
            signing_key,
            algorithms=["RS256"],
            leeway=options.clock_tolerance,
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


def _map_online_verify_to_verified_grant(token: str) -> VerifiedGrant:
    """Decode a grant token without re-verifying the signature.

    Used by GrantsClient.verify() after the server has already validated.
    """
    try:
        payload_data: dict[str, Any] = jwt.decode(
            token,
            options={"verify_signature": False},
            algorithms=["RS256"],
        )
    except jwt.PyJWTError as exc:
        raise GrantexTokenError(
            f"Failed to decode grant token: {exc}"
        ) from exc

    return _payload_to_verified_grant(_build_payload(payload_data))


def _fetch_signing_key(jwks_uri: str, kid: str | None) -> Any:
    """Fetch the JWKS and return the matching RSA public key."""
    try:
        resp = httpx.get(jwks_uri, timeout=10.0)
        resp.raise_for_status()
        jwks: dict[str, Any] = resp.json()
    except Exception as exc:
        raise GrantexTokenError(
            f"Failed to fetch JWKS from {jwks_uri}: {exc}"
        ) from exc

    keys: list[dict[str, Any]] = jwks.get("keys", [])
    if not keys:
        raise GrantexTokenError("JWKS contains no keys")

    matched: dict[str, Any] | None = None
    if kid:
        for k in keys:
            if k.get("kid") == kid:
                matched = k
                break

    if matched is None:
        # Fallback: first RSA key
        for k in keys:
            if k.get("kty") == "RSA":
                matched = k
                break

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


def _build_payload(data: dict[str, Any]) -> GrantTokenPayload:
    required = ("jti", "sub", "agt", "dev", "scp", "iat", "exp")
    for field in required:
        if field not in data:
            raise GrantexTokenError(
                f"Grant token is missing required claims ({', '.join(required)})"
            )
    return GrantTokenPayload(
        iss=data.get("iss", ""),
        sub=str(data["sub"]),
        agt=str(data["agt"]),
        dev=str(data["dev"]),
        scp=tuple(data["scp"]),
        iat=int(data["iat"]),
        exp=int(data["exp"]),
        jti=str(data["jti"]),
        gid=data.get("gid"),
    )


def _payload_to_verified_grant(payload: GrantTokenPayload) -> VerifiedGrant:
    return VerifiedGrant(
        token_id=payload.jti,
        grant_id=payload.gid if payload.gid is not None else payload.jti,
        principal_id=payload.sub,
        agent_did=payload.agt,
        developer_id=payload.dev,
        scopes=payload.scp,
        issued_at=payload.iat,
        expires_at=payload.exp,
    )
