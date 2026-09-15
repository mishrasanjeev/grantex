"""Spend caps (PRD G-4): caps meter, limit derivation and enforce() integration.

Backend-independent behaviour runs against the in-memory backend with a frozen
clock. tests/test_caps_backends_integration.py runs the same guarantees
against real Redis and Postgres.
"""
from __future__ import annotations

import json
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Iterator, List, Optional, Sequence
from unittest.mock import MagicMock, patch

import pytest

from grantex import CapSubReason, DenialReason, Grantex, ToolManifest
from grantex._types import VerifiedGrant
from grantex.caps import (
    CASE_REQUIRED,
    ERROR_CODE,
    INVALID_COST_COMPONENT,
    CapExceededError,
    CapLimit,
    CapsConfigurationError,
    CapsMeter,
    InMemoryCapsBackend,
    MeterUnavailableError,
    build_cap_limits,
    counter_id,
    tenant_hash,
)
from grantex.manifest import ToolCaps, ToolSpec

HOUR = 3_600_000
DAY = 86_400_000
SPEC = Path(__file__).resolve().parents[3] / "spec" / "examples" / "caps-counters.json"


class Clock:
    def __init__(self, now: int = 1_760_000_000_000) -> None:
        self.now = now

    def __call__(self) -> int:
        return self.now


def _meter(clock: Optional[Clock] = None) -> CapsMeter:
    return CapsMeter(InMemoryCapsBackend(), clock=clock or Clock())


def _limit(limit: int, window: str = "per_hour", units: int = 1, counter: str = "c1") -> CapLimit:
    return CapLimit(counter=counter, limit=limit, window=window, units=units)


# ── Meter ────────────────────────────────────────────────────────────────────


