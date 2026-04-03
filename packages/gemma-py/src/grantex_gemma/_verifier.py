"""Offline JWT verifier for Gemma on-device agents."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

import jwt as pyjwt
from jwt.algorithms import RSAAlgorithm

from ._errors import (
    OfflineVerificationError,
    ScopeViolationError,
    TokenExpiredError,
)
from ._scope_enforcer import enforce_scopes
from ._types import JWKSSnapshot, VerifiedGrant

logger = logging.getLogger("grantex_gemma")


class OfflineVerifier:
    """Verifies Grantex grant tokens offline using a JWKS snapshot."""

    def __init__(
        self,
        jwks_snapshot: JWKSSnapshot,
        clock_skew_seconds: int = 30,
        require_scopes: list[str] | None = None,
        max_delegation_depth: int | None = None,
        on_scope_violation: str = "throw",
    ) -> None:
        if on_scope_violation not in ("throw", "log"):
            raise ValueError(
                f"on_scope_violation must be 'throw' or 'log', "
                f"got '{on_scope_violation}'"
            )
        self._jwks_snapshot = jwks_snapshot
        self._clock_skew_seconds = clock_skew_seconds
        self._require_scopes = require_scopes
        self._max_delegation_depth = max_delegation_depth
        self._on_scope_violation = on_scope_violation
        self._keys = self._load_keys()

    def _load_keys(self) -> dict[str | None, Any]:
        """Pre-load RSA public keys from the JWKS snapshot."""
        keys: dict[str | None, Any] = {}
        for jwk in self._jwks_snapshot.keys:
            if jwk.get("kty") != "RSA":
                continue
            try:
                public_key = RSAAlgorithm.from_jwk(jwk)
                kid = jwk.get("kid")
                keys[kid] = public_key
            except Exception:
                # Skip malformed keys
                continue
        return keys

    async def verify(self, token: str) -> VerifiedGrant:
        """Verify a grant token and return the verified grant.

        Raises:
            OfflineVerificationError: If the token is invalid.
            TokenExpiredError: If the token has expired.
            ScopeViolationError: If required scopes are missing
                (when on_scope_violation="throw").
        """
        # Decode header first (unverified) to get kid and alg
        try:
            header = pyjwt.get_unverified_header(token)
        except pyjwt.PyJWTError as exc:
            raise OfflineVerificationError(
                f"Malformed JWT: {exc}"
            ) from exc

        # Reject dangerous algorithms
        alg = header.get("alg")
        if alg == "none":
            raise OfflineVerificationError(
                "Algorithm 'none' is not allowed"
            )
        if alg == "HS256":
            raise OfflineVerificationError(
                "Algorithm 'HS256' is not allowed; only RS256 is supported"
            )
        if alg != "RS256":
            raise OfflineVerificationError(
                f"Unsupported algorithm '{alg}'; only RS256 is allowed"
            )

        # Find the signing key
        if not self._keys:
            raise OfflineVerificationError(
                "No RSA keys available in JWKS snapshot"
            )

        kid = header.get("kid")
        signing_key = self._keys.get(kid)
        if signing_key is None and kid is not None:
            # Fallback to first available key
            signing_key = next(iter(self._keys.values()))
        if signing_key is None:
            signing_key = next(iter(self._keys.values()))

        # Decode and verify
        try:
            payload: dict[str, Any] = pyjwt.decode(
                token,
                signing_key,
                algorithms=["RS256"],
                options={
                    "verify_aud": False,
                    "verify_iat": False,
                },
                leeway=self._clock_skew_seconds,
            )
        except pyjwt.ExpiredSignatureError as exc:
            raise TokenExpiredError(
                "Grant token has expired"
            ) from exc
        except pyjwt.PyJWTError as exc:
            raise OfflineVerificationError(
                f"Token verification failed: {exc}"
            ) from exc

        # Validate required claims
        required_claims = ("jti", "sub", "agt", "scp", "exp")
        for claim in required_claims:
            if claim not in payload:
                raise OfflineVerificationError(
                    f"Token missing required claim: {claim}"
                )

        scopes: list[str] = payload["scp"]

        # Check required scopes
        if self._require_scopes:
            try:
                enforce_scopes(scopes, self._require_scopes)
            except ScopeViolationError:
                if self._on_scope_violation == "throw":
                    raise
                logger.warning(
                    "Scope violation (logged, not thrown): "
                    "grant scopes %s do not include required %s",
                    scopes,
                    self._require_scopes,
                )

        # Check delegation depth
        depth = payload.get("delegationDepth", 0)
        if isinstance(depth, str):
            depth = int(depth)
        if self._max_delegation_depth is not None:
            if depth > self._max_delegation_depth:
                raise OfflineVerificationError(
                    f"Delegation depth {depth} exceeds maximum "
                    f"{self._max_delegation_depth}"
                )

        # Build VerifiedGrant
        grant_id = payload.get("grnt", payload["jti"])
        exp_dt = datetime.fromtimestamp(payload["exp"], tz=timezone.utc)

        return VerifiedGrant(
            agent_did=str(payload["agt"]),
            principal_did=str(payload["sub"]),
            scopes=scopes,
            expires_at=exp_dt,
            jti=str(payload["jti"]),
            grant_id=str(grant_id),
            depth=int(depth),
        )


def create_offline_verifier(
    jwks_snapshot: JWKSSnapshot,
    clock_skew_seconds: int = 30,
    require_scopes: list[str] | None = None,
    max_delegation_depth: int | None = None,
    on_scope_violation: str = "throw",
) -> OfflineVerifier:
    """Create an offline JWT verifier for Gemma on-device use.

    Args:
        jwks_snapshot: Pre-fetched JWKS keys for offline verification.
        clock_skew_seconds: Allowable clock drift in seconds.
        require_scopes: Scopes that must be present on every token.
        max_delegation_depth: Maximum delegation depth allowed.
        on_scope_violation: "throw" to raise, "log" to warn.

    Returns:
        An OfflineVerifier instance.
    """
    return OfflineVerifier(
        jwks_snapshot=jwks_snapshot,
        clock_skew_seconds=clock_skew_seconds,
        require_scopes=require_scopes,
        max_delegation_depth=max_delegation_depth,
        on_scope_violation=on_scope_violation,
    )
