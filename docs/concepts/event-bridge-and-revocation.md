---
title: "Event Bridge and Revocation"
sidebarTitle: "Event Bridge and Revocation"
description: "Ingest signed provider events (SSF/CAEP Security Event Tokens or signed webhooks) and turn them into grant actions, never failing open."
---

## Why an event bridge

A grant is issued against the facts at the time: the business was active,
the case was open, the principal was employed. Facts change after issuance.
A provider that monitors a business learns it was dissolved; an identity
provider learns a session was revoked. The event bridge lets those systems
tell the auth service, so the grants that relied on the old facts stop working.

The bridge has three rules:

1. **Only verified events count.** A delivery that does not verify is refused
   with `401`, counted, and never acted on.
2. **An event is acted on at most once.** Every event id is claimed in a
   replay store before anything happens.
3. **Nothing is inferred.** A verified event that no mapping rule matches is
   logged, counted and ignored. It never widens or narrows a grant by default.

The bridge is off unless `EVENT_BRIDGE_ENABLED=true`. With it off every event
bridge route answers `404` (ingestion) or `403 FEATURE_DISABLED`
(registration), and nothing else in the auth service changes.

## Registering a source

Sources belong to one developer and are managed with the developer API key.

### SSF/CAEP transmitter

A transmitter pushes Security Event Tokens (RFC 8417) to the receiver, as in
RFC 8935 push delivery. Register its issuer and its public keys, inline or by
URL:

```http
POST /v1/event-sources
Authorization: Bearer <developer API key>
Content-Type: application/json

{
  "kind": "ssf",
  "name": "acme_kyb monitoring",
  "issuer": "https://transmitter.example.com",
  "jwksUri": "https://transmitter.example.com/jwks.json",
  "algorithms": ["ES256"],
  "maxAgeSeconds": 300
}
```

The response carries `ingestUrl` (`/v1/event-bridge/ssf/<id>`). `audience`
defaults to that URL; set it to what the transmitter puts in `aud` if it
differs. `jwksUri` is fetched through the same outbound guard as webhook
URLs (no private hosts in production), cached for five minutes and
refetched at most every 30 seconds when a token names an unknown `kid`.
Inline `jwks` must contain public keys only.

A SET is accepted only when all of these hold, and each failure has its own
reason code:

| Check | Reason when it fails |
|---|---|
| Body is a compact JWS sent as `application/secevent+jwt` | `malformed`, `unsupported_media_type` (415) |
| Header `typ` is `secevent+jwt` | `unsupported_typ` |
| `alg` is on the source's allow list (`none` and HMAC never are) | `unsupported_alg` |
| A transmitter key verifies the signature | `key_unavailable`, `signature_invalid` |
| `iss` equals the registered issuer | `issuer_mismatch` |
| `aud` includes the registered audience | `audience_mismatch` |
| `iat` is present, not in the future, not older than `maxAgeSeconds` (60 s skew) | `iat_missing`, `iat_in_future`, `stale` |
| `exp`, if present, has not passed | `expired` |
| `jti` is present | `jti_missing` |
| `events` names 1 to 20 events | `events_missing` |

The subject is read from the SSF `sub_id` claim, or from an event's `subject`
member for transmitters on earlier CAEP drafts.

### Generic signed webhook

For systems that do not speak SSF, register a webhook source:

```http
POST /v1/event-sources
Content-Type: application/json

{ "kind": "webhook", "name": "provider events", "toleranceSeconds": 300 }
```

The response includes `secret` **once**. It is stored encrypted with
`VAULT_ENCRYPTION_KEY`, bound to the source id. The sender signs the
timestamp and the exact body bytes:

```text
X-Grantex-Timestamp: <unix seconds>
X-Grantex-Signature: sha256=HEX(HMAC-SHA256(secret, "<timestamp>.<raw body>"))
```

This is the scheme the auth service uses for its own outbound webhooks
(`X-Grantex-Signature-V2`), so one signer serves both directions. The body is
JSON:

```json
{
  "id": "evt_000001",
  "type": "business.dissolved",
  "occurred_at": "2026-09-15T12:00:00Z",
  "subject": { "business_ref": "gb:00000001" },
  "data": { "status": "dissolved" }
}
```

