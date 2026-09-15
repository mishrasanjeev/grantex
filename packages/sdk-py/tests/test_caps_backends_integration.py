"""Caps meter against real Redis and real Postgres (PRD G-4).

Set GRANTEX_CAPS_REDIS_URL (redis://host:port/db) and/or
GRANTEX_CAPS_POSTGRES_URL (postgres://user:password@host:port/db). Tests for
a backend without a URL are skipped, unless GRANTEX_CAPS_REQUIRE_INTEGRATION=1
(set in CI), in which case a missing URL fails the run.
"""
from __future__ import annotations

import os
import re
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Iterator, List, Tuple
from urllib.parse import unquote, urlparse

import pytest

from grantex.caps import (
    CapExceededError,
    CapLimit,
    CapsMeter,
    MeterUnavailableError,
    PostgresCapsBackend,
    RedisCapsBackend,
    tenant_hash,
)
from grantex.caps._redis import REFUND_SCRIPT, RESERVE_SCRIPT, USAGE_SCRIPT

REDIS_URL = os.environ.get("GRANTEX_CAPS_REDIS_URL")
POSTGRES_URL = os.environ.get("GRANTEX_CAPS_POSTGRES_URL")
REQUIRED = os.environ.get("GRANTEX_CAPS_REQUIRE_INTEGRATION") == "1"

HOUR = 3_600_000
T0 = 1_760_000_000_000


def _skip_or_fail(url: str | None, name: str) -> None:
    if url:
        return
    if REQUIRED:
        pytest.fail(f"{name} is required (GRANTEX_CAPS_REQUIRE_INTEGRATION=1) but not set")
    pytest.skip(f"{name} not set")


def _pg_connect_factory(url: str) -> Callable[[], Any]:
    import pg8000.dbapi

    parsed = urlparse(url)

    def connect() -> Any:
        return pg8000.dbapi.connect(
            user=unquote(parsed.username or ""),
            password=unquote(parsed.password or ""),
            host=parsed.hostname or "127.0.0.1",
            port=parsed.port or 5432,
            database=(parsed.path or "/").lstrip("/") or "postgres",
            timeout=10,
        )

    return connect


class Clock:
    def __init__(self, now: int = T0) -> None:
        self.now = now

    def __call__(self) -> int:
        return self.now


def _redis_backend() -> RedisCapsBackend:
    import redis

    return RedisCapsBackend(redis.Redis.from_url(REDIS_URL or "", socket_timeout=10, max_connections=64))


def _postgres_backend() -> PostgresCapsBackend:
    backend = PostgresCapsBackend(_pg_connect_factory(POSTGRES_URL or ""))
    backend.ensure_schema()
    return backend


@pytest.fixture(params=["redis", "postgres"])
def backend(request: pytest.FixtureRequest) -> Iterator[Any]:
    if request.param == "redis":
        _skip_or_fail(REDIS_URL, "GRANTEX_CAPS_REDIS_URL")
        yield _redis_backend()
    else:
        _skip_or_fail(POSTGRES_URL, "GRANTEX_CAPS_POSTGRES_URL")
        yield _postgres_backend()


def _tenant() -> str:
    return f"dev_it_{uuid.uuid4().hex}"


def _limit(limit: int, window: str = "per_hour", units: int = 1, counter: str = "acme_kyb.verify_business") -> CapLimit:
    return CapLimit(counter=counter, limit=limit, window=window, units=units)


def test_fifty_parallel_calls_against_a_cap_of_ten(backend: Any) -> None:
    meter = CapsMeter(backend)
    tenant = _tenant()
    barrier = threading.Barrier(50)

    def call(_: int) -> str:
        barrier.wait()
        try:
            meter.reserve(tenant, [_limit(10)])
            return "reserved"
        except CapExceededError as exc:
            assert (exc.code, exc.limit, exc.window) == ("E1008", 10, "per_hour")
            return "cap_exceeded"

    with ThreadPoolExecutor(max_workers=50) as pool:
        outcomes = list(pool.map(call, range(50)))
    assert outcomes.count("reserved") == 10
    assert outcomes.count("cap_exceeded") == 40
    assert meter.usage(tenant, [_limit(10)])[0].used == 10


