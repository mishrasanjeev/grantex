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

The tenant is the grant's developer (`dev` claim) unless you pass
`caps_tenant_id` / `capsTenantId`, which applies to every counter of that call.
A call's cost is the sum of the manifest `cost_units` for the components it
incurs. Metering attaches to the call that incurs the cost, in the code that
makes that call, and never to parsing its result afterwards.

### Case and cost components come from the gateway

`case_id` and `cost_components` decide which counters a call is charged to, so
the tool gateway sets them from its own context: the case being worked, and
the provider request it is about to send. Never take them from the agent's or
model's tool arguments, or an agent could name a fresh case to escape a
per-case cap or claim a cheaper component. The same applies to
`wrap_tool(case_id=..., cost_components=...)` / `wrapTool({ caseId,
costComponents })` and to `enforceMiddleware({ extractCaseId,
extractCostComponents })`, which should read trusted request context.

An empty `cost_components` list for a tool that declares cost units is denied
(`invalid_cost_component`); omit the argument to charge every declared unit.

### Check early, reserve once

An agent platform often checks a call twice, once when the plan is validated
and again at the tool gateway. Only the second check should consume a unit:

```python
# while validating the plan: decision only, nothing consumed
check = grantex.enforce(grant_token=token, connector="acme_kyb", tool="verify_business",
                        case_id=case_id, reserve=False)

# at the gateway, immediately before the provider call
result = grantex.enforce(grant_token=token, connector="acme_kyb", tool="verify_business",
                         case_id=case_id, cost_components=["base"])
```

`reserve=False` (`reserve: false`) compares current usage with the caps and
returns `cap_limits` / `capLimits` and `caps_tenant_id` / `capsTenantId`. The
check is point in time: another call can take the last unit before you
reserve, so the reserving `enforce()` (or
`meter.reserve(result.caps_tenant_id, result.cap_limits)`) is the decision
that counts.

### Rolling caps out: `caps_mode`

| Mode | Behaviour |
|---|---|
| `enforce` (default) | Calls a cap would deny are denied |
| `warn` | Calls a cap, a missing meter or an unavailable backend would deny are **allowed**; `result.would_deny` / `wouldDeny` carries the `reason_code`, `sub_reason`, `reason` and `details` they would have got. Calls that fit are reserved as in `enforce`; calls over a cap reserve nothing, so counters show what enforcement would have allowed |
| `off` | Caps are not evaluated and no meter is needed |

Set it on the client (`Grantex(caps_mode="warn")`, `new Grantex({ capsMode: 'warn' })`)
or per call. Malformed grant caps are a token problem and are denied in every
mode. Log `would_deny` while in `warn`, review it, then switch to `enforce`.

The client's separate `enforce_mode="permissive"` (development only) turns
**every** denial into an allow, including `cap_exceeded` and
`meter_unavailable`; the result keeps its `reason_code`, but nothing is reserved
for such a call.

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
| `invalid_cost_component` | `cost_components` names a unit the tool does not declare, is empty for a tool that declares units, or the call's cost exceeds 2147483647 |
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

**Redis** (6.0 or later; the scripts use `SET ... KEEPTTL`). Keys look like
`grantex:caps:{<tenant hash>}:<counter hash>:z|s`. Everything a reservation
touches shares one hash tag, so it works on Redis Cluster. Time comes from the
Redis server. Per-hour and per-day keys expire one window plus 60 seconds after
the **last** reservation on the counter (each reservation resets the TTL);
entries older than the window are dropped whenever the counter is used.
Per-case keys never expire unless you set `case_ttl_seconds` /
`caseTtlSeconds`, because an expired per-case counter would reset the cap. Run
Redis with `maxmemory-policy noeviction`: an evicted counter forgets
reservations.

**Postgres.** Create the tables with `grantex.caps.SCHEMA_SQL` or
`CAPS_SCHEMA_SQL` in your migrations, or call `ensure_schema()` /
`ensureSchema()`. The Python backend takes a factory for DB-API connections
with `%s` placeholders, for example `pg8000`. The TypeScript backend takes a
`pg` `Pool`. Reservations run in READ COMMITTED transactions and time comes
from the database. Rows carry a hash of the tenant id rather than the id, so
row-level security policies keyed on tenant ids do not apply to these tables.
Expired rows are removed when their counter is next used; run `prune()`
periodically (for example hourly, from a scheduled job) to delete expired
reservations and empty counters from all tenants. Per-case reservations are
kept unless the backend was given `case_ttl_seconds` / `caseTtlSeconds`.
`prune()` skips counters that are being reserved; if a race makes it fail, run
it again.

### No automatic failover

The meter does not fall back from Redis to Postgres when Redis fails. Two
stores would hold two sets of counters, and calls spread across them could
exceed every cap. Choose one backend per deployment. If it is unavailable,
`enforce()` denies with `meter_unavailable` until it recovers.

## Remaining budget

`meter.usage(tenant_id, limits)` returns what each counter holds and what
remains. Build the limits for a tool with `grantex.caps.build_cap_limits`
(`buildCapLimits`), or use `result.cap_limits` from `enforce()`.

## Not yet covered

This is the metering library. Showing caps and remaining budget on the consent
page and in a per-case view, and a per-tenant `caps.enforce` rollout flag in
the platform that drives `caps_mode`, are separate work.