The signature is checked before the body is parsed; then the timestamp must be
within `toleranceSeconds` of the receiver's clock, in either direction
(`timestamp_out_of_window`). Several `sha256=` values may be sent, comma
separated, while the sender changes secrets.

**Rotation.** `POST /v1/event-sources/<id>/rotate-secret` returns a new
secret. The previous one keeps verifying for `previousSecretTtlSeconds`
(default one day, at most seven). Pass `0` for a leaked secret so it stops
immediately.

## Mapping an event to an action

A verified event does nothing until a rule says what it means. A rule is data:

```http
POST /v1/event-mapping-rules
Authorization: Bearer <developer API key>
Content-Type: application/json

{
  "name": "dissolution revokes onboarding grants",
  "sourceId": null,
  "eventType": "business.*",
  "conditions": [{ "path": "data.status", "equals": "dissolved" }],
  "target": { "by": "subject_ref", "path": "subject.business_ref", "kind": "business_ref" },
  "action": "revoke",
  "mode": "enforce"
}
```

| Member | Meaning |
|---|---|
| `sourceId` | Only events from this source, or `null` for any source of this developer |
| `eventType` | Exact type, or a prefix ending in `*` (`business.*` matches `business.dissolved`, not `businessx.dissolved`) |
| `conditions` | Up to 10 tests over paths in the event; **all** must hold. Each is one of `equals` (a string, number, boolean or null — no type coercion), `in` (up to 50 values) or `exists` |
| `target` | Which grants the event is about (below) |
| `action` | `suspend`, `revoke` or `re_evaluate` |
| `mode` | `enforce` acts; `observe` records what it would have done and changes nothing |
| `status` | `active` or `disabled` |

Paths start at `type`, `subject` or `data` and address members and array
elements: `subject.business_ref`, `data.filing.parties.0`. Inherited
JavaScript members are not event data and never match.

### Targets

| `by` | Resolves to |
|---|---|
| `grant_id` | The grants with those ids |
| `principal_id` | Every live grant of those principals |
| `agent_id` | Every live grant of those agents |
| `subject_ref` | Every grant bound to that `kind`/value pair (below) |

The path may hold one identifier or a list of up to 50. Anything else — a
number, an object, an absent path — records `target_invalid`: the rule acts on
nothing.

**Every resolution is scoped to the rule's developer.** A rule that names a
grant, principal or agent of another developer resolves to nothing and records
`no_target`; no grant of theirs is ever touched, and a rule may only name an
event source of its own developer.

### Binding a subject to a grant

Provider events talk about businesses and cases, not grant ids. Bind the
identifiers a grant was issued for:

```http
PUT /v1/grants/grnt_01.../subject-refs
{ "refs": [{ "kind": "business_ref", "value": "gb:00000001" },
           { "kind": "case_id", "value": "case_0001" }] }
```

`kind` is the developer's own vocabulary (lower case, up to 64 characters);
values are opaque, up to 50 per grant. Bindings on a parent grant are enough:
actions cascade to everything delegated beneath it.

## What the actions do

### `revoke` — cascade revocation

The grant and **every grant delegated beneath it, to any depth** are revoked in
one transaction: their status changes, wallet reservations are released,
credentials issued for them are revoked, the developer's audit hash chain gets
one entry per grant, and a `grant.revoked` event is emitted. The Redis
revocation key is written after the commit as an accelerator; the database
stays authoritative, so a cache outage cannot undo a committed revocation.

Revocation is irreversible and reaches suspended grants too, so a suspended
subtree can never be resumed under a revoked ancestor.

Cascade revocation takes the same per-developer lock as delegation, so a child
being delegated while its parent is revoked either loses the race (the parent
is gone when it commits) or is included in the cascade. No active grant is ever
left under a revoked one.

### `suspend` — reversible revocation

The grant and its subtree move to `suspended`. Every authorisation check
requires `status = 'active'`, so a suspended grant authorises nothing, and its
tokens stop verifying. Undo it with:

```http
POST /v1/grants/<root of the suspension>/resume
```

This restores exactly the grants that suspension suspended. It is refused with
`409 ANCESTOR_INACTIVE` while any grant above the root is revoked or
suspended, and it keeps working when the event bridge is turned off, so a
suspension can always be undone.

