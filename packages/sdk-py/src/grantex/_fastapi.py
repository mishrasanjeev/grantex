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

import asyncio
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Optional

if TYPE_CHECKING:
    from ._client import Grantex

from .manifest import EnforceResult

# Both integrations are optional dependencies; the typed Optional aliases keep
# ``mypy --strict`` happy whether or not fastapi/starlette are installed.
_Header: Optional[Callable[..., Any]]
try:
    from fastapi import Header as _fastapi_header  # type: ignore[import-not-found,unused-ignore]

    _Header = _fastapi_header
except ImportError:  # pragma: no cover - fastapi is an optional dependency
    _Header = None

# Without ``Header()`` FastAPI binds a plain ``str`` parameter to the query
# string, so the documented ``Authorization: Bearer <token>`` header was never
# read and every request 401'd. Outside FastAPI the plain default still works.
_AUTHORIZATION_DEFAULT: Any = _Header(default="") if _Header is not None else ""

_run_in_threadpool: Optional[Callable[..., Awaitable[Any]]]
try:
    from starlette.concurrency import (  # type: ignore[import-not-found,unused-ignore]
        run_in_threadpool as _starlette_run_in_threadpool,
    )

    _run_in_threadpool = _starlette_run_in_threadpool
except ImportError:  # pragma: no cover
    _run_in_threadpool = None


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
        authorization: str = _AUTHORIZATION_DEFAULT,
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

        # enforce() verifies the token synchronously (a JWKS fetch on a cache
        # miss); keep that off the event loop.
        result: EnforceResult
        if _run_in_threadpool is not None:
            result = await _run_in_threadpool(
                self._grantex.enforce,
                grant_token=token,
                connector=connector,
                tool=tool,
            )
        else:
            result = await asyncio.to_thread(
                self._grantex.enforce,
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
