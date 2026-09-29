"""Tests for grantex_strands — scope enforcement on Strands tools."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, call

import pytest

from conftest import TOKEN_WITH_SCOPES, TOKEN_WITH_READ, make_grant_token
from grantex_strands import create_grantex_tool, get_tool_scopes


def test_bound_online_profile_does_not_enforce_at_creation() -> None:
    client = MagicMock()
    client.enforce.return_value = SimpleNamespace(allowed=True, scopes=["data:read"], reason="")
    tool = create_grantex_tool(name="read", description="Synthetic read", grant_token=TOKEN_WITH_READ,
        required_scope="data:read", func=lambda: "ok", online=True, client=client, connector="data",
        audience="data-service", current_authority=MagicMock())
    client.enforce.assert_not_called()
    assert tool() == "ok"
    client.enforce.assert_called_once()


@pytest.mark.parametrize("allowed", ["false", "true", 1, None])
def test_online_refuses_non_boolean_allowed(allowed: object) -> None:
    client = MagicMock()
    client.enforce.return_value = SimpleNamespace(allowed=allowed, scopes=[], reason="invalid response")
    callback = MagicMock()
    with pytest.raises(PermissionError):
        create_grantex_tool(name="read", description="Synthetic read", grant_token=TOKEN_WITH_READ,
            required_scope="data:read", func=callback, online=True, client=client, connector="data")
    callback.assert_not_called()


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
    with pytest.raises(ValueError, match="Could not verify grant_token"):
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


# ─── Online mode forwards the audience ──────────────────────────────────────


def _online_client(allowed: bool = True, reason: str = "") -> Any:
    client = MagicMock()
    client.enforce.return_value = SimpleNamespace(allowed=allowed, reason=reason)
    return client


def test_online_mode_passes_the_audience_to_enforce() -> None:
    # enforce() checks the grant token audience; the tool's audience is the
    # one it expects, as in offline verification.
    client = _online_client()
    tool = create_grantex_tool(
        name="read_calendar",
        description="Read calendar events.",
        grant_token=TOKEN_WITH_READ,
        required_scope="tool:calendar:read",
        func=lambda: "events",
        client=client,
        connector="calendar",
        online=True,
        audience="https://api.merchant.example",
    )
    assert tool() == "events"
    assert client.enforce.call_args_list == [
        call(TOKEN_WITH_READ, "calendar", "read_calendar", audience="https://api.merchant.example"),
        call(TOKEN_WITH_READ, "calendar", "read_calendar", audience="https://api.merchant.example"),
    ]


def test_online_mode_without_an_audience_leaves_the_call_unchanged() -> None:
    client = _online_client()
    create_grantex_tool(
        name="read_calendar",
        description="Read calendar events.",
        grant_token=TOKEN_WITH_READ,
        required_scope="tool:calendar:read",
        func=lambda: "events",
        client=client,
        connector="calendar",
        online=True,
    )
    client.enforce.assert_called_once_with(TOKEN_WITH_READ, "calendar", "read_calendar")


def test_online_mode_reports_an_audience_denial() -> None:
    client = _online_client(
        allowed=False,
        reason="The grant token's audience does not include 'https://api.merchant.example'.",
    )
    with pytest.raises(PermissionError, match="audience does not include"):
        create_grantex_tool(
            name="read_calendar",
            description="Read calendar events.",
            grant_token=TOKEN_WITH_READ,
            required_scope="tool:calendar:read",
            func=lambda: "events",
            client=client,
            connector="calendar",
            online=True,
            audience="https://api.merchant.example",
        )
