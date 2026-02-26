from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from grantex_crewai import create_grantex_tool, with_audit_logging
from .conftest import make_grant_token


TOKEN = make_grant_token(["data:read"])


def _make_tool(func: object) -> object:
    return create_grantex_tool(
        name="test_tool",
        description="A test tool.",
        grant_token=TOKEN,
        required_scope="data:read",
        func=func,  # type: ignore[arg-type]
    )


# ─── with_audit_logging ───────────────────────────────────────────────────────

def test_audit_logs_success(mock_grantex: MagicMock) -> None:
    tool = _make_tool(lambda item: f"processed:{item}")
    tool = with_audit_logging(
        tool, mock_grantex, agent_id="ag_01", grant_id="grnt_01"
    )

    result = tool._run(item="widget")

    assert result == "processed:widget"
    mock_grantex.audit.log.assert_called_once_with(
        agent_id="ag_01",
        grant_id="grnt_01",
        action="tool.run:test_tool",
        metadata={"kwargs": {"item": "widget"}},
        status="success",
    )


def test_audit_logs_failure_and_reraises(mock_grantex: MagicMock) -> None:
    def boom(item: str) -> str:
        raise RuntimeError("something went wrong")

    tool = _make_tool(boom)
    tool = with_audit_logging(
        tool, mock_grantex, agent_id="ag_01", grant_id="grnt_01"
    )

    with pytest.raises(RuntimeError, match="something went wrong"):
        tool._run(item="widget")

    mock_grantex.audit.log.assert_called_once_with(
        agent_id="ag_01",
        grant_id="grnt_01",
        action="tool.run:test_tool",
        metadata={"kwargs": {"item": "widget"}, "error": "something went wrong"},
        status="failure",
    )


def test_audit_returns_same_tool_instance(mock_grantex: MagicMock) -> None:
    tool = _make_tool(lambda: "ok")
    original_id = id(tool)
    returned = with_audit_logging(
        tool, mock_grantex, agent_id="ag_01", grant_id="grnt_01"
    )
    assert id(returned) == original_id


def test_audit_does_not_log_on_scope_error() -> None:
    """PermissionError from create_grantex_tool happens before any run, so no log."""
    mock_client = MagicMock()
    token_no_scope = make_grant_token([])

    with pytest.raises(PermissionError):
        create_grantex_tool(
            name="restricted",
            description="restricted",
            grant_token=token_no_scope,
            required_scope="data:read",
            func=lambda: "ok",
        )

    mock_client.audit.log.assert_not_called()
