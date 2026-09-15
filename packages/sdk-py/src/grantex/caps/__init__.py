"""Call caps and cost-unit budgets for tool calls.

``CapsMeter`` reserves units against every applicable counter atomically,
before the call that incurs cost. Backends:

- :class:`RedisCapsBackend` — Lua script, tenant-scoped keys (preferred);
- :class:`PostgresCapsBackend` — row locks and upserts, for deployments
  without Redis;
- :class:`InMemoryCapsBackend` — **tests only**.

There is no automatic failover between backends: two stores would keep two
sets of counters and concurrent calls could exceed a cap. If the configured
backend is unavailable the meter raises :class:`MeterUnavailableError` and
``enforce()`` denies.

See ``docs/concepts/caps-and-metering.md``.
"""

from ._limits import (
    CASE_REQUIRED,
    INVALID_CASE_ID,
    INVALID_COST_COMPONENT,
    MALFORMED_GRANT_CAPS,
    build_cap_limits,
    counter_id,
    parse_grant_caps,
)
from ._memory import InMemoryCapsBackend
from ._meter import (
    ERROR_CODE,
    PER_CASE,
    PER_DAY,
    PER_HOUR,
    WINDOW_MS,
    CapExceededError,
    CapLimit,
    CapsBackend,
    CapsConfigurationError,
    CapsMeter,
    CounterUsage,
    MeterUnavailableError,
    Reservation,
    tenant_hash,
)
from ._postgres import SCHEMA_SQL, PostgresCapsBackend
from ._redis import RedisCapsBackend

__all__ = [
    "CASE_REQUIRED",
    "ERROR_CODE",
    "INVALID_CASE_ID",
    "INVALID_COST_COMPONENT",
    "MALFORMED_GRANT_CAPS",
    "PER_CASE",
    "PER_DAY",
    "PER_HOUR",
    "SCHEMA_SQL",
    "WINDOW_MS",
    "CapExceededError",
    "CapLimit",
    "CapsBackend",
    "CapsConfigurationError",
    "CapsMeter",
    "CounterUsage",
    "InMemoryCapsBackend",
    "MeterUnavailableError",
    "PostgresCapsBackend",
    "RedisCapsBackend",
    "Reservation",
    "build_cap_limits",
    "counter_id",
    "parse_grant_caps",
    "tenant_hash",
]
