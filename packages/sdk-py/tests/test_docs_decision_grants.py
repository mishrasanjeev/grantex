"""The Python example in docs/concepts/decision-grants.md is
tests/docs_examples/decision_enforce.py, embedded verbatim (checked here) and
exercised here, so the documentation cannot drift from the SDK."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Iterator
from unittest.mock import MagicMock, patch

import pytest

from grantex import Grantex, ToolManifest
from grantex._types import VerifiedGrant
from tests.docs_examples.decision_enforce import call_case_decision
from tests.test_decision_grants import NOW, FakeIssuer, build_grant, resolver

ROOT = Path(__file__).resolve().parents[3]
EXAMPLE = "packages/sdk-py/tests/docs_examples/decision_enforce.py"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8").replace("\r\n", "\n")


def test_the_example_is_embedded_verbatim() -> None:
    doc = _read(ROOT / "docs" / "concepts" / "decision-grants.md")
    match = re.search(rf"\{{/\* snippet: {re.escape(EXAMPLE)} \*/\}}\n```python\n([\s\S]*?)\n```", doc)
    assert match is not None
    assert match.group(1) == _read(ROOT / EXAMPLE).rstrip("\n")


@pytest.fixture()
def grantex() -> Iterator[Grantex]:
    with patch("grantex._client.verify_grant_token") as verify:
        verify.return_value = VerifiedGrant(
            token_id="tok_01", grant_id="grnt_01", principal_id="user_01", agent_did="did:grantex:ag_01",
            developer_id="dev_01", scopes=("tool:acme_kyb:write",), issued_at=1, expires_at=9999999999,
        )
        with patch("grantex.decisions._verify._default_key_resolver", return_value=resolver), \
                patch("grantex.decisions._verify.time.time", return_value=NOW):
            client = Grantex(api_key="test-key", decision_consumer=FakeIssuer())
            client.load_manifest(ToolManifest.from_dict({
                "connector": "acme_kyb",
                "tools": {"case_decision": {"permission": "write", "requires_decision": True, "four_eyes_on": ["decline"]}},
            }))
            yield client


def test_call_case_decision_allows_once_then_refuses(grantex: Grantex) -> None:
    arguments = {"case_id": "case_8841", "decision": "approve", "subject": "gb:00000001", "planned_at": "2026-09-15T10:00:00Z"}
    token = build_grant({})
    call_case_decision(grantex, "grant-token", [token], arguments, "v7")
    with pytest.raises(PermissionError, match="decision_invalid/consumed"):
        call_case_decision(grantex, "grant-token", [token], arguments, "v7")
    with pytest.raises(PermissionError, match="decision_required"):
        call_case_decision(grantex, "grant-token", [], arguments, "v7")
    assert isinstance(grantex, Grantex) and not isinstance(grantex, MagicMock)