def test_enforce_with_fifty_parallel_calls_against_a_per_hour_cap_of_ten(backend: Any) -> None:
    from unittest.mock import patch

    from grantex import Grantex, ToolManifest
    from grantex._types import VerifiedGrant

    manifest = ToolManifest.from_dict(
        {"connector": "acme_kyb", "tools": {"resolve_business": {"permission": "read", "caps": {"per_hour": 10}}}}
    )
    client = Grantex(api_key="test-key", caps_meter=CapsMeter(backend))
    client.load_manifest(manifest)
    grant = VerifiedGrant(
        token_id="tok_01", grant_id="grnt_01", principal_id="user_01", agent_did="did:grantex:ag_01",
        developer_id=_tenant(), scopes=("tool:acme_kyb:read",), issued_at=1709000000, expires_at=9999999999,
    )
    barrier = threading.Barrier(50)

    def call(_: int) -> Any:
        barrier.wait()
        return client.enforce("t", "acme_kyb", "resolve_business")

    with patch("grantex._client.verify_grant_token", return_value=grant):
        with ThreadPoolExecutor(max_workers=50) as pool:
            results = list(pool.map(call, range(50)))
    assert sum(r.allowed for r in results) == 10
    denied = [r for r in results if not r.allowed]
    assert {(r.reason_code, r.sub_reason, r.details["code"], r.details["limit"], r.details["window"]) for r in denied} == {
        ("cap_exceeded", "limit_reached", "E1008", 10, "per_hour")
    }


def test_fifty_parallel_weighted_calls_across_two_counters(backend: Any) -> None:
    meter = CapsMeter(backend)
    tenant = _tenant()
    barrier = threading.Barrier(50)
    limits = [_limit(10, "per_case", counter="case_01.calls"), _limit(30, "per_day", units=3, counter="grant.cost_units")]

    def call(_: int) -> bool:
        barrier.wait()
        try:
            meter.reserve(tenant, limits)
            return True
        except CapExceededError:
            return False

    with ThreadPoolExecutor(max_workers=50) as pool:
        assert list(pool.map(call, range(50))).count(True) == 10
    usages = meter.usage(tenant, limits)
    assert [u.used for u in usages] == [10, 30]


def test_rolling_window_and_refund(backend: Any) -> None:
    clock = Clock()
    meter = CapsMeter(backend, clock=clock)
    tenant = _tenant()
    first = meter.reserve(tenant, [_limit(2)])
    clock.now += HOUR // 2
    meter.reserve(tenant, [_limit(2)])
    with pytest.raises(CapExceededError) as exc:
        meter.reserve(tenant, [_limit(2)])
    assert (exc.value.used, exc.value.limit) == (2, 2)
    clock.now = T0 + HOUR  # the first reservation ages out exactly now
    meter.reserve(tenant, [_limit(2)])
    with pytest.raises(CapExceededError):
        meter.reserve(tenant, [_limit(2)])
    meter.refund_unsent(first)  # already aged out: no effect
    with pytest.raises(CapExceededError):
        meter.reserve(tenant, [_limit(2)])


def test_refund_releases_a_live_reservation_once(backend: Any) -> None:
    meter = CapsMeter(backend, clock=Clock())
    tenant = _tenant()
    reservation = meter.reserve(tenant, [_limit(1, "per_case", units=1)])
    meter.refund_unsent(reservation)
    meter.refund_unsent(reservation)
    assert meter.usage(tenant, [_limit(1, "per_case")])[0].used == 0
    meter.reserve(tenant, [_limit(1, "per_case")])
    with pytest.raises(CapExceededError):
        meter.reserve(tenant, [_limit(1, "per_case")])