A grant is suspended once, under the first root that reached it. So
suspending an ancestor of an already-suspended subtree reports **zero
affected**: everything below it is already suspended, and each grant keeps
the root it was suspended under, so resuming that original root still
restores exactly what it suspended. Nothing is lost — the second call simply
has nothing left to do — but do not read "0 affected" as "the suspension did
not work".

### `re_evaluate` — hand the decision back

Nothing about the grant changes. One audit entry per grant is written and a
`grant.re_evaluation_requested` event is emitted to the developer's webhooks
and event stream, carrying the grant ids, the event id and type, the rule id
and the event's subject. The relying platform decides what to do.

and a bounded copy of the event's subject (scalar members, short values, and
`subject_truncated` when anything was dropped — the subject is
provider-supplied).

Revoking and suspending are idempotent, so a retried delivery costs nothing.
Asking the platform to look again is not, so it is claimed per source, event
and rule and happens at most once however often the delivery is retried.

## Audit records

Every action writes an entry to the developer's audit hash chain:

| Action | Audit action | Metadata |
|---|---|---|
| Revoke | `grantex.grant.revoked` | `grant_id`, `root_grant_id`, `depth`, `cascade`, `cause`, `trigger`, `reason?`, `event_id?`, `rule_id?`, `source_id?` |
| Suspend | `grantex.grant.suspended` | as above |
| — | — | A set carrying several events labels each action with the event that matched its rule, not the first one |
| Resume | `grantex.grant.resumed` | `grant_id`, `root_grant_id` |
| Re-evaluate | `grantex.grant.re_evaluation_requested` | `grant_id`, `event_id`, `rule_id`, `source_id` |

`trigger` uses the evidence-package vocabulary (`api`, `event`, `admin`,
`cascade`), so an evidence export names why a grant stopped. The `grantex.`
prefix and the `grantex:platform` marker are reserved: `POST /v1/audit/log`
refuses them, so a tenant cannot forge a revocation record. These entries are
written whatever the plan's audit limit — a security record a full plan could
suppress would be worthless.

## Delivery outcomes

The receipt for each delivery records what the rules did, and the response
carries the same status:

| Status | Meaning |
|---|---|
| `unmapped` | No rule matched. Logged, counted, ignored |
| `observed` | Only observe-mode rules matched. Nothing changed |
| `applied` | At least one enforce-mode rule matched; the receipt records per rule whether it was `applied`, `no_target` or `target_invalid` |
| `duplicate` | This event id was already processed |

## Replay protection

Each verified delivery claims `(source, event id)` — the SET `jti` or the
webhook `id` — before it is processed:

| Situation | Response | Acted on? |
|---|---|---|
| First delivery | `202 {"status": …}` | Yes, once |
| Same bytes again (a retransmission, or a replay inside the window) | `202 {"status": "duplicate"}` | No |
| Same id, different payload | `401 {"err": "unverifiable"}` (reason `event_id_reused` in the log) | No |
| Earlier delivery failed while processing | processed again | Yes (actions are idempotent) |

A replay outside the webhook window, or of a SET older than `maxAgeSeconds`,
is refused before it reaches the replay store.

Receipts are pruned hourly, but only once they are older than the window in
which their own source would still accept the delivery, and never sooner than
`EVENT_BRIDGE_RECEIPT_RETENTION_HOURS`. Removing one earlier would make an old
delivery acceptable again.

That window is **twice** the tolerance, measured from when the delivery
arrived. A webhook's timestamp check is two-sided, so a delivery may arrive
timestamped up to `toleranceSeconds` in the *future* and stays acceptable
until `received_at + 2 × toleranceSeconds`. A SET is bounded by
`maxAgeSeconds` plus twice the 60 s clock skew, because its `iat` may also be
ahead of the receiver's clock.

Raising a source's tolerance widens this for future deliveries only. Receipts
already pruned under the old, narrower window cannot come back, so for the
length of the new window there are old deliveries that would verify again and
have no receipt to refuse them. If you raise a tolerance materially, rotate
the source's secret at the same time: that invalidates every old signature and
closes the gap immediately.

## Responses