class TestCapsMeter:
    def test_reserves_up_to_the_limit_then_raises_e1008_with_limit_and_window(self) -> None:
        meter = _meter()
        for _ in range(3):
            meter.reserve("dev_01", [_limit(3)])
        with pytest.raises(CapExceededError) as exc:
            meter.reserve("dev_01", [_limit(3)])
        assert exc.value.code == ERROR_CODE == "E1008"
        assert exc.value.reason == "cap_exceeded"
        assert (exc.value.limit, exc.value.window, exc.value.used, exc.value.requested) == (3, "per_hour", 3, 1)
        assert "E1008" in str(exc.value) and "per_hour" in str(exc.value) and "3" in str(exc.value)

    def test_rolling_hour_window_frees_units_as_they_age_out(self) -> None:
        clock = Clock()
        meter = _meter(clock)
        meter.reserve("dev_01", [_limit(2)])
        clock.now += HOUR // 2
        meter.reserve("dev_01", [_limit(2)])
        with pytest.raises(CapExceededError):
            meter.reserve("dev_01", [_limit(2)])
        clock.now += HOUR // 2 - 1  # first reservation is still inside the window
        with pytest.raises(CapExceededError):
            meter.reserve("dev_01", [_limit(2)])
        clock.now += 1  # exactly one hour after the first: it has aged out
        meter.reserve("dev_01", [_limit(2)])

    def test_rolling_day_window(self) -> None:
        clock = Clock()
        meter = _meter(clock)
        meter.reserve("dev_01", [_limit(1, "per_day")])
        clock.now += DAY - 1
        with pytest.raises(CapExceededError):
            meter.reserve("dev_01", [_limit(1, "per_day")])
        clock.now += 1
        meter.reserve("dev_01", [_limit(1, "per_day")])

    def test_per_case_counters_never_age_out(self) -> None:
        clock = Clock()
        meter = _meter(clock)
        meter.reserve("dev_01", [_limit(1, "per_case")])
        clock.now += 365 * DAY
        with pytest.raises(CapExceededError) as exc:
            meter.reserve("dev_01", [_limit(1, "per_case")])
        assert exc.value.window == "per_case"

    def test_a_cap_of_zero_disables_the_tool_without_asking_the_backend(self) -> None:
        backend = MagicMock()
        meter = CapsMeter(backend)
        with pytest.raises(CapExceededError) as exc:
            meter.reserve("dev_01", [_limit(0)])
        assert exc.value.limit == 0
        backend.reserve.assert_not_called()

    def test_reservation_is_all_or_nothing_across_limits(self) -> None:
        meter = _meter()
        meter.reserve("dev_01", [_limit(1, counter="b")])
        with pytest.raises(CapExceededError) as exc:
            meter.reserve("dev_01", [_limit(5, counter="a"), _limit(1, counter="b")])
        assert exc.value.limit == 1
        assert meter.usage("dev_01", [_limit(5, counter="a")])[0].used == 0

    def test_weighted_units(self) -> None:
        meter = _meter()
        meter.reserve("dev_01", [_limit(10, units=7)])
        with pytest.raises(CapExceededError) as exc:
            meter.reserve("dev_01", [_limit(10, units=4)])
        assert (exc.value.used, exc.value.requested) == (7, 4)
        meter.reserve("dev_01", [_limit(10, units=3)])
        usage = meter.usage("dev_01", [_limit(10)])[0]
        assert (usage.used, usage.remaining) == (10, 0)

    def test_a_single_call_above_the_cap_reports_the_real_usage(self) -> None:
        meter = _meter()
        meter.reserve("dev_01", [_limit(10, units=4)])
        with pytest.raises(CapExceededError) as exc:
            meter.reserve("dev_01", [_limit(10, units=11)])
        assert (exc.value.used, exc.value.requested, exc.value.limit) == (4, 11, 10)

    def test_zero_unit_limits_are_not_recorded(self) -> None:
        meter = _meter()
        reservation = meter.reserve("dev_01", [_limit(1, units=0)])
        assert reservation.limits == ()

    def test_refund_unsent_releases_units_and_is_idempotent(self) -> None:
        meter = _meter()
        reservation = meter.reserve("dev_01", [_limit(1)])
        meter.refund_unsent(reservation)
        meter.refund_unsent(reservation)
        meter.reserve("dev_01", [_limit(1)])
        with pytest.raises(CapExceededError):
            meter.reserve("dev_01", [_limit(1)])

    def test_counters_are_tenant_scoped(self) -> None:
        meter = _meter()
        meter.reserve("dev_01", [_limit(1)])
        meter.reserve("dev_02", [_limit(1)])
        with pytest.raises(CapExceededError):
            meter.reserve("dev_01", [_limit(1)])

    def test_backend_failure_is_meter_unavailable(self) -> None:
        backend = MagicMock()
        backend.reserve.side_effect = ConnectionError("down")
        with pytest.raises(MeterUnavailableError):
            CapsMeter(backend).reserve("dev_01", [_limit(5)])
        backend.usage.side_effect = ConnectionError("down")
        with pytest.raises(MeterUnavailableError):
            CapsMeter(backend).usage("dev_01", [_limit(5)])

    @pytest.mark.parametrize(
        "tenant, limits",
        [
            ("", [CapLimit(counter="c", limit=1, window="per_hour")]),
            ("dev_01", [CapLimit(counter="c", limit=1, window="per_week")]),
            ("dev_01", [CapLimit(counter="", limit=1, window="per_hour")]),
            ("dev_01", [CapLimit(counter="c", limit=-1, window="per_hour")]),
            ("dev_01", [CapLimit(counter="c", limit=True, window="per_hour")]),
            ("dev_01", [CapLimit(counter="c", limit=1, window="per_hour", units=-2)]),
            ("dev_01", [CapLimit(counter="c", limit=1, window="per_hour")] * 2),
        ],
    )
    def test_invalid_arguments_are_rejected(self, tenant: str, limits: List[CapLimit]) -> None:
        with pytest.raises(CapsConfigurationError):
            _meter().reserve(tenant, limits)

    def test_fifty_parallel_reservations_against_a_cap_of_ten(self) -> None:
        meter = CapsMeter(InMemoryCapsBackend())
        barrier = threading.Barrier(50)

        def call(_: int) -> bool:
            barrier.wait()
            try:
                meter.reserve("dev_01", [_limit(10)])
                return True
            except CapExceededError:
                return False

        with ThreadPoolExecutor(max_workers=50) as pool:
            results = list(pool.map(call, range(50)))
        assert results.count(True) == 10


# ── Limits ───────────────────────────────────────────────────────────────────


