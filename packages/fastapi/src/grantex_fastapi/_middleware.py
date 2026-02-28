"""FastAPI dependency-injection helpers for Grantex grant token verification."""

from typing import Any, Callable, Optional

from fastapi import Depends, Request
from fastapi.responses import JSONResponse
from grantex import GrantexTokenError, VerifiedGrant, VerifyGrantTokenOptions, verify_grant_token

from ._errors import ErrorCode, GrantexFastAPIError


def _extract_bearer_token(request: Request) -> Optional[str]:
    """Extract a Bearer token from the Authorization header."""
    header = request.headers.get("authorization")
    if not header:
        return None
    parts = header.split(" ", 1)
    if len(parts) != 2 or parts[0] != "Bearer":
        return None
    return parts[1]


class GrantexAuth:
    """Factory that produces FastAPI dependencies for Grantex token verification.

    Usage::

        from grantex_fastapi import GrantexAuth

        grantex = GrantexAuth(
            jwks_uri="https://grantex-auth-dd4mtrt2gq-uc.a.run.app/.well-known/jwks.json",
        )

        @app.get("/api/calendar")
        async def calendar(grant: VerifiedGrant = Depends(grantex)):
            return {"principalId": grant.principal_id, "scopes": grant.scopes}

    The instance is callable, so you can use ``Depends(grantex)`` directly.
    It can also produce scope-checking sub-dependencies via
    ``Depends(grantex.scopes("calendar:read"))``.
    """

    def __init__(
        self,
        jwks_uri: str,
        *,
        clock_tolerance: int = 0,
        audience: Optional[str] = None,
        token_extractor: Optional[Callable[[Request], Optional[str]]] = None,
    ) -> None:
        self._jwks_uri = jwks_uri
        self._clock_tolerance = clock_tolerance
        self._audience = audience
        self._token_extractor = token_extractor

    async def __call__(self, request: Request) -> VerifiedGrant:
        """FastAPI dependency that verifies the grant token and returns a VerifiedGrant."""
        return self._verify(request)

    def _verify(self, request: Request) -> VerifiedGrant:
        """Core verification logic shared by __call__ and scopes()."""
        if self._token_extractor is not None:
            token = self._token_extractor(request)
        else:
            token = _extract_bearer_token(request)

        if not token:
            raise GrantexFastAPIError(
                "TOKEN_MISSING",
                'No grant token found. Send a Grantex JWT in the Authorization header as "Bearer <token>".',
                401,
            )

        opts = VerifyGrantTokenOptions(
            jwks_uri=self._jwks_uri,
            clock_tolerance=self._clock_tolerance,
            audience=self._audience,
        )

        try:
            return verify_grant_token(token, opts)
        except GrantexTokenError as exc:
            msg = str(exc)
            is_expired = "exp" in msg.lower()
            code: ErrorCode = "TOKEN_EXPIRED" if is_expired else "TOKEN_INVALID"
            raise GrantexFastAPIError(code, msg, 401) from exc

    def scopes(self, *required_scopes: str) -> Callable[..., Any]:
        """Return a dependency that verifies the token AND checks scopes.

        Usage::

            @app.get("/api/calendar")
            async def calendar(grant: VerifiedGrant = Depends(grantex.scopes("calendar:read"))):
                ...

            # Multiple scopes — all required
            @app.post("/api/email/send")
            async def send(grant: VerifiedGrant = Depends(grantex.scopes("email:read", "email:send"))):
                ...
        """
        parent = self

        async def _dependency(request: Request) -> VerifiedGrant:
            grant = parent._verify(request)
            missing = [s for s in required_scopes if s not in grant.scopes]
            if missing:
                raise GrantexFastAPIError(
                    "SCOPE_INSUFFICIENT",
                    f"Grant token is missing required scopes: {', '.join(missing)}",
                    403,
                )
            return grant

        return _dependency


def require_scopes(grant: VerifiedGrant, *scopes: str) -> None:
    """Standalone scope check — call inside a route handler.

    Usage::

        @app.get("/api/data")
        async def data(grant: VerifiedGrant = Depends(grantex)):
            require_scopes(grant, "data:read")
            ...
    """
    missing = [s for s in scopes if s not in grant.scopes]
    if missing:
        raise GrantexFastAPIError(
            "SCOPE_INSUFFICIENT",
            f"Grant token is missing required scopes: {', '.join(missing)}",
            403,
        )


def grantex_exception_handler(request: Request, exc: GrantexFastAPIError) -> JSONResponse:
    """Default exception handler for GrantexFastAPIError.

    Register with::

        app.add_exception_handler(GrantexFastAPIError, grantex_exception_handler)
    """
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": exc.code, "message": str(exc)},
    )
