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

### `re_evaluate` — hand the decision back

Nothing about the grant changes. One audit entry per grant is written and a
`grant.re_evaluation_requested` event is emitted to the developer's webhooks
and event stream, carrying the grant ids, the event id and type, the rule id
and the event's subject. The relying platform decides what to do.

## Audit records

Every action writes an entry to the developer's audit hash chain:

| Action | Audit action | Metadata |
|---|---|---|
| Revoke | `grantex.grant.revoked` | `grant_id`, `root_grant_id`, `depth`, `cascade`, `cause`, `trigger`, `reason?`, `event_id?`, `rule_id?`, `source_id?` |
| Suspend | `grantex.grant.suspended` | as above |
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
| Same id, different payload | `401 {"err": "event_id_reused"}` | No |
| Earlier delivery failed while processing | processed again | Yes (actions are idempotent) |

A replay outside the webhook window, or of a SET older than `maxAgeSeconds`,
is refused before it reaches the replay store.

## Responses

- `202 {"status": "unmapped" | "applied" | "observed" | "duplicate"}`
- `401 {"err": "<reason>", "description": "…", "code": "EVENT_UNVERIFIABLE"}` for
  every verification failure, including an unknown or disabled source (so
  source ids cannot be probed)
- `415` for the wrong media type
- `404` when the bridge is off for the source's developer
- `5xx` when processing failed; the receipt is left `failed` so the sender's
  retry is processed again

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

Every refused delivery also logs `alert: "event_bridge_verification_failure"`
with the source id and reason, never the payload or signature. Alert rules are
in `deploy/prometheus/event-bridge-alerts.yml`.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `EVENT_BRIDGE_ENABLED` | `false` | Turns on registration and ingestion |
| `EVENT_BRIDGE_DEVELOPER_IDS` | (all) | Comma-separated developers the bridge is limited to, for a staged rollout |
| `EVENT_BRIDGE_RATE_LIMIT_PER_MINUTE` | `30000` | Ingestion requests per source and client address |
| `VAULT_ENCRYPTION_KEY` | — | Required to register webhook sources |

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
