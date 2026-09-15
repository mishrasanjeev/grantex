"""enforce() denial codes (PRD Appendix B) and fail-closed handling of 0.6 declarations."""
from __future__ import annotations

import warnings
from typing import Iterator, Tuple
from unittest.mock import MagicMock, patch

import pytest

from grantex import (
    CapSubReason,
    DenialReason,
    Grantex,
    ManifestSubReason,
    Permission,
    PurposeSubReason,
    ToolManifest,
)
from grantex._errors import GrantexTokenError
from grantex._types import VerifiedGrant


def _grant(*scopes: str) -> VerifiedGrant:
    return VerifiedGrant(
        token_id="tok_01",
        grant_id="grnt_01",
        principal_id="user_01",
        agent_did="did:grantex:ag_01",
        developer_id="org_01",
        scopes=tuple(scopes),
        issued_at=1709000000,
        expires_at=9999999999,
    )


ACME_KYB = ToolManifest.from_dict(
    {
        "connector": "acme_kyb",
        "tools": {
            "get_case": "read",
            "add_case_note": "write",
            "verify_business": {"permission": "read", "allowed_purposes": ["aml.cdd.*"]},
            "resolve_business": {"permission": "read", "caps": {"per_hour": 200}},
            "price_check": {"permission": "read", "cost_units": {"base": 1}},
            "case_decision": {"permission": "write", "requires_decision": True},
        },
    }
)


@pytest.fixture()
def verify() -> Iterator[MagicMock]:
    with patch("grantex._client.verify_grant_token") as mock:
        mock.return_value = _grant("tool:acme_kyb:write")
        yield mock


def _client(mode: str = "strict") -> Grantex:
    c = Grantex(api_key="test-key", enforce_mode=mode)
    c.load_manifest(ACME_KYB)
    return c


def _codes(result: object) -> Tuple[bool, str, str]:
    return (
        getattr(result, "allowed"),
        getattr(result, "reason_code"),
        getattr(result, "sub_reason"),
    )


class TestExistingDenialsCarryCodes:
    def test_token_failure_is_token_invalid(self, verify: MagicMock) -> None:
        verify.side_effect = GrantexTokenError("expired")
        assert _codes(_client().enforce("t", "acme_kyb", "get_case")) == (
            False, DenialReason.TOKEN_INVALID, "")

    def test_unknown_connector(self, verify: MagicMock) -> None:
        assert _codes(_client().enforce("t", "other", "get_case")) == (
            False, DenialReason.MANIFEST_UNKNOWN_TOOL, ManifestSubReason.UNKNOWN_CONNECTOR)

    def test_unknown_tool(self, verify: MagicMock) -> None:
        assert _codes(_client().enforce("t", "acme_kyb", "nope")) == (
            False, DenialReason.MANIFEST_UNKNOWN_TOOL, ManifestSubReason.UNKNOWN_TOOL)

    def test_no_scope_for_connector_is_tool_not_granted(self, verify: MagicMock) -> None:
        verify.return_value = _grant("tool:other:admin")
        assert _codes(_client().enforce("t", "acme_kyb", "get_case")) == (
            False, DenialReason.TOOL_NOT_GRANTED, "")

    def test_lower_scope_is_permission_insufficient(self, verify: MagicMock) -> None:
        verify.return_value = _grant("tool:acme_kyb:read")
        assert _codes(_client().enforce("t", "acme_kyb", "add_case_note")) == (
            False, DenialReason.PERMISSION_INSUFFICIENT, "")

    def test_amount_above_cap(self, verify: MagicMock) -> None:
        verify.return_value = _grant("tool:acme_kyb:write:*:capped:10")
        result = _client().enforce("t", "acme_kyb", "add_case_note", amount=11)
        assert _codes(result) == (False, DenialReason.CAP_EXCEEDED, CapSubReason.AMOUNT_CAP)
        assert result.details == {"limit": 10.0, "amount": 11}

    def test_non_finite_amount(self, verify: MagicMock) -> None:
        assert _codes(_client().enforce("t", "acme_kyb", "add_case_note", amount=float("nan"))) == (
            False, DenialReason.CAP_EXCEEDED, CapSubReason.INVALID_AMOUNT)

    def test_malformed_amount_cap(self, verify: MagicMock) -> None:
        verify.return_value = _grant("tool:acme_kyb:write:*:capped:abc")
        assert _codes(_client().enforce("t", "acme_kyb", "add_case_note", amount=1)) == (
            False, DenialReason.CAP_EXCEEDED, CapSubReason.MALFORMED_CAP)

    def test_allowed_result_has_no_code(self, verify: MagicMock) -> None:
        result = _client().enforce("t", "acme_kyb", "add_case_note")
        assert _codes(result) == (True, "", "")
        assert result.details == {}


