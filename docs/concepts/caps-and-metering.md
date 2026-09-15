---
title: "Caps and Metering"
sidebarTitle: "Caps and Metering"
description: "Per-tool call caps over rolling windows and per case, cost-unit budgets, and a meter that cannot be raced past a cap."
---

## What caps do

A grant says which tools an agent may call. Caps say **how often**. They
bound the damage of a looping agent, protect a paid provider account and make
spend predictable.

Two places declare caps.

**The manifest** declares tenant-wide caps per tool, and the cost of a call in
cost units:

```json
{
  "connector": "acme_kyb",
  "tools": {
    "resolve_business": {"permission": "read", "caps": {"per_hour": 200}},
    "verify_business":  {"permission": "read",
                         "caps": {"per_hour": 50, "per_case": 3},
                         "cost_units": {"base": 5, "ownership": 10, "web_insights": 3}},
    "screen_person":    {"permission": "read", "caps": {"per_hour": 0}}
  }
}
```

**The grant** declares caps for that grant only, in its
`urn:grantex:tools:v1` authorization details: per tool, and a cost-unit
budget for the connector under the reserved key `cost_units`:

```json
{
  "type": "urn:grantex:tools:v1",
  "connector": "acme_kyb",
  "purpose": "aml.cdd.onboarding",
  "caps": {
    "verify_business": {"per_hour": 50, "per_case": 3},
    "cost_units": {"per_day": 5000}
  }
}
```

| Window | Meaning |
|---|---|
| `per_hour` | Rolling hour: a call counts until exactly 3,600 seconds after it was reserved |
| `per_day` | Rolling 24 hours |
| `per_case` | All calls made for one case, with no time limit |

Every declared cap is a separate counter, and a call must fit all of them.
Manifest caps are shared by every grant in the tenant; grant caps count only
that grant's calls. A cap of `0` disables the tool.

## Metering a call

Configure a meter on the client. `enforce()` then reserves the call's units
as its **last** step, after the token, scope, purpose and decision checks have
passed, so a denied call never uses up a cap.

```python
import redis
from grantex import Grantex
from grantex.caps import CapsMeter, RedisCapsBackend

meter = CapsMeter(RedisCapsBackend(redis.Redis.from_url("redis://localhost:6379/0")))
grantex = Grantex(api_key=api_key, caps_meter=meter)

result = grantex.enforce(
    grant_token=token,
    connector="acme_kyb",
    tool="verify_business",
    case_id="case_0001",                 # required when a per_case cap applies
    cost_components=["base", "ownership"],  # default: every unit the tool declares
)
if not result.allowed:
    raise PermissionError(result.reason)
```

```typescript
import { Redis } from 'ioredis';
import { Grantex, CapsMeter, RedisCapsBackend, ioredisRunner } from '@grantex/sdk';

const meter = new CapsMeter(new RedisCapsBackend(ioredisRunner(new Redis('redis://localhost:6379/0'))));
const grantex = new Grantex({ apiKey, capsMeter: meter });

const result = await grantex.enforce({
  grantToken: token,
  connector: 'acme_kyb',
  tool: 'verify_business',
  caseId: 'case_0001',
  costComponents: ['base', 'ownership'],
});
```

The tenant is the grant's developer (`dev` claim). A call's cost is the sum of
the manifest `cost_units` for the components it incurs. Metering attaches to
the call that incurs the cost, in the code that makes that call, and never to
parsing its result afterwards.

### When a cap is exceeded

`enforce()` denies with `reason_code` `cap_exceeded`, `sub_reason`
`limit_reached` and details that include error code **E1008**, the limit and
the window:

```python
result.details == {
    "code": "E1008", "limit": 50, "window": "per_hour",
    "used": 50, "requested": 1, "scope": "manifest", "kind": "calls",
}
```

Other `cap_exceeded` sub-reasons:

| `sub_reason` | Cause |
|---|---|
| `case_required` | A `per_case` cap applies and no `case_id` was passed |
| `invalid_case_id` | `case_id` is empty or longer than 256 characters |
| `invalid_cost_component` | `cost_components` names a unit the tool does not declare |
| `meter_unavailable` | No meter is configured, or its backend failed |

Malformed grant caps deny as `token_invalid` / `malformed_authorization_details`.

### Failed calls are not refunded

The reservation is made before the provider call and stays counted if the call
then fails or times out. A timeout does not prove the provider did no work or
did not bill for it, and refunding on error would let a flaky or hostile
upstream reset the cap.

Refund only when you know the request never left your process, for example
when it failed validation locally or a connection could not be opened:

```python
try:
    response = provider.verify_business(request)
except ConnectionNotOpened:
    meter.refund_unsent(result.reservation)
    raise
```

## Backends

| Backend | Use | How it stays atomic |
|---|---|---|
| `RedisCapsBackend` | Preferred | One Lua script checks and records every counter of a call |
| `PostgresCapsBackend` | Deployments without Redis | One transaction upserts and locks each counter row (in a fixed order), then sums and inserts |
| `InMemoryCapsBackend` | **Tests only** | A process-local lock; not shared between workers |

Both SDKs derive the same counter keys and run the same Lua script and SQL, so
Python and TypeScript workers can share one Redis or Postgres. Fifty parallel
calls against a cap of ten reserve exactly ten, on both backends, in CI.

**Redis.** Keys look like `grantex:caps:{<tenant hash>}:<counter hash>:z|s`.
Everything a reservation touches shares one hash tag, so it works on Redis
Cluster. Time comes from the Redis server. Per-hour and per-day keys expire
after their window. Per-case keys never expire unless you set
`case_ttl_seconds` / `caseTtlSeconds`, because an expired per-case counter
would reset the cap. Run Redis with `maxmemory-policy noeviction`: an evicted
counter forgets reservations.

**Postgres.** Create the tables with `grantex.caps.SCHEMA_SQL` or
`CAPS_SCHEMA_SQL` in your migrations, or call `ensure_schema()` /
`ensureSchema()`. The Python backend takes a factory for DB-API connections
with `%s` placeholders, for example `pg8000`. The TypeScript backend takes a
`pg` `Pool`. Rows carry the tenant hash, and time comes from the database.

### No automatic failover

The meter does not fall back from Redis to Postgres when Redis fails. Two
stores would hold two sets of counters, and calls spread across them could
exceed every cap. Choose one backend per deployment. If it is unavailable,
`enforce()` denies with `meter_unavailable` until it recovers.

## Remaining budget

`meter.usage(tenant_id, limits)` returns what each counter holds and what
remains, for a consent page or a per-case view. Build the limits for a tool
with `grantex.caps.build_cap_limits` (`buildCapLimits`).
