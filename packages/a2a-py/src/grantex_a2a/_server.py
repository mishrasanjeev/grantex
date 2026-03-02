"""A2A server middleware for validating incoming Grantex grant tokens."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from ._jwt import decode_jwt_payload, is_token_expired
from ._types import A2AAuthMiddlewareOptions, VerifiedGrant


class A2AAuthError(Exception):
    """Error raised when A2A authentication fails."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code


def create_a2a_auth_middleware(
    options: A2AAuthMiddlewareOptions,
):
    """Create middleware that validates Grantex grant tokens.

    Returns a callable that takes a request headers dict and returns
    a VerifiedGrant, or raises A2AAuthError.

    Usage with FastAPI::

        middleware = create_a2a_auth_middleware(
            A2AAuthMiddlewareOptions(jwks_uri="https://grantex.dev/.well-known/jwks.json")
        )

        @app.post("/a2a")
        async def handle_a2a(request: Request):
            grant = middleware(dict(request.headers))
            # grant.scopes, grant.principal_id, etc.
    """
    required_scopes = options.required_scopes

    def validate(headers: Dict[str, str]) -> VerifiedGrant:
        auth_header = headers.get("authorization") or headers.get("Authorization")
        if not auth_header or not auth_header.startswith("Bearer "):
            raise A2AAuthError(401, "Missing or invalid Authorization header")

        token = auth_header[7:]

        try:
            payload = decode_jwt_payload(token)
        except (ValueError, Exception):
            raise A2AAuthError(401, "Invalid grant token format")

        if is_token_expired(payload):
            raise A2AAuthError(401, "Grant token expired")

        # Validate required scopes
        if required_scopes:
            token_scopes = set(payload.get("scp", []))
            missing = [s for s in required_scopes if s not in token_scopes]
            if missing:
                raise A2AAuthError(
                    403, f"Missing required scopes: {', '.join(missing)}"
                )

        exp = payload.get("exp")
        expires_at = ""
        if exp is not None:
            expires_at = datetime.fromtimestamp(exp, tz=timezone.utc).isoformat()

        return VerifiedGrant(
            grant_id=payload.get("grnt") or payload.get("jti", ""),
            agent_did=payload.get("agt", ""),
            principal_id=payload.get("sub", ""),
            developer_id=payload.get("dev", ""),
            scopes=payload.get("scp", []),
            expires_at=expires_at,
            delegation_depth=payload.get("delegationDepth"),
        )

    return validate
