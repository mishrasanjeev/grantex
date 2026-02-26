from __future__ import annotations

import pytest

from grantex_crewai import create_grantex_tool, get_tool_scopes
from .conftest import make_grant_token


TOKEN_WITH_READ = make_grant_token(["data:read", "data:write"])
TOKEN_EMPTY = make_grant_token([])


# ─── create_grantex_tool ──────────────────────────────────────────────────────

def test_create_tool_returns_base_tool_instance() -> None:
    tool = create_grantex_tool(
        name="my_tool",
        description="Does something.",
        grant_token=TOKEN_WITH_READ,
        required_scope="data:read",
        func=lambda: "ok",
    )
    # Should be an instance of our stubbed BaseTool
    from crewai.tools import BaseTool  # type: ignore[import-untyped]
    assert isinstance(tool, BaseTool)
    assert tool.name == "my_tool"
    assert tool.description == "Does something."


def test_create_tool_raises_permission_error_for_missing_scope() -> None:
    with pytest.raises(PermissionError, match="missing required scope 'admin:all'"):
        create_grantex_tool(
            name="admin_tool",
            description="Admin action.",
            grant_token=TOKEN_WITH_READ,
            required_scope="admin:all",
            func=lambda: "ok",
        )


def test_create_tool_raises_for_invalid_jwt() -> None:
    with pytest.raises(ValueError, match="Could not decode grant_token"):
        create_grantex_tool(
            name="t",
            description="d",
            grant_token="not.a.valid.jwt.at.all",
            required_scope="data:read",
            func=lambda: "ok",
        )


def test_tool_run_delegates_to_func() -> None:
    calls: list[dict[str, str]] = []

    def my_func(url: str) -> str:
        calls.append({"url": url})
        return f"fetched:{url}"

    tool = create_grantex_tool(
        name="fetch",
        description="Fetch a URL.",
        grant_token=TOKEN_WITH_READ,
        required_scope="data:read",
        func=my_func,
    )

    result = tool._run(url="https://example.com")
    assert result == "fetched:https://example.com"
    assert calls == [{"url": "https://example.com"}]


def test_get_tool_scopes_returns_scp_list() -> None:
    scopes = get_tool_scopes(TOKEN_WITH_READ)
    assert scopes == ["data:read", "data:write"]


def test_get_tool_scopes_empty_token() -> None:
    scopes = get_tool_scopes(TOKEN_EMPTY)
    assert scopes == []
