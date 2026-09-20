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

### Where the entries come from

Database triggers on `grants` and `grant_tokens`, not from each revocation
path. Every way a grant stops — `DELETE /v1/grants/:id`, a cascade from a
provider event, an emergency stop, a consent withdrawal, an anomaly, a DPDP
erasure, OAuth revocation — writes a feed entry in the same transaction as the
revocation itself. `pg_notify` wakes the receivers on commit; each instance
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

## Observability

| Metric | Labels |
|---|---|
| `grantex_event_bridge_events_received_total` | `source_type` |
| `grantex_event_bridge_events_verified_total` | `source_type` |
| `grantex_event_bridge_verification_failures_total` | `source_type`, `reason` |
| `grantex_event_bridge_events_unmapped_total` | `source_type` |
| `grantex_event_bridge_events_duplicate_total` | `source_type` |
| `grantex_revocation_feed_delivery_seconds` | — (commit to delivery) |
| `grantex_revocation_feed_entries_total` | `action` |
| `grantex_revocation_feed_polls_total` | `outcome` |
| `grantex_revocation_feed_subscribers` | — (live streams on this instance) |
| `grantex_revocation_feed_stale_seconds` | — (since the last successful read) |

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
- The feed tells an SDK what the auth service knows. An agent that does not
  use it (`revocationCheck: 'offline'`, the default) keeps calling until its
  token expires, which is why short grant lifetimes still matter.
- A revocation is bounded by the client's staleness bound, not by zero: an
  agent can make calls in the window between the revocation and the entry
  arriving. Lower `staleAfterMs` and the poll interval to narrow it; the
  measured propagation on a local stack is well under 100 ms.
