"""Tests for grantex_strands — scope enforcement on Strands tools."""

from __future__ import annotations

import pytest

from conftest import TOKEN_WITH_SCOPES, TOKEN_WITH_READ, make_grant_token
from grantex_strands import create_grantex_tool, get_tool_scopes


# ─── Tool creation and scope enforcement ─────────────────────────────────────


def test_create_tool_returns_strands_tool_instance() -> None:
    tool = create_grantex_tool(
        name="my_tool",
        description="Does something.",
        grant_token=TOKEN_WITH_READ,
        required_scope="data:read",
        func=lambda: "ok",
    )
    # Should be callable (Strands tools are callable)
    assert callable(tool)
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
            name="bad_tool",
            description="Bad token.",
            grant_token="not.a.valid-jwt-payload",
            required_scope="data:read",
            func=lambda: "ok",
        )


def test_tool_run_delegates_to_func() -> None:
    calls: list[dict[str, str]] = []

    def my_func(url: str = "") -> str:
        calls.append({"url": url})
        return f"fetched:{url}"

    tool = create_grantex_tool(
        name="fetch",
        description="Fetch a URL.",
        grant_token=TOKEN_WITH_SCOPES,
        required_scope="data:read",
        func=my_func,
    )

    result = tool(url="https://example.com")
    assert result == "fetched:https://example.com"
    assert calls == [{"url": "https://example.com"}]


def test_write_scope_allows_write_tool() -> None:
    tool = create_grantex_tool(
        name="write_tool",
        description="Writes data.",
        grant_token=TOKEN_WITH_SCOPES,  # has data:write
        required_scope="data:write",
        func=lambda: "written",
    )
    assert tool() == "written"


def test_read_scope_denies_write_tool() -> None:
    with pytest.raises(PermissionError, match="missing required scope 'data:write'"):
        create_grantex_tool(
            name="write_tool",
            description="Writes data.",
            grant_token=TOKEN_WITH_READ,  # only has data:read
            required_scope="data:write",
            func=lambda: "written",
        )


# ─── get_tool_scopes ─────────────────────────────────────────────────────────


def test_get_tool_scopes_returns_scp_list() -> None:
    scopes = get_tool_scopes(TOKEN_WITH_SCOPES)
    assert scopes == ["data:read", "data:write"]


def test_get_tool_scopes_empty_token() -> None:
    token = make_grant_token([])
    scopes = get_tool_scopes(token)
    assert scopes == []


def test_get_tool_scopes_invalid_token() -> None:
    scopes = get_tool_scopes("garbage")
    assert scopes == []
