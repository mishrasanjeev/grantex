# SPDX-License-Identifier: Apache-2.0
"""A ``capped:N`` scope needs an amount: enforce() and wrap_tool() deny without one."""
from __future__ import annotations

import asyncio
from typing import Any, Iterator, Mapping, Tuple
from unittest.mock import MagicMock, patch

import pytest

from grantex import CapSubReason, DenialReason, Grantex, ToolManifest
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


MERCHANT = ToolManifest.from_dict(
    {
        "connector": "merchant",
        "tools": {"get_order": "read", "place_order": "write"},
    }
)


@pytest.fixture()
def verify() -> Iterator[MagicMock]:
    with patch("grantex._client.verify_grant_token") as mock:
        mock.return_value = _grant("tool:merchant:write:*:capped:50")
        yield mock


def _client(**kwargs: Any) -> Grantex:
    c = Grantex(api_key="test-key", **kwargs)
    c.load_manifest(MERCHANT)
    return c


def _codes(result: object) -> Tuple[bool, str, str]:
    return (
        getattr(result, "allowed"),
        getattr(result, "reason_code"),
        getattr(result, "sub_reason"),
    )


class TestEnforceAmountMissing:
    def test_capped_scope_without_amount_denies_amount_missing(self, verify: MagicMock) -> None:
        result = _client().enforce("t", "merchant", "place_order")
        assert _codes(result) == (False, DenialReason.CAP_EXCEEDED, CapSubReason.AMOUNT_MISSING)
        assert result.details == {"limit": 50.0}
        assert "no amount" in result.reason

    def test_capped_scope_on_any_permission_of_the_connector_needs_an_amount(
        self, verify: MagicMock
    ) -> None:
        # The cap applies to every call on the connector, as it does for an
        # amount (the tightest capped scope on the connector wins).
        verify.return_value = _grant("tool:merchant:read:capped:5", "tool:merchant:write")
        assert _codes(_client().enforce("t", "merchant", "place_order")) == (
            False, DenialReason.CAP_EXCEEDED, CapSubReason.AMOUNT_MISSING)

    def test_capped_scope_with_amount_is_allowed(self, verify: MagicMock) -> None:
        assert _client().enforce("t", "merchant", "place_order", amount=50).allowed is True

    def test_uncapped_scope_without_amount_is_allowed(self, verify: MagicMock) -> None:
        verify.return_value = _grant("tool:merchant:write")
        assert _codes(_client().enforce("t", "merchant", "place_order")) == (True, "", "")

    def test_capped_scope_on_another_connector_does_not_apply(self, verify: MagicMock) -> None:
        verify.return_value = _grant("tool:merchant:write", "tool:other:write:capped:5")
        assert _client().enforce("t", "merchant", "place_order").allowed is True

    def test_capped_scope_applies_to_read_tools_of_the_connector(self, verify: MagicMock) -> None:
        # Connector-wide: a read tool already covered by an uncapped scope
        # still needs an amount (an extractor may report 0).
        verify.return_value = _grant("tool:merchant:read:*", "tool:merchant:write:*:capped:50")
        assert _codes(_client().enforce("t", "merchant", "get_order")) == (
            False, DenialReason.CAP_EXCEEDED, CapSubReason.AMOUNT_MISSING)
        assert _client().enforce("t", "merchant", "get_order", amount=0).allowed is True

    def test_malformed_cap_without_amount_denies_malformed_cap(self, verify: MagicMock) -> None:
        verify.return_value = _grant("tool:merchant:write:*:capped:abc")
        assert _codes(_client().enforce("t", "merchant", "place_order")) == (
            False, DenialReason.CAP_EXCEEDED, CapSubReason.MALFORMED_CAP)

    def test_malformed_cap_with_amount_denies_in_every_caps_mode(self, verify: MagicMock) -> None:
        verify.return_value = _grant("tool:merchant:write:*:capped:abc")
        for mode in ("enforce", "warn", "off"):
            result = _client().enforce("t", "merchant", "place_order", amount=1, caps_mode=mode)
            assert _codes(result) == (
                False, DenialReason.CAP_EXCEEDED, CapSubReason.MALFORMED_CAP), mode

    def test_permissive_enforce_mode_still_allows(self, verify: MagicMock) -> None:
        with pytest.warns(UserWarning, match="PERMISSIVE MODE"):
            result = _client(enforce_mode="permissive").enforce("t", "merchant", "place_order")
        assert result.allowed is True