class TestDeclaredConstraintsFailClosed:
    def test_tools_without_constraints_behave_as_before(self, verify: MagicMock) -> None:
        c = _client()
        assert c.enforce("t", "acme_kyb", "get_case").allowed is True
        assert c.enforce("t", "acme_kyb", "add_case_note").allowed is True

    def test_tool_with_allowed_purposes_is_denied_for_a_grant_without_purpose(
        self, verify: MagicMock
    ) -> None:
        result = _client().enforce("t", "acme_kyb", "verify_business")
        assert _codes(result) == (False, DenialReason.PURPOSE_NOT_ALLOWED, PurposeSubReason.MISSING)
        assert result.details == {"allowed_purposes": ["aml.cdd.*"]}
        assert "purpose" in result.reason

    def test_tool_requiring_a_decision_returns_decision_required(self, verify: MagicMock) -> None:
        assert _codes(_client().enforce("t", "acme_kyb", "case_decision")) == (
            False, DenialReason.DECISION_REQUIRED, "")

    def test_tool_with_caps_is_denied_without_a_meter(self, verify: MagicMock) -> None:
        assert _codes(_client().enforce("t", "acme_kyb", "resolve_business")) == (
            False, DenialReason.CAP_EXCEEDED, CapSubReason.METER_UNAVAILABLE)

    def test_tool_with_cost_units_is_denied_without_a_meter(self, verify: MagicMock) -> None:
        assert _codes(_client().enforce("t", "acme_kyb", "price_check")) == (
            False, DenialReason.CAP_EXCEEDED, CapSubReason.METER_UNAVAILABLE)

    def test_permission_is_checked_before_declared_constraints(self, verify: MagicMock) -> None:
        verify.return_value = _grant("tool:acme_kyb:read")
        assert _codes(_client().enforce("t", "acme_kyb", "case_decision")) == (
            False, DenialReason.PERMISSION_INSUFFICIENT, "")

    def test_declaration_edited_into_an_invalid_state_is_denied(self, verify: MagicMock) -> None:
        manifest = ToolManifest(
            connector="acme_kyb",
            tools={"case_decision": {"permission": "write", "requires_decision": True}},
        )
        manifest.tools["case_decision"] = Permission.READ
        c = Grantex(api_key="test-key")
        c.load_manifest(manifest)
        assert _codes(c.enforce("t", "acme_kyb", "case_decision")) == (
            False, DenialReason.MANIFEST_UNKNOWN_TOOL, ManifestSubReason.INVALID_DECLARATION)

    def test_permissive_mode_keeps_the_denial_code(self, verify: MagicMock) -> None:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            result = _client("permissive").enforce("t", "acme_kyb", "case_decision")
        assert result.allowed is True
        assert result.reason_code == DenialReason.DECISION_REQUIRED


def test_taxonomy_lists_every_appendix_b_reason() -> None:
    assert set(DenialReason.ALL) >= {
        "purpose_not_allowed",
        "tool_not_granted",
        "permission_insufficient",
        "cap_exceeded",
        "decision_required",
        "decision_invalid",
        "grant_revoked",
        "region_mismatch",
        "manifest_unknown_tool",
    }
