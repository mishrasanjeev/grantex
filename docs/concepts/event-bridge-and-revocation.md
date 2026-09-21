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

## Observability

| Metric | Labels |
|---|---|
| `grantex_event_bridge_events_received_total` | `source_type` |
| `grantex_event_bridge_events_verified_total` | `source_type` |
| `grantex_event_bridge_verification_failures_total` | `source_type`, `reason` |
| `grantex_event_bridge_events_unmapped_total` | `source_type` |
| `grantex_event_bridge_events_duplicate_total` | `source_type` |

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

## What this does not defend against

- A transmitter whose signing key is stolen can send events that verify.
  Scope what its events can do with mapping rules, and disable the source
  (`PATCH /v1/event-sources/<id>` with `{"status": "disabled"}`) if its key leaks.
- Events are only as timely as the sender. The bridge bounds how **old** an
  accepted event may be, not how late the sender is.
- A disabled source's events are refused, not queued: re-enable it and have
  the sender retransmit.