def test_all_or_nothing_across_counters(backend: Any) -> None:
    meter = CapsMeter(backend, clock=Clock())
    tenant = _tenant()
    meter.reserve(tenant, [_limit(1, counter="b")])
    with pytest.raises(CapExceededError):
        meter.reserve(tenant, [_limit(5, counter="a"), _limit(1, counter="b")])
    assert meter.usage(tenant, [_limit(5, counter="a")])[0].used == 0


def test_tenants_are_isolated(backend: Any) -> None:
    meter = CapsMeter(backend, clock=Clock())
    first, second = _tenant(), _tenant()
    meter.reserve(first, [_limit(1)])
    meter.reserve(second, [_limit(1)])
    with pytest.raises(CapExceededError):
        meter.reserve(first, [_limit(1)])


def test_redis_keys_are_tenant_scoped_with_one_hash_tag() -> None:
    _skip_or_fail(REDIS_URL, "GRANTEX_CAPS_REDIS_URL")
    import redis

    client = redis.Redis.from_url(REDIS_URL or "")
    tenant = _tenant()
    CapsMeter(RedisCapsBackend(client), clock=Clock()).reserve(
        tenant, [_limit(5, counter="x"), _limit(5, "per_case", counter="y")]
    )
    keys = sorted(k.decode() for k in client.scan_iter(match=f"grantex:caps:{{{tenant_hash(tenant)}}}:*"))
    assert len(keys) == 4
    assert all(re.fullmatch(r"grantex:caps:\{[0-9a-f]{32}\}:[0-9a-f]{64}:[zs]", k) for k in keys)
    assert tenant not in "".join(keys)
    windowed = [k for k in keys if client.pttl(k) > 0]
    assert len(windowed) == 2  # per-hour keys expire; per-case keys do not


def test_postgres_rows_are_tenant_scoped() -> None:
    _skip_or_fail(POSTGRES_URL, "GRANTEX_CAPS_POSTGRES_URL")
    backend = _postgres_backend()
    tenant = _tenant()
    CapsMeter(backend, clock=Clock()).reserve(tenant, [_limit(5)])
    conn = _pg_connect_factory(POSTGRES_URL or "")()
    try:
        cur = conn.cursor()
        cur.execute("SELECT DISTINCT tenant_id FROM grantex_cap_reservations WHERE tenant_id = %s", (tenant_hash(tenant),))
        rows: List[Tuple[Any, ...]] = [tuple(r) for r in cur.fetchall()]
        assert rows == [(tenant_hash(tenant),)]
    finally:
        conn.close()


def test_unreachable_backends_fail_closed() -> None:
    import redis
    from redis.backoff import NoBackoff
    from redis.retry import Retry

    unreachable_redis = RedisCapsBackend(
        redis.Redis(host="127.0.0.1", port=1, socket_connect_timeout=1, retry=Retry(NoBackoff(), 0))
    )
    with pytest.raises(MeterUnavailableError):
        CapsMeter(unreachable_redis).reserve("dev_01", [_limit(10)])

    unreachable_pg = PostgresCapsBackend(_pg_connect_factory("postgres://nobody:nothing@127.0.0.1:1/none"))
    with pytest.raises(MeterUnavailableError):
        CapsMeter(unreachable_pg).reserve("dev_01", [_limit(10)])


def test_lua_scripts_are_identical_in_both_sdks() -> None:
    source = (Path(__file__).resolve().parents[2] / "sdk-ts" / "src" / "caps" / "redis.ts").read_text(encoding="utf-8")
    for name, script in (("RESERVE_SCRIPT", RESERVE_SCRIPT), ("REFUND_SCRIPT", REFUND_SCRIPT), ("USAGE_SCRIPT", USAGE_SCRIPT)):
        match = re.search(rf"export const {name} = `(.*?)`;", source, re.S)
        assert match is not None, name
        assert match.group(1) == script, name
