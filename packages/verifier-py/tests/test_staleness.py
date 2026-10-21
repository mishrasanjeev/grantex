# SPDX-License-Identifier: Apache-2.0
"""The staleness matrix (PRD section 9) and the tier it depends on."""

from __future__ import annotations

from typing import Any, List, Optional

import pytest
from conftest import ACCEPTANCE_URI, ISSUER_LIST_URI, JWKS_URL, MANIFEST_URL, NOW, World, tx

from grantex_verifier import (
    FEED_FAIL_CLOSED_SECONDS,
    MANIFEST_MAX_AGE_SECONDS,
    REGISTRY_KEYS_MAX_AGE_SECONDS,
    STATUS_LIST_HIGH_RISK_STALENESS_SECONDS,
    STATUS_LIST_MAX_STALENESS_SECONDS,
    FeedGrantStatus,
    OnlineGrantStatus,
    compute_tier,
    status_staleness_bound,
    verify,
)


def run(world: World, config: Any, transaction: Any = None) -> Any:
    req, passport, grant = world.signed_request()
    return verify(passport, grant, req, transaction or tx(), config=config)


def test_the_matrix_values() -> None:
    assert REGISTRY_KEYS_MAX_AGE_SECONDS == 86_400
    assert MANIFEST_MAX_AGE_SECONDS == 3600
    assert STATUS_LIST_MAX_STALENESS_SECONDS == 300
    assert STATUS_LIST_HIGH_RISK_STALENESS_SECONDS == 60
    assert FEED_FAIL_CLOSED_SECONDS == 10


def test_bound_is_five_minutes_normally_and_sixty_seconds_for_high_risk() -> None:
    assert status_staleness_bound(amount_minor=100, hitl_threshold_minor=1000, human_present=True, tier="B") == 300
    assert status_staleness_bound(amount_minor=1001, hitl_threshold_minor=1000, human_present=True, tier="C") == 60
    assert status_staleness_bound(amount_minor=100, hitl_threshold_minor=None, human_present=False, tier="A") == 60


def test_tiers() -> None:
    assert compute_tier(human_present=False, amount_minor=1, hitl_threshold_minor=None) == "A"
    assert compute_tier(human_present=True, amount_minor=1, hitl_threshold_minor=10) == "B"
    assert compute_tier(human_present=True, amount_minor=11, hitl_threshold_minor=10) == "C"


def _advance(world: World, seconds: float) -> None:
    world.now += seconds


def test_a_status_list_read_is_reused_within_the_bound_and_not_after(world: World) -> None:
    config = world.config()
    assert run(world, config).ok
    first = world.fetcher.calls.count(ISSUER_LIST_URI)
    _advance(world, 200)
    assert run(world, config).ok
    assert world.fetcher.calls.count(ISSUER_LIST_URI) == first
    _advance(world, 150)  # 350 s after the read: past five minutes
    assert run(world, config).ok
    assert world.fetcher.calls.count(ISSUER_LIST_URI) == first + 1


def test_a_list_older_than_five_minutes_that_cannot_be_refreshed_is_stale(world: World) -> None:
    config = world.config()
    assert run(world, config).ok
    _advance(world, 301)
    world.fetcher.down.update({ISSUER_LIST_URI, ACCEPTANCE_URI})
    result = run(world, config)
    assert result.denial_code == "status_stale"
    assert result.checks["passport.status"].code == "status_stale"
    assert result.checks["attestation.accepted"].code == "status_stale"


def test_above_the_hitl_threshold_a_read_older_than_sixty_seconds_is_stale(world: World) -> None:
    config = world.config()
    assert run(world, config).ok
    _advance(world, 90)
    world.fetcher.down.update({ISSUER_LIST_URI, ACCEPTANCE_URI})
    # 12 500 is below the threshold of 20 000: the five-minute bound applies.
    assert run(world, config).ok
    result = run(world, config, tx(amount_minor=25_000))
    assert result.checks["passport.status"].code == "status_stale"
    assert result.tier == "C"


def test_a_human_not_present_tier_a_grant_uses_sixty_seconds(world: World) -> None:
    config = world.config()
    assert run(world, config).ok
    _advance(world, 90)
    world.fetcher.down.update({ISSUER_LIST_URI, ACCEPTANCE_URI})
    result = run(world, config, tx(human_present=False))
    assert result.tier == "A"
    assert result.checks["passport.status"].code == "status_stale"