class TestBuildCapLimits:
    SPEC = ToolSpec(
        permission="read",
        caps=ToolCaps(per_hour=50, per_case=3),
        cost_units={"base": 5, "ownership": 10, "web_insights": 3},
    )

    def test_manifest_and_grant_caps_are_separate_counters(self) -> None:
        limits = build_cap_limits(
            connector="acme_kyb", tool="verify_business", spec=self.SPEC, grant_id="grnt_01",
            grant_caps={"verify_business": {"per_hour": 20}, "cost_units": {"per_day": 5000}},
            case_id="case_01",
        )
        assert [(lim.scope, lim.kind, lim.window, lim.limit, lim.units) for lim in limits] == [
            ("manifest", "calls", "per_hour", 50, 1),
            ("manifest", "calls", "per_case", 3, 1),
            ("grant", "calls", "per_hour", 20, 1),
            ("grant", "cost_units", "per_day", 5000, 18),
        ]
        assert limits[1].counter == counter_id("manifest", "acme_kyb", "verify_business", "calls", "per_case", "case_01")

    def test_cost_components_select_units(self) -> None:
        limits = build_cap_limits(
            connector="acme_kyb", tool="verify_business", spec=ToolSpec(permission="read", cost_units={"base": 5, "ownership": 10}),
            grant_id="grnt_01", grant_caps={"cost_units": {"per_hour": 100}}, cost_components=["base"],
        )
        assert [(lim.kind, lim.units) for lim in limits] == [("cost_units", 5)]

    def test_unknown_cost_component_is_rejected(self) -> None:
        with pytest.raises(CapsConfigurationError) as exc:
            build_cap_limits(
                connector="acme_kyb", tool="verify_business", spec=self.SPEC, grant_id="grnt_01",
                case_id="case_01", cost_components=["base", "screening"],
            )
        assert exc.value.sub_reason == INVALID_COST_COMPONENT

    def test_empty_cost_components_for_a_tool_with_cost_units_is_rejected(self) -> None:
        with pytest.raises(CapsConfigurationError) as exc:
            build_cap_limits(
                connector="acme_kyb", tool="verify_business", spec=self.SPEC, grant_id="grnt_01",
                grant_caps={"cost_units": {"per_day": 100}}, case_id="case_01", cost_components=[],
            )
        assert exc.value.sub_reason == INVALID_COST_COMPONENT

    def test_empty_cost_components_for_a_tool_without_cost_units_is_allowed(self) -> None:
        limits = build_cap_limits(
            connector="acme_kyb", tool="get_case", spec=ToolSpec(permission="read"), grant_id="grnt_01",
            cost_components=[],
        )
        assert limits == []

    def test_a_cost_above_the_maximum_is_an_invalid_cost_component(self) -> None:
        spec = ToolSpec(permission="read", cost_units={"base": 2147483647, "ownership": 1})
        with pytest.raises(CapsConfigurationError) as exc:
            build_cap_limits(connector="acme_kyb", tool="verify_business", spec=spec, grant_id="grnt_01")
        assert exc.value.sub_reason == INVALID_COST_COMPONENT

    def test_per_case_cap_needs_a_case(self) -> None:
        with pytest.raises(CapsConfigurationError) as exc:
            build_cap_limits(connector="acme_kyb", tool="verify_business", spec=self.SPEC, grant_id="grnt_01")
        assert exc.value.sub_reason == CASE_REQUIRED

    @pytest.mark.parametrize(
        "caps",
        [
            [],
            {"verify_business": 5},
            {"verify_business": {}},
            {"verify_business": {"per_week": 5}},
            {"verify_business": {"per_hour": -1}},
            {"cost_units": {"per_day": "5000"}},
        ],
    )
    def test_malformed_grant_caps_are_rejected(self, caps: Any) -> None:
        with pytest.raises(CapsConfigurationError) as exc:
            build_cap_limits(
                connector="acme_kyb", tool="verify_business", spec=ToolSpec(permission="read"),
                grant_id="grnt_01", grant_caps=caps,
            )
        assert exc.value.sub_reason == "malformed_grant_caps"


def test_counter_keys_match_the_shared_fixture() -> None:
    for case in json.loads(SPEC.read_text(encoding="utf-8"))["cases"]:
        cid = counter_id(*case["parts"])
        assert cid == case["counter_id"]
        limit = CapLimit(counter=cid, limit=1, window=case["window"])
        assert limit.key() == case["counter_hash"]
        assert tenant_hash(case["tenant_id"]) == case["tenant_hash"]


# ── enforce() ────────────────────────────────────────────────────────────────


def _grant(details: Any = None, developer_id: str = "dev_01", scopes: Sequence[str] = ("tool:acme_kyb:write",)) -> VerifiedGrant:
    return VerifiedGrant(
        token_id="tok_01", grant_id="grnt_01", principal_id="user_01", agent_did="did:grantex:ag_01",
        developer_id=developer_id, scopes=tuple(scopes), issued_at=1709000000, expires_at=9999999999,
        authorization_details=details,
    )