- `202 {"status": "unmapped" | "applied" | "observed" | "duplicate"}`
- `401 {"err": "unverifiable", "code": "EVENT_UNVERIFIABLE"}` for every
  verification failure: an unknown source, a disabled one, a source whose
  developer is outside `EVENT_BRIDGE_DEVELOPER_IDS`, a bad signature, a stale
  timestamp, a reused event id. One code for all of them, on purpose: a sender
  that could tell them apart could probe for source ids and for how far a
  guess had got. The precise reason is in the structured log
  (`alert: event_bridge_verification_failure`) and in the `reason` label of
  `grantex_event_bridge_verification_failures_total`.

  The **response body** is what is indistinguishable, not the work behind it.
  A real source id proceeds to secret decryption and HMAC comparison, so it
  takes measurably longer than an unknown one — around 1.4 ms in the
  reviewer's measurement, over 400 samples each. For an SSF source with a
  `jwksUri` the difference can be far larger, because a real id can trigger an
  outbound key fetch. Treat the endpoint as resistant to *reading* which ids
  exist, not to a patient attacker timing it
- `415` for the wrong media type
- `404` when the bridge is off entirely
- `5xx` when processing failed; the receipt is left `failed` so the sender's
  retry is processed again

## How an agent finds out: the revocation feed

`enforce()` verifies a grant token offline against the issuer's JWK Set. That
is what makes it fast and what makes revocation invisible to it: a revoked
grant's token stays cryptographically valid until it expires. Revoking a grant
stops the auth service issuing anything new; it does not, on its own, stop an
SDK that already holds a token.

The revocation feed closes that gap. Three modes, chosen per client or per
call:

| `revocationCheck` / `revocation_check` | What `enforce()` does | Cost |
|---|---|---|
| `offline` (default) | nothing — unchanged behaviour | none |
| `feed` | consults an in-memory set kept current by the feed | one long-lived connection per process |
| `online` | asks the auth service about this grant | one request per call |

```ts
const grantex = new Grantex({
  apiKey,
  revocationCheck: 'feed',
  revocationFeed: { staleAfterMs: 5_000 },
});
```

```python
grantex = Grantex(
    api_key=api_key,
    revocation_check="feed",
    revocation_feed_stale_after=5.0,
)
```

A denial carries `grant_revoked` with a sub-reason: `revoked`, `suspended`,
`parent_revoked`, `feed_stale`, `feed_unavailable` or `status_unavailable`.

### Failing closed

The last three matter most. An agent whose feed has gone quiet does not know
what has been revoked, so it stops authorising calls:

- the feed records when it last heard from the auth service;
- the stream sends a heartbeat every second, and only while the server has
  read the database successfully;
- if the client has heard nothing for longer than its staleness bound
  (default 5 seconds), `enforce()` denies with `feed_stale`;
- if the deployment does not serve the feed, or the feed is not ready, every
  call is denied with `feed_unavailable`;
- in `online` mode, a check that cannot be completed denies with
  `status_unavailable`, and a grant the auth service does not recognise is
  refused rather than assumed live.

This is the opposite of a cache: it is a claim about freshness that expires.

### The endpoints

```http
GET /v1/revocations                     # snapshot, plus the cursor to stream from
GET /v1/revocations?since=<cursor>      # changes since a cursor (ETag, 304, optional wait=<seconds>)
GET /v1/revocations/stream?since=<cursor>   # Server-Sent Events: revocation, heartbeat
GET /v1/revocations/status?grantId=&jti=    # one credential, for online checks
```

A client starting cold reads the cursor and then pages the snapshot — every
grant currently revoked or suspended and not yet expired, and every
individually revoked token — then streams from the cursor. Because the cursor
is read first, nothing that happens while it pages can fall between the two.

Entries are `{seq, action, grantId, jti, expiresAt, at}` with `action` one of
`revoked`, `suspended`, `resumed` or `token_revoked`. They are a set of
identifiers, so a duplicate delivery changes nothing.

**The cursor never advances past an entry that could still be overtaken.** A
transaction that took its sequence number before another but committed after
it would otherwise be skipped, so entries younger than the settle window
(`REVOCATION_FEED_SETTLE_SECONDS`, default 15 s) are delivered but do not move
the cursor. That costs a few repeated entries and removes a way to miss one.

**And never past the page it returned.** A page is bounded by `limit` (1000 by
default) while the settled maximum is not; a cursor taken from the larger
number would skip everything in between while the client believed itself up to
date. The cursor a response carries is therefore the lowest of the two — which
matters exactly when there is a lot to deliver: a large cascade, an emergency
stop, a sweep.

