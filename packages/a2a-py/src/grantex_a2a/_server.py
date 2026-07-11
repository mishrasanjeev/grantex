"""A2A server middleware for validating incoming Grantex grant tokens."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Callable, Dict

from grantex import GrantexTokenError, VerifyGrantTokenOptions, verify_grant_token
from ._types import A2AAuthMiddlewareOptions, VerifiedGrant


class A2AAuthError(Exception):
    """Error raised when A2A authentication fails."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code


def create_a2a_auth_middleware(
    options: A2AAuthMiddlewareOptions,
) -> Callable[[Dict[str, str]], VerifiedGrant]:
    """Create middleware that validates Grantex grant tokens.

    Returns a callable that takes a request headers dict and returns
    a VerifiedGrant, or raises A2AAuthError.

    Usage with FastAPI::

        middleware = create_a2a_auth_middleware(
            A2AAuthMiddlewareOptions(jwks_uri="https://api.grantex.dev/.well-known/jwks.json")
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
            grant = verify_grant_token(
                token,
                VerifyGrantTokenOptions(
                    jwks_uri=options.jwks_uri,
                    issuer=options.issuer,
                    issuer_did=options.issuer_did,
                    audience=options.audience,
                    clock_tolerance=options.clock_tolerance,
                    required_scopes=required_scopes,
                ),
            )
        except GrantexTokenError as exc:
            if "missing required scopes" in str(exc).lower():
                raise A2AAuthError(403, str(exc)) from exc
            raise A2AAuthError(401, f"Grant token verification failed: {exc}") from exc

        expires_at = datetime.fromtimestamp(
            grant.expires_at,
            tz=timezone.utc,
        ).isoformat()

        return VerifiedGrant(
            grant_id=grant.grant_id,
            agent_did=grant.agent_did,
            principal_id=grant.principal_id,
            developer_id=grant.developer_id,
            scopes=list(grant.scopes),
            expires_at=expires_at,
            delegation_depth=grant.delegation_depth,
        )

    return validate
