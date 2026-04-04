"""FastAPI dependency for Grantex scope enforcement.

Usage::

    from grantex import Grantex
    from grantex.fastapi import GrantexEnforcer

    grantex = Grantex(api_key=os.environ["GRANTEX_API_KEY"])
    enforcer = GrantexEnforcer(grantex)

    @app.post("/api/tools/{connector}/{tool}")
    async def execute_tool(
        connector: str,
        tool: str,
        auth: EnforceResult = Depends(enforcer),
    ):
        # auth.allowed is guaranteed True here (raises 403 otherwise)
        ...
"""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ._client import Grantex

from .manifest import EnforceResult


class GrantexEnforcer:
    """FastAPI dependency that enforces Grantex scopes on every request.

    Extracts the Bearer token from the Authorization header, connector
    and tool from path parameters, and calls ``grantex.enforce()``.
    Raises HTTPException(403) if denied.
    """

    def __init__(self, grantex: "Grantex") -> None:
        self._grantex = grantex

    async def __call__(
        self,
        connector: str = "",
        tool: str = "",
        authorization: str = "",
    ) -> EnforceResult:
        """FastAPI dependency callable."""
        # Extract token from Authorization header
        token = ""
        if authorization.startswith("Bearer "):
            token = authorization[7:]

        if not token:
            try:
                from fastapi import HTTPException  # type: ignore[import-not-found,unused-ignore]
                raise HTTPException(status_code=401, detail="Missing grant token")
            except ImportError:
                raise PermissionError("Missing grant token")

        result = self._grantex.enforce(
            grant_token=token,
            connector=connector,
            tool=tool,
        )

        if not result.allowed:
            try:
                from fastapi import HTTPException  # type: ignore[import-not-found,unused-ignore]
                raise HTTPException(
                    status_code=403,
                    detail={"code": "SCOPE_DENIED", "message": result.reason, "connector": connector, "tool": tool},
                )
            except ImportError:
                raise PermissionError(f"Scope denied: {result.reason}")

        return result