Delivered entries are kept for `REVOCATION_FEED_RETENTION_HOURS` past the
expiry of the credential they are about, and an hourly worker prunes the rest,
so the table the snapshot reads does not grow without bound.

### Where the entries come from

Database triggers on `grants` and `grant_tokens`, not from each revocation
path. Every way a grant stops — `DELETE /v1/grants/:id`, a cascade from a
provider event, an emergency stop, a consent withdrawal, an anomaly, a DPDP
erasure, OAuth revocation, and the hard delete behind `DELETE /v1/agents/:id`
— writes a feed entry in the same transaction as the revocation itself. Four
triggers cover it: two on status changes and two on deletion, since a deleted
row can appear in no snapshot. `pg_notify` wakes the receivers on commit; each instance
also polls (`REVOCATION_FEED_POLL_MS`, default 500 ms), so a lost notification
costs latency and never correctness.

If those triggers are missing (the migration could not take the lock at
startup), the feed endpoints answer `503 FEED_UNAVAILABLE` rather than an
empty feed, and clients fail closed.

### Measured

`scripts/revocation-release-test.sh` starts the auth service against real
Postgres and Redis, builds a delegation tree, revokes each parent and measures
how long the child kept being authorised, through both SDKs. G-6 requires two
seconds at the ninety-fifth percentile.

Two things make that number mean something. The TypeScript measurement runs in
a plain Node process loading the build from the checkout, and the Python one
refuses to start unless `grantex` was imported from the checkout — an ambient
install would otherwise "prove" the criterion against code nobody reviewed.
And the clock starts when the revocation is committed (when the API call
returns), not when the call was made: a developer on the free plan is rate
limited to 100 requests a minute, and the SDK waiting out a `Retry-After` is
not propagation. That wait is reported separately as `revoke_call_max_ms` —
and it now has a budget of its own (10 s, `REVOCATION_REVOKE_CALL_BUDGET_MS`),
because a release that prints a minute-long wait on the containment path and
passes anyway is not telling you the truth. FINDINGS G-23 tracks the
underlying problem: revoking shares the plan's rate-limit bucket with
ordinary traffic.

Any figure quoted from a run is **environment-specific**. The numbers depend
on the machine, the container runtime, whether Postgres and Redis are local,
and what else is running: an independent reviewer measured p95 100–506 ms and
max 515–673 ms where this checkout's machine measured tens of milliseconds.
What the release test asserts is the requirement — p95 within two seconds, no
failed trial — not a particular number.

## The emergency stop

Cascade revocation is the documented emergency stop for the whole platform.
One authenticated call halts every agent under a grant, an agent, a principal
or a whole developer:

```http
POST /v1/emergency-stop
Authorization: Bearer <developer API key>

{
  "scope": { "type": "agent", "id": "ag_01..." },
  "reason": "incident 4102: provider credentials leaked",
  "confirm": "stop agent:ag_01...",
  "dryRun": false
}
```

- `confirm` must be exactly `stop <type>:<id>`; anything else is refused with
  `412 CONFIRMATION_REQUIRED` and the phrase it expected. Nothing is revoked
  before that check passes.
- `dryRun: true` reports how many grants the scope covers and revokes nothing.
- A developer API key can only stop its own grants. The platform operator uses
  `POST /v1/admin/emergency-stop` with `ADMIN_API_KEY` and a `developerId`.
- `GET /v1/emergency-stops` lists what has been stopped, when, by whom and
  why.
- Underneath it is an ordinary cascade revocation per matched grant, so the
  stop appears in the audit hash chain (one `grantex.grant.revoked` per grant
  plus one `grantex.emergency_stop` summary) and on the revocation feed, and
  agents following the feed are denied within seconds.
- Off unless `EMERGENCY_STOP_ENABLED=true`. The revocations are irreversible:
  principals have to authorise again.
- **A sweep, not a lockout.** It revokes what exists, re-reading the scope
  until it comes back empty so a grant delegated mid-stop is caught, and then
  it is done: the same API key can mint a new grant immediately afterwards.
  The response says `"lockout": false`, and `status` is `completed`,
  `incomplete` (grants kept appearing) or `failed` (a batch did not finish —
  the record says what was revoked, and the call can be repeated). Rotate the
  leaked credential first; the runbook gives the order.