ACME_KYB = ToolManifest.from_dict(
    {
        "connector": "acme_kyb",
        "tools": {
            "get_case": "read",
            "resolve_business": {"permission": "read", "caps": {"per_hour": 2}},
            "verify_business": {"permission": "read", "caps": {"per_case": 3}, "cost_units": {"base": 5, "ownership": 10}},
            "screen_person": {"permission": "read", "caps": {"per_hour": 0}},
            "price_check": {"permission": "read", "cost_units": {"base": 1}},
            "monitor_enroll": {"permission": "write", "caps": {"per_hour": 5}},
        },
    }
)


@pytest.fixture()
def verify() -> Iterator[MagicMock]:
    with patch("grantex._client.verify_grant_token") as mock:
        mock.return_value = _grant()
        yield mock


def _client(meter: Optional[CapsMeter] = None) -> Grantex:
    client = Grantex(api_key="test-key", caps_meter=meter if meter is not None else _meter())
    client.load_manifest(ACME_KYB)
    return client


class TestSpendCapsAcceptanceCriteria:
    def test_exceeding_a_per_hour_cap_returns_e1008_cap_exceeded_with_the_limit_and_the_window(self, verify: MagicMock) -> None:
        client = _client()
        assert client.enforce("t", "acme_kyb", "resolve_business").allowed is True
        assert client.enforce("t", "acme_kyb", "resolve_business").allowed is True
        result = client.enforce("t", "acme_kyb", "resolve_business")
        assert (result.allowed, result.reason_code, result.sub_reason) == (
            False, DenialReason.CAP_EXCEEDED, CapSubReason.LIMIT_REACHED)
        assert result.details["code"] == "E1008"
        assert (result.details["limit"], result.details["window"]) == (2, "per_hour")
        assert "E1008 cap_exceeded" in result.reason

    def test_exceeding_a_per_case_cap_returns_e1008_cap_exceeded_with_the_limit_and_the_window(self, verify: MagicMock) -> None:
        client = _client()
        for _ in range(3):
            assert client.enforce("t", "acme_kyb", "verify_business", case_id="case_01").allowed is True
        result = client.enforce("t", "acme_kyb", "verify_business", case_id="case_01")
        assert result.reason_code == "cap_exceeded"
        assert (result.details["code"], result.details["limit"], result.details["window"]) == ("E1008", 3, "per_case")
        assert client.enforce("t", "acme_kyb", "verify_business", case_id="case_02").allowed is True

    def test_a_cap_of_zero_disables_a_tool(self, verify: MagicMock) -> None:
        result = _client().enforce("t", "acme_kyb", "screen_person")
        assert (result.allowed, result.reason_code, result.details["limit"]) == (False, "cap_exceeded", 0)

    def test_concurrent_calls_cannot_exceed_a_cap(self, verify: MagicMock) -> None:
        manifest = ToolManifest.from_dict(
            {"connector": "acme_kyb", "tools": {"resolve_business": {"permission": "read", "caps": {"per_hour": 10}}}}
        )
        client = Grantex(api_key="test-key", caps_meter=CapsMeter(InMemoryCapsBackend()))
        client.load_manifest(manifest)
        barrier = threading.Barrier(50)

        def call(_: int) -> bool:
            barrier.wait()
            return client.enforce("t", "acme_kyb", "resolve_business").allowed

        with ThreadPoolExecutor(max_workers=50) as pool:
            assert list(pool.map(call, range(50))).count(True) == 10


