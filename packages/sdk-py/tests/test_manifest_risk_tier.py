# SPDX-License-Identifier: Apache-2.0
"""``risk_tier`` on tool manifests: a ``high`` tool needs a decision grant on every call."""
from __future__ import annotations

from typing import Any, Iterator
from unittest.mock import MagicMock, patch

import pytest

from grantex import DenialReason, Grantex, ToolManifest
from grantex._types import VerifiedGrant
from grantex.manifest import ManifestValidationError, parse_tool_declaration, tool_spec_to_dict

GRANT = VerifiedGrant(
    token_id="tok_01", grant_id="grnt_01", principal_id="shopper-01", agent_did="did:grantex:ag_01",
    developer_id="dev_01", scopes=("tool:acme_kyb:write",), issued_at=1709000000, expires_at=9999999999,
)


@pytest.fixture()
def verify() -> Iterator[MagicMock]:
    with patch("grantex._client.verify_grant_token") as mock:
        mock.return_value = GRANT
        yield mock


def _client(tools: dict[str, Any]) -> Grantex:
    c = Grantex(api_key="test-key", revocation_check="offline", audience_check="off")
    c.load_manifest(ToolManifest.from_dict({"connector": "acme_kyb", "tools": tools}))
    return c


def test_parse_round_trip_and_rejections() -> None:
    spec = parse_tool_declaration("close_case", {"permission": "write", "risk_tier": "high"})
    assert spec.risk_tier == "high" and spec.requires_decision is False
    assert tool_spec_to_dict(spec) == {"permission": "write", "risk_tier": "high"}
    assert parse_tool_declaration("get_case", {"permission": "read", "risk_tier": "medium"}).risk_tier == "medium"
    with pytest.raises(ManifestValidationError, match="tools.get_case: risk_tier high is not allowed on a tool with read permission"):
        parse_tool_declaration("get_case", {"permission": "read", "risk_tier": "high"})
    with pytest.raises(ManifestValidationError, match="tools.close_case.risk_tier: must be one of low, medium, high"):
        parse_tool_declaration("close_case", {"permission": "write", "risk_tier": "critical"})


def test_high_risk_tool_needs_a_decision_grant(verify: MagicMock) -> None:
    result = _client({"close_case": {"permission": "write", "risk_tier": "high"}}).enforce(
        grant_token="t", connector="acme_kyb", tool="close_case"
    )
    assert result.allowed is False and result.reason_code == DenialReason.DECISION_REQUIRED


def test_medium_risk_tool_does_not(verify: MagicMock) -> None:
    result = _client({"close_case": {"permission": "write", "risk_tier": "medium"}}).enforce(
        grant_token="t", connector="acme_kyb", tool="close_case"
    )
    assert result.allowed is True