The runbook — rehearsing it, working out the blast radius, what to do when an
agent keeps running, and what to do if the API itself is unreachable — is
section 11 of `docs/self-hosting.md`.

## Observability

| Metric | Labels |
|---|---|
| `grantex_event_bridge_events_received_total` | `source_type` |
| `grantex_event_bridge_events_verified_total` | `source_type` |
| `grantex_event_bridge_verification_failures_total` | `source_type`, `reason` |
| `grantex_event_bridge_events_unmapped_total` | `source_type` |
| `grantex_event_bridge_events_duplicate_total` | `source_type` |
| `grantex_event_bridge_rule_matches_total` | `action`, `mode` |
| `grantex_event_bridge_actions_total` | `action`, `outcome` (`applied`, `observed`, `no_target`, `target_invalid`) |
| `grantex_grant_revocations_total` | `action` (`revoked`, `suspended`, `resumed`), `cause` (`api`, `event`, `emergency_stop`) |
| `grantex_revocation_propagation_seconds` | `stage` (`event_to_commit`) |
| `grantex_revocation_feed_delivery_seconds` | — (commit to delivery) |
| `grantex_revocation_feed_entries_total` | `action` |
| `grantex_revocation_feed_polls_total` | `outcome` |
| `grantex_revocation_feed_subscribers` | — (live streams on this instance) |
| `grantex_revocation_feed_stale_seconds` | — (since the last successful read) |
| `grantex_emergency_stops_total` | `scope`, `outcome` (`applied`, `dry_run`, `refused`) |

Every refused delivery also logs `alert: "event_bridge_verification_failure"`
with the source id and reason, never the payload or signature. Alert rules are
in `deploy/prometheus/event-bridge-alerts.yml`.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `EVENT_BRIDGE_ENABLED` | `false` | Turns on registration and ingestion |
| `EVENT_BRIDGE_DEVELOPER_IDS` | (all) | Comma-separated developers the bridge is limited to, for a staged rollout |
| `EVENT_BRIDGE_RATE_LIMIT_PER_MINUTE` | `30000` | Ingestion requests per client address, read per request |
| `EVENT_BRIDGE_RECEIPT_RETENTION_HOURS` | `48` | Floor for how long a delivery receipt is kept; never shorter than the window in which its source would still accept the delivery |
| `VAULT_ENCRYPTION_KEY` | — | Required to register webhook sources |
| `REVOCATION_FEED_ENABLED` | `false` | Serves the revocation feed endpoints |
| `REVOCATION_FEED_DEVELOPER_IDS` | (all) | Developers the feed is limited to |
| `REVOCATION_FEED_POLL_MS` | `500` | How often an instance looks for new revocations |
| `REVOCATION_FEED_SETTLE_SECONDS` | `15` | How long an entry may still be uncommitted |
| `REVOCATION_FEED_HEARTBEAT_MS` | `1000` | How often a stream confirms it is up to date |
| `REVOCATION_FEED_MAX_CONNECTIONS` | `200` | Streams one developer may hold on one instance |
| `REVOCATION_FEED_RETENTION_HOURS` | `48` | How long delivered entries are kept after they expire |

## What this does not defend against

- A transmitter whose signing key is stolen can send events that verify.
  Scope what its events can do with mapping rules, and disable the source
  (`PATCH /v1/event-sources/<id>` with `{"status": "disabled"}`) if its key leaks.
- Events are only as timely as the sender. The bridge bounds how **old** an
  accepted event may be, not how late the sender is.
- A disabled source's events are refused, not queued: re-enable it and have
  the sender retransmit.
- A rule is only as good as the bindings behind it. A grant with no
  `subject_ref` binding is not reached by a rule that targets one; the
  delivery records `no_target` and says so in the metrics.
- Revocation stops new authorisation decisions. An SDK holding a verified
  token still needs to learn about it; see the revocation feed for how
  quickly, and what happens when it cannot.
- The feed tells an SDK what the auth service knows. An agent that does not
  use it (`revocationCheck: 'offline'`, the default) keeps calling until its
  token expires, which is why short grant lifetimes still matter.
- A revocation is bounded by the client's staleness bound, not by zero: an
  agent can make calls in the window between the revocation and the entry
  arriving. Lower `staleAfterMs` and the poll interval to narrow it; the
  measured propagation on a local stack is well under 100 ms.