class TestCapsModeOptOut:
    def test_warn_mode_allows_and_reports_amount_missing(self, verify: MagicMock) -> None:
        result = _client(caps_mode="warn").enforce("t", "merchant", "place_order")
        assert result.allowed is True
        assert result.reason_code == ""
        assert result.would_deny is not None
        assert result.would_deny["reason_code"] == DenialReason.CAP_EXCEEDED
        assert result.would_deny["sub_reason"] == CapSubReason.AMOUNT_MISSING
        assert result.would_deny["details"] == {"limit": 50.0}

    def test_warn_per_call_overrides_the_client(self, verify: MagicMock) -> None:
        result = _client().enforce("t", "merchant", "place_order", caps_mode="warn")
        assert result.allowed is True
        assert result.would_deny is not None
        assert result.would_deny["sub_reason"] == CapSubReason.AMOUNT_MISSING

    def test_warn_mode_still_denies_an_amount_above_the_cap(self, verify: MagicMock) -> None:
        result = _client(caps_mode="warn").enforce("t", "merchant", "place_order", amount=51)
        assert _codes(result) == (False, DenialReason.CAP_EXCEEDED, CapSubReason.AMOUNT_CAP)

    def test_warn_mode_allows_a_malformed_cap_without_amount_and_reports_it(
        self, verify: MagicMock
    ) -> None:
        verify.return_value = _grant("tool:merchant:write:*:capped:abc")
        result = _client(caps_mode="warn").enforce("t", "merchant", "place_order")
        assert result.allowed is True
        assert result.would_deny is not None
        assert result.would_deny["reason_code"] == DenialReason.CAP_EXCEEDED
        assert result.would_deny["sub_reason"] == CapSubReason.MALFORMED_CAP

    def test_off_mode_allows_a_malformed_cap_without_amount(self, verify: MagicMock) -> None:
        verify.return_value = _grant("tool:merchant:write:*:capped:abc")
        result = _client(caps_mode="off").enforce("t", "merchant", "place_order")
        assert result.allowed is True
        assert result.would_deny is None

    def test_off_mode_allows_without_reporting(self, verify: MagicMock) -> None:
        result = _client(caps_mode="off").enforce("t", "merchant", "place_order")
        assert result.allowed is True
        assert result.would_deny is None


REFUNDS = ToolManifest.from_dict(
    {
        "connector": "merchant",
        "tools": {
            "approve_refund": {"permission": "write", "requires_decision": True},
            "release_refund": {"permission": "write", "requires_decision": True, "caps": {"per_hour": 5}},
        },
    }
)


def _refunds_client(**kwargs: Any) -> Grantex:
    c = Grantex(api_key="test-key", **kwargs)
    c.load_manifest(REFUNDS)
    return c


def _steps(result: object) -> list[Tuple[str, str]]:
    return [(w["reason_code"], w["sub_reason"]) for w in getattr(result, "would_deny_all")]