class TestEnforceMetering:
    def test_allowed_call_carries_its_reservation(self, verify: MagicMock) -> None:
        result = _client().enforce("t", "acme_kyb", "resolve_business")
        assert result.reservation is not None
        assert result.reservation.tenant_id == "dev_01"
        assert [lim.window for lim in result.reservation.limits] == ["per_hour"]

    def test_tools_without_caps_are_not_metered(self, verify: MagicMock) -> None:
        backend = MagicMock()
        result = _client(CapsMeter(backend)).enforce("t", "acme_kyb", "get_case")
        assert result.allowed is True and result.reservation is None
        backend.reserve.assert_not_called()

    def test_denied_calls_do_not_consume_caps(self, verify: MagicMock) -> None:
        meter = _meter()
        client = _client(meter)
        verify.return_value = _grant(scopes=("tool:acme_kyb:read",))
        for _ in range(10):
            assert client.enforce("t", "acme_kyb", "monitor_enroll").reason_code == DenialReason.PERMISSION_INSUFFICIENT
        verify.return_value = _grant()
        assert client.enforce("t", "acme_kyb", "monitor_enroll").allowed is True

    def test_cost_units_are_charged_against_the_grant_budget(self, verify: MagicMock) -> None:
        verify.return_value = _grant(
            [{"type": "urn:grantex:tools:v1", "connector": "acme_kyb", "caps": {"cost_units": {"per_day": 30}}}]
        )
        client = _client()
        assert client.enforce("t", "acme_kyb", "verify_business", case_id="c1").allowed is True  # 15 units
        assert client.enforce("t", "acme_kyb", "verify_business", case_id="c2", cost_components=["base"]).allowed is True  # 5
        result = client.enforce("t", "acme_kyb", "verify_business", case_id="c3")
        assert (result.reason_code, result.details["kind"], result.details["used"], result.details["requested"]) == (
            "cap_exceeded", "cost_units", 20, 15)

    def test_cost_units_without_a_budget_are_allowed_when_a_meter_is_configured(self, verify: MagicMock) -> None:
        result = _client().enforce("t", "acme_kyb", "price_check")
        assert result.allowed is True and result.reservation is not None and result.reservation.limits == ()

    def test_grant_caps_apply_per_grant(self, verify: MagicMock) -> None:
        details = [{"type": "urn:grantex:tools:v1", "connector": "acme_kyb", "caps": {"get_case": {"per_hour": 1}}}]
        verify.return_value = _grant(details)
        client = _client()
        assert client.enforce("t", "acme_kyb", "get_case").allowed is True
        result = client.enforce("t", "acme_kyb", "get_case")
        assert (result.reason_code, result.details["scope"]) == ("cap_exceeded", "grant")

    def test_case_required_for_per_case_caps(self, verify: MagicMock) -> None:
        result = _client().enforce("t", "acme_kyb", "verify_business")
        assert (result.allowed, result.reason_code, result.sub_reason) == (False, "cap_exceeded", CapSubReason.CASE_REQUIRED)

    def test_invalid_cost_component(self, verify: MagicMock) -> None:
        result = _client().enforce("t", "acme_kyb", "verify_business", case_id="c1", cost_components=["screening"])
        assert result.sub_reason == CapSubReason.INVALID_COST_COMPONENT

    def test_malformed_grant_caps_deny_as_malformed_authorization_details(self, verify: MagicMock) -> None:
        verify.return_value = _grant(
            [{"type": "urn:grantex:tools:v1", "connector": "acme_kyb", "caps": {"resolve_business": {"per_week": 1}}}]
        )
        result = _client().enforce("t", "acme_kyb", "resolve_business")
        assert (result.reason_code, result.sub_reason) == ("token_invalid", "malformed_authorization_details")

    def test_backend_unavailable_fails_closed(self, verify: MagicMock) -> None:
        backend = MagicMock()
        backend.reserve.side_effect = TimeoutError("redis timeout")
        result = _client(CapsMeter(backend)).enforce("t", "acme_kyb", "resolve_business")
        assert (result.allowed, result.reason_code, result.sub_reason) == (False, "cap_exceeded", "meter_unavailable")

    def test_no_meter_configured_fails_closed(self, verify: MagicMock) -> None:
        client = Grantex(api_key="test-key")
        client.load_manifest(ACME_KYB)
        assert client.enforce("t", "acme_kyb", "resolve_business").sub_reason == "meter_unavailable"

    def test_tenants_do_not_share_counters(self, verify: MagicMock) -> None:
        client = _client()
        for _ in range(2):
            assert client.enforce("t", "acme_kyb", "resolve_business").allowed is True
        verify.return_value = _grant(developer_id="dev_02")
        assert client.enforce("t", "acme_kyb", "resolve_business").allowed is True

    def test_refund_unsent_restores_the_call(self, verify: MagicMock) -> None:
        meter = _meter()
        client = _client(meter)
        first = client.enforce("t", "acme_kyb", "resolve_business")
        client.enforce("t", "acme_kyb", "resolve_business")
        assert client.enforce("t", "acme_kyb", "resolve_business").allowed is False
        assert first.reservation is not None
        meter.refund_unsent(first.reservation)
        assert client.enforce("t", "acme_kyb", "resolve_business").allowed is True
