from __future__ import annotations

from typing import Any, Callable, Optional, Type

from ._jwt import decode_jwt_payload


def create_grantex_tool(
    *,
    name: str,
    description: str,
    grant_token: str,
    required_scope: str,
    func: Callable[..., str],
    args_schema: Optional[Any] = None,
) -> Any:
    """Create a CrewAI-compatible tool with Grantex scope enforcement.

    The tool performs an **offline** scope check against the JWT ``scp``
    claim before invoking ``func``.  Pass ``args_schema`` as a Pydantic
    ``BaseModel`` subclass to describe the tool's input; if omitted a
    schema-less tool is created.

    Example::

        from pydantic import BaseModel

        class FetchParams(BaseModel):
            url: str

        tool = create_grantex_tool(
            name="fetch_data",
            description="Fetches data from the given URL.",
            grant_token=token,
            required_scope="data:read",
            func=lambda url: requests.get(url).text,
            args_schema=FetchParams,
        )

    Raises:
        PermissionError: if the grant token does not contain the required scope.
        ImportError: if ``crewai`` is not installed.
    """
    # Lazy import so the package can be imported without crewai installed
    # (useful for testing and environments that only need the type stubs).
    from crewai.tools import BaseTool  # type: ignore[import-not-found]
    from pydantic import BaseModel

    # Offline scope check
    try:
        payload = decode_jwt_payload(grant_token)
    except Exception as exc:
        raise ValueError(f"Could not decode grant_token: {exc}") from exc

    scopes: list[str] = payload.get("scp", [])
    if required_scope not in scopes:
        raise PermissionError(
            f"Grant token is missing required scope '{required_scope}'. "
            f"Granted scopes: {scopes}"
        )

    # Determine the schema to attach
    effective_schema: Type[BaseModel]
    if args_schema is not None:
        effective_schema = args_schema
    else:
        # Minimal schema that accepts any keyword arguments
        class _EmptySchema(BaseModel):
            pass

        effective_schema = _EmptySchema

    # Capture locals for the dynamic class
    _func = func
    _schema = effective_schema
    _name = name
    _description = description

    class _GrantexTool(BaseTool):  # type: ignore[misc]
        name: str = _name
        description: str = _description
        args_schema: Type[BaseModel] = _schema

        def _run(self, **kwargs: Any) -> str:
            return _func(**kwargs)

    return _GrantexTool()


def get_tool_scopes(grant_token: str) -> list[str]:
    """Return the scopes embedded in a grant token (offline, no network call)."""
    payload = decode_jwt_payload(grant_token)
    scopes: list[str] = payload.get("scp", [])
    return scopes