class TestWarnReportsEveryWouldBeDenial:
    """Warn mode keeps would_deny as the first would-be denial and lists every
    one, in step order, in would_deny_all."""

    def test_decision_and_amount_missing_are_both_reported_in_step_order(
        self, verify: MagicMock
    ) -> None:
        result = _refunds_client(decisions_mode="warn", caps_mode="warn").enforce(
            "t", "merchant", "approve_refund"
        )
        assert result.allowed is True
        assert _steps(result) == [
            (DenialReason.DECISION_REQUIRED, ""),
            (DenialReason.CAP_EXCEEDED, CapSubReason.AMOUNT_MISSING),
        ]
        assert result.would_deny_all[1]["details"] == {"limit": 50.0}
        # The first would-be denial is still reported in would_deny.
        assert result.would_deny is not None
        assert result.would_deny["reason_code"] == DenialReason.DECISION_REQUIRED
        assert result.would_deny == result.would_deny_all[0]

    def test_decision_malformed_cap_and_meter_are_all_reported_in_step_order(
        self, verify: MagicMock
    ) -> None:
        verify.return_value = _grant("tool:merchant:write:*:capped:abc")
        result = _refunds_client(decisions_mode="warn", caps_mode="warn").enforce(
            "t", "merchant", "release_refund", reserve=False
        )
        assert result.allowed is True
        assert _steps(result) == [
            (DenialReason.DECISION_REQUIRED, ""),
            (DenialReason.CAP_EXCEEDED, CapSubReason.MALFORMED_CAP),
            (DenialReason.CAP_EXCEEDED, CapSubReason.METER_UNAVAILABLE),
        ]
        assert result.would_deny == result.would_deny_all[0]

    def test_amount_missing_and_meter_are_both_reported(self, verify: MagicMock) -> None:
        result = _refunds_client(decisions_mode="warn", caps_mode="warn").enforce(
            "t", "merchant", "release_refund", reserve=False
        )
        assert _steps(result) == [
            (DenialReason.DECISION_REQUIRED, ""),
            (DenialReason.CAP_EXCEEDED, CapSubReason.AMOUNT_MISSING),
            (DenialReason.CAP_EXCEEDED, CapSubReason.METER_UNAVAILABLE),
        ]

    def test_a_single_warning_is_the_only_entry(self, verify: MagicMock) -> None:
        result = _client(caps_mode="warn").enforce("t", "merchant", "place_order")
        assert result.would_deny is not None
        assert result.would_deny["sub_reason"] == CapSubReason.AMOUNT_MISSING
        assert result.would_deny_all == (result.would_deny,)

    def test_no_warning_leaves_both_empty(self, verify: MagicMock) -> None:
        result = _client(caps_mode="warn").enforce("t", "merchant", "place_order", amount=10)
        assert result.allowed is True
        assert result.would_deny is None
        assert result.would_deny_all == ()

    def test_decisions_enforce_still_denies_before_the_cap_step(self, verify: MagicMock) -> None:
        result = _refunds_client(caps_mode="warn").enforce("t", "merchant", "approve_refund")
        assert (result.allowed, result.reason_code) == (False, DenialReason.DECISION_REQUIRED)
        assert result.would_deny is None and result.would_deny_all == ()


class _FakeTool:
    def __init__(self) -> None:
        self.calls: list[Mapping[str, Any]] = []

    def _run(self, **kwargs: Any) -> str:
        self.calls.append(kwargs)
        return "placed"

    async def _arun(self, **kwargs: Any) -> str:
        self.calls.append(kwargs)
        return "placed"