def test_a_list_ttl_shorter_than_the_bound_is_honoured(world: World) -> None:
    world.list_ttl = 30
    world.publish()
    config = world.config()
    assert run(world, config).ok
    first = world.fetcher.calls.count(ISSUER_LIST_URI)
    _advance(world, 45)
    assert run(world, config).ok
    assert world.fetcher.calls.count(ISSUER_LIST_URI) == first + 1


def test_the_manifest_is_refetched_and_never_used_past_an_hour(world: World) -> None:
    config = world.config()
    assert run(world, config).ok
    world.fetcher.down.add(MANIFEST_URL)
    _advance(world, 600)
    world.publish()
    world.fetcher.down.add(MANIFEST_URL)
    # The cached copy is still inside its hour: used.
    assert run(world, config).checks["issuer.accredited"].ok
    _advance(world, 3600)
    world.publish()
    world.fetcher.down.add(MANIFEST_URL)
    result = run(world, config)
    assert result.checks["issuer.accredited"].code == "status_stale"


def test_registry_keys_are_refetched_after_a_day(world: World) -> None:
    config = world.config()
    assert run(world, config).ok
    assert world.fetcher.calls.count(JWKS_URL) == 1
    _advance(world, 86_401)
    world.publish()
    assert run(world, config).ok
    assert world.fetcher.calls.count(JWKS_URL) == 2
    _advance(world, 86_401)
    world.publish()
    world.fetcher.down.add(JWKS_URL)
    result = run(world, config)
    assert result.checks["grant.signature"].code == "status_stale"


def test_a_static_registry_key_set_needs_no_fetch(world: World) -> None:
    config = world.config(registry_jwks={"keys": [world.registry.public_jwk]})
    assert run(world, config).ok
    assert JWKS_URL not in world.fetcher.calls


# ── grant status sources ─────────────────────────────────────────────────────


class _Feed:
    def __init__(self, fresh_at: float, revoked: Optional[str] = None) -> None:
        self.fresh_at = fresh_at
        self.revoked = revoked

    def state(self) -> Any:
        class S:
            synced = True
            unavailable = None

        s = S()
        s.fresh_at = self.fresh_at  # type: ignore[attr-defined]
        return s

    def match(self, *, grant_id: Any = None, token_id: Any = None, parent_grant_id: Any = None) -> Any:
        if self.revoked is not None and self.revoked in (grant_id, token_id, parent_grant_id):
            class M:
                kind = "grant"
                action = "revoked"

            return M()
        return None


def test_the_feed_is_trusted_within_ten_seconds_of_its_heartbeat() -> None:
    feed = _Feed(fresh_at=100.0)
    source = FeedGrantStatus(feed, monotonic=lambda: 109.0, clock=lambda: float(NOW))
    assert source.grant_status(grant_id="g", token_id="t", parent_grant_id=None).state == "active"
    late = FeedGrantStatus(feed, monotonic=lambda: 110.5, clock=lambda: float(NOW))
    assert late.grant_status(grant_id="g", token_id="t", parent_grant_id=None).state == "unknown"


def test_the_feed_reports_a_revoked_grant() -> None:
    feed = _Feed(fresh_at=100.0, revoked="g")
    source = FeedGrantStatus(feed, monotonic=lambda: 100.5, clock=lambda: float(NOW))
    assert source.grant_status(grant_id="g", token_id="t", parent_grant_id=None).state == "revoked"


def test_the_online_status_reads_the_revocation_status_endpoint() -> None:
    calls: List[str] = []

    def get(path: str) -> Any:
        calls.append(path)
        return {"revoked": False}

    source = OnlineGrantStatus(get, clock=lambda: float(NOW))
    assert source.grant_status(grant_id="grnt_1", token_id="tok_1", parent_grant_id=None).state == "active"
    assert calls == ["/v1/revocations/status?grantId=grnt_1&jti=tok_1"]


@pytest.mark.parametrize(
    ("answer", "state"),
    [
        ({"revoked": True, "status": "revoked"}, "revoked"),
        ({"revoked": True, "status": "suspended"}, "suspended"),
        ({"revoked": True, "status": "unknown"}, "unknown"),
        ({"revoked": "no"}, "unknown"),
        ("not json", "unknown"),
    ],
)
def test_the_online_status_fails_closed_on_anything_unreadable(answer: Any, state: str) -> None:
    source = OnlineGrantStatus(lambda path: answer, clock=lambda: float(NOW))
    assert source.grant_status(grant_id="g", token_id="t", parent_grant_id=None).state == state
