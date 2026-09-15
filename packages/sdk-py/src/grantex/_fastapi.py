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

Decision grants (``spec/decision-grant.md``): for a tool that requires a
decision, the enforcer reads the grant(s) from the ``Grantex-Decision-Grant``
header (comma-separated for four eyes) and the tool arguments from the JSON
request body, and asks ``case_version`` for the case's current version from
your own case state::

    enforcer = GrantexEnforcer(
        grantex,
        case_version=lambda request, arguments: cases.version(arguments["case_id"]),
    )

``enforce()`` consumes the grants at the auth service before the route runs;
a consumed grant stays spent if the route then fails.
"""
from __future__ import annotations

import asyncio
import inspect
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Mapping, Optional, Sequence, Union

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

_Request: Any
try:
    from starlette.requests import Request as _starlette_request  # type: ignore[import-not-found,unused-ignore]

    _Request = _starlette_request
except ImportError:  # pragma: no cover - starlette comes with fastapi
    _Request = None

DECISION_GRANT_HEADER = "grantex-decision-grant"
"""Request header carrying the decision grant(s), comma-separated."""

MaybeAwaitable = Union[Any, Awaitable[Any]]

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

    When the request carries decision grants they are passed to
    ``enforce()`` with the call's arguments and the case version:

    - ``decision_grants(request)``: the grant tokens. Default: the
      ``Grantex-Decision-Grant`` header, split on commas.
    - ``arguments(request)``: the tool arguments the decision must match.
      Default: the JSON request body when it is an object.
    - ``case_version(request, arguments)``: the case's current version from
      the server's own case state, never from the caller. No default: without
      it a decision tool is refused (``malformed``).

    Each may be a plain or an async function.
    """

    def __init__(
        self,
        grantex: "Grantex",
        *,
        decision_grants: Optional[Callable[[Any], MaybeAwaitable]] = None,
        arguments: Optional[Callable[[Any], MaybeAwaitable]] = None,
        case_version: Optional[Callable[[Any, Optional[Mapping[str, Any]]], MaybeAwaitable]] = None,
    ) -> None:
        self._grantex = grantex
        self._decision_grants = decision_grants or _header_decision_grants
        self._arguments = arguments or _json_body_arguments
        self._case_version = case_version

    async def __call__(
        self,
        connector: str = "",
        tool: str = "",
        authorization: str = _AUTHORIZATION_DEFAULT,
        request: _Request = None,  # type: ignore[valid-type,unused-ignore]
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

        decision: dict[str, Any] = {}
        if request is not None:
            grants = await _resolve(self._decision_grants(request))
            if grants:
                if isinstance(grants, str) or not all(isinstance(g, str) for g in grants):
                    raise TypeError("decision_grants must return a sequence of token strings")
                call_arguments = await _resolve(self._arguments(request))
                version = (
                    await _resolve(self._case_version(request, call_arguments))
                    if self._case_version is not None
                    else None
                )
                decision["decision_grants"] = list(grants)
                if call_arguments is not None:
                    decision["arguments"] = call_arguments
                if version is not None:
                    decision["case_version"] = version

        # enforce() verifies the token synchronously (a JWKS fetch on a cache
        # miss) and consumes decision grants over HTTP; keep that off the
        # event loop.
        result: EnforceResult
        if _run_in_threadpool is not None:
            result = await _run_in_threadpool(
                self._grantex.enforce,
                grant_token=token,
                connector=connector,
                tool=tool,
                **decision,
            )
        else:
            result = await asyncio.to_thread(
                self._grantex.enforce,
                grant_token=token,
                connector=connector,
                tool=tool,
                **decision,
            )

        if not result.allowed:
            try:
                from fastapi import HTTPException  # type: ignore[import-not-found,unused-ignore]
                raise HTTPException(
                    status_code=403,
                    detail={
                        "code": "SCOPE_DENIED", "message": result.reason, "connector": connector, "tool": tool,
                        "reason_code": result.reason_code, "sub_reason": result.sub_reason,
                    },
                )
            except ImportError:
                raise PermissionError(f"Scope denied: {result.reason}")

        return result


async def _resolve(value: MaybeAwaitable) -> Any:
    return await value if inspect.isawaitable(value) else value


def _header_decision_grants(request: Any) -> Sequence[str]:
    raw = request.headers.get(DECISION_GRANT_HEADER)
    if not raw:
        return []
    return [token.strip() for token in str(raw).split(",") if token.strip()]


async def _json_body_arguments(request: Any) -> Optional[Mapping[str, Any]]:
    try:
        body = await request.json()
    except Exception:
        return None
    return body if isinstance(body, Mapping) else None