class TestWrapToolAmount:
    def test_wrap_tool_passes_extracted_amount(self, verify: MagicMock) -> None:
        client = _client()
        tool = _FakeTool()
        seen: list[Mapping[str, Any]] = []

        def amount_of(arguments: Mapping[str, Any]) -> float:
            seen.append(arguments)
            return float(arguments["total"])

        client.wrap_tool(
            tool, connector="merchant", tool_name="place_order",
            grant_token="tok", extract_amount=amount_of,
        )
        with patch.object(client, "enforce", wraps=client.enforce) as spy:
            assert tool._run(total=20, sku="nimbus-01") == "placed"
        assert spy.call_args.kwargs["amount"] == 20.0
        assert seen == [{"total": 20, "sku": "nimbus-01"}]

        with pytest.raises(PermissionError, match="exceeds budget cap of 50"):
            tool._run(total=51, sku="nimbus-01")
        assert len(tool.calls) == 1

    def test_wrap_tool_async_path_passes_extracted_amount(self, verify: MagicMock) -> None:
        client = _client()
        tool = _FakeTool()
        client.wrap_tool(
            tool, connector="merchant", tool_name="place_order",
            grant_token="tok", extract_amount=lambda arguments: arguments["total"],
        )
        assert asyncio.run(tool._arun(total=10)) == "placed"
        with pytest.raises(PermissionError, match="exceeds budget cap"):
            asyncio.run(tool._arun(total=500))

    def test_wrap_tool_without_extractor_denies_amount_missing(self, verify: MagicMock) -> None:
        client = _client()
        tool = _FakeTool()
        client.wrap_tool(tool, connector="merchant", tool_name="place_order", grant_token="tok")
        with pytest.raises(PermissionError, match="no amount"):
            tool._run(total=20)
        assert tool.calls == []

    def test_wrap_tool_extractor_returning_none_denies_amount_missing(self, verify: MagicMock) -> None:
        client = _client()
        tool = _FakeTool()
        client.wrap_tool(
            tool, connector="merchant", tool_name="place_order",
            grant_token="tok", extract_amount=lambda arguments: arguments.get("total"),
        )
        with pytest.raises(PermissionError, match="no amount"):
            tool._run(sku="nimbus-01")
        assert tool.calls == []

    def test_wrap_tool_without_extractor_is_unchanged_for_uncapped_scopes(
        self, verify: MagicMock
    ) -> None:
        verify.return_value = _grant("tool:merchant:write")
        client = _client()
        tool = _FakeTool()
        client.wrap_tool(tool, connector="merchant", tool_name="place_order", grant_token="tok")
        assert tool._run(total=20) == "placed"

    def test_wrap_tool_extractor_that_raises_fails_closed(self, verify: MagicMock) -> None:
        client = _client()
        tool = _FakeTool()

        def broken(arguments: Mapping[str, Any]) -> float:
            raise KeyError("total")

        client.wrap_tool(
            tool, connector="merchant", tool_name="place_order",
            grant_token="tok", extract_amount=broken,
        )
        with patch.object(client, "enforce", wraps=client.enforce) as spy:
            with pytest.raises(PermissionError, match="amount extractor .* raised KeyError") as info:
                tool._run(sku="nimbus-01")
        assert isinstance(info.value.__cause__, KeyError)
        assert tool.calls == []
        spy.assert_not_called()

    def test_wrap_tool_extractor_that_raises_fails_closed_without_a_cap(
        self, verify: MagicMock
    ) -> None:
        # The extractor is the application saying the call has an amount; if it
        # cannot produce one the call is refused whatever the grant says.
        verify.return_value = _grant("tool:merchant:write")
        client = _client()
        tool = _FakeTool()

        def broken(arguments: Mapping[str, Any]) -> float:
            raise ValueError("bad total")

        client.wrap_tool(
            tool, connector="merchant", tool_name="place_order",
            grant_token="tok", extract_amount=broken,
        )
        with pytest.raises(PermissionError, match="amount extractor"):
            tool._run(total="x")
        assert tool.calls == []

    @pytest.mark.parametrize("value", ["20", True, float("nan"), float("inf"), [20]])
    def test_wrap_tool_extractor_returning_a_non_number_fails_closed(
        self, verify: MagicMock, value: object
    ) -> None:
        client = _client()
        tool = _FakeTool()
        client.wrap_tool(
            tool, connector="merchant", tool_name="place_order",
            grant_token="tok", extract_amount=lambda arguments: value,
        )
        with pytest.raises(PermissionError, match="finite number"):
            tool._run(total=value)
        assert tool.calls == []
