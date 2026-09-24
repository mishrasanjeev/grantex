# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Integration tests keep off the shared database
- The auth-service suite fails if any test file created tables in the shared
  integration database (`AUDIT_INTEGRATION_DATABASE_URL`) rather than a
  database of its own. Every test can pass while the run fails, with a message
  naming the tables and `createTestDatabase`. The per-file databases that
  removed the migration deadlock were a convention; this enforces it.
  FINDINGS G-30.
- Test-only; no product change, no schema change, nothing behind a flag.

### Transaction handles stay transaction handles
- Every `sql.begin(...)` callback in the auth service types its handle as a
  transaction, and the query-only helpers those callbacks reach take that type
  rather than the pool's. Widening a transaction back to the pool type put
  `begin` within reach again, and a nested transaction throws
  `sql.begin is not a function`, aborts the caller's transaction and rolls its
  work back — which is how a cascade revocation once left grants active while
  reporting success. FINDINGS G-27.
- `queries()`, which presents the pool to those helpers, no longer offers a
  `savepoint` the pool does not have: reaching for it throws where the mistake
  is made rather than inside postgres.js.
- Types and one wrapper; no behaviour change, no schema change, nothing behind
  a flag.

### Outbound HTTP
- `safeFetch` frames a request body with `Content-Length`. Without it node
  sends the body with `Transfer-Encoding: chunked`, which is valid HTTP/1.1 but
  which plenty of servers, gateways and filtering proxies refuse on a POST - an
  OpenID Connect token endpoint among them, so an approver's sign-in for a
  decision grant could fail at the token exchange against such a provider. The
  length is always known, because the body is materialised before the request
  is made; an explicit `Content-Length` or `Transfer-Encoding` is left alone.

### Decision grants
- **`POST /v1/decisions/consume` now returns the grant identifier alongside
  each approver (`approvers[].jti`).** A platform that records who decided
  needs the pair, and the response gave it two arrays it could only line up by
  position - which is not safe: `jtis` is in the order the caller presented the
  tokens, while `approvers` is ordered by approval position, so for a four-eyes
  decision the two can genuinely disagree and a platform pairing them by index
  can attribute a grant to the wrong approver. The audit entry written in the
  same transaction already recorded the pair; the response was the same
  projection minus `jti`, and is now identical to it. Additive: every existing
  field is unchanged.

### Revocation feed: fewer entries, and a poll that does not nest
- Deleting an already-revoked grant's tokens no longer writes a second feed
  entry. Cascade revocation sets `grants.status` and leaves
  `grant_tokens.is_revoked` alone, so when `DELETE /v1/agents/:id` later
  removed the rows, the grant trigger correctly skipped the grant while the
  token trigger wrote a `token_revoked`/`deleted` entry for a credential the
  feed had already reported. Clients were told twice about something already
  revoked, and the feed re-inflated exactly while the prune worker was trying
  to bound it. Migration `116_revocation_feed_deletion_skip.sql` replaces the
  trigger function; it touches no table.
- The hub drains a backlog in a loop instead of calling itself. A full page
  used to re-enter the poll from inside itself, so a backlog of N entries
  nested N/`MAX_PAGE` promise frames — and a backlog is what a large cascade
  or an emergency stop produces. It is also bounded per call, so one
  developer's backlog cannot hold the event loop; the remainder is picked up
  on a later turn, on a timer the hub tracks and `stop()` clears.
- The drain only reads again when the cursor actually moved. `settledCursor`
  ignores entries younger than the settle window, so a large cascade — every
  entry brand new — left the cursor where it was while the page stayed full,
  and the loop re-read the same thousand rows for the whole window (1779 pages
  and 3558 round-trips over 15 s for one developer with a 2500-entry backlog,
  measured). The 500 ms poll interval owns that retry now. Delivery was always
  correct; the cost was load, on the path that has to deliver revocations
  within two seconds.
- `grantex_revocation_feed_polls_total` still counts polls, not pages, now
  that a poll can read several pages.
- FINDINGS **G-26** records that the settle window measures insert time rather
  than commit time.

### Revocation feed: no revocation lost, no stale suspension after a reconnect
- A poll that failed part way through could lose a revocation. `readSince`
  succeeded, the entries were marked delivered, then `settledCursor` threw —
  so nothing was sent, and the next successful poll filtered those entries out
  as already delivered and could advance the cursor past them. Nobody was ever
  told, while the stream's heartbeats kept reporting the feed healthy. Every
  query a poll needs now runs before any state changes.
- Both SDKs replace their in-memory set from a snapshot instead of applying it
  on top. A snapshot is the complete list of what is revoked or suspended
  *now*, so merging kept anything resumed while the client was disconnected: a
  grant suspended, then resumed during the outage, stayed denied until it
  expired. The new set is swapped in only after every page has arrived, so a
  failure part way through leaves the previous one intact.
- A revocation stream whose replay failed decremented the per-developer
  connection count without marking itself closed, so a later `close` event
  decremented it again and the cap drifted upwards. One cleanup path now
  handles every way a stream ends.

### Release versions for the SDKs
- `@grantex/sdk` 0.6.0 -> 0.7.0, `grantex` (Python) 0.5.1 -> 0.6.0, `@grantex/cli`
  0.3.0 -> 0.4.0, `@grantex/x402` 0.4.0 -> 0.4.1 and the Go SDK 0.3.0 -> 0.4.0.
  The published 0.6.0 and 0.5.1 packages predate decision grants and evidence
  packages, so the code in this repository could not be released under those
  numbers: npm and PyPI refuse to replace a published version.
- `@grantex/cli` now requires `@grantex/sdk >= 0.7.0`, the first version with the
  evidence module it loads. Publish the SDK before the CLI.
- `Publish primary SDKs` reads every version from its manifest instead of
  repeating literals in step names, assertions, artifact paths and the Go tag,
  and refuses to start when a version is already on npm or PyPI, naming the
  manifest to bump.

### Evidence export in the auth service
- **Breaking:** `POST /v1/audit/log` now refuses actions starting with
  `evidence.`, `decision.` or `grantex.` (`400 AUDIT_ACTION_RESERVED`) and
  metadata members starting with `grantex:` (`400 AUDIT_METADATA_RESERVED`).
  Those names are written only by the platform; accepting them from tenants
  would let a tenant forge an evidence anchor or a decision record.
- New `POST /v1/evidence/cases/{caseId}/records` (run context, tool calls,
  policy evaluations, recommendations, dispositions), off by default
  (`EVIDENCE_EXPORT_ENABLED`). Records are validated completely when written,
  including references to earlier records, the grant chain and grant
  validity; idempotent on their ids (same content: no-op, different: `409`);
  and stored as platform-authored audit entries in server recording order.
  `POST /v1/evidence/cases/{caseId}/void` withdraws a record without deleting it.
- New `POST /v1/evidence/cases/{caseId}/export`: re-verifies each source audit
  entry's hash and link, takes decisions only from the decision-grant store,
  marks records made after a consumption or export as late, derives the case
  state, keys identifiers and content per case, anchors the root as a
  platform audit entry (subject to plan limits), optionally signs root and
  anchor with the platform key, and returns the root and anchor in headers.
  Disclosure needs `EVIDENCE_DISCLOSURE_DEVELOPER_IDS`.
- Tampered or unlinked source entries return `409
  EVIDENCE_CHAIN_VERIFICATION_FAILED`, increment
  `grantex_evidence_chain_verification_failures_total` and raise the alert
  (`deploy/prometheus/evidence-alerts.yml`); export duration is
  `grantex_evidence_export_duration_seconds`.
- Migrations 099 and 100 add the `evidence_records`, `evidence_cases` and
  `audit_entry_counters` tables and a counter trigger on `audit_entries`,
  created with a two-second lock timeout so startup is never blocked. Invalid
  evidence settings stop the service at startup.

### Evidence CLI
- `grantex evidence verify package.json --root <root>` in `@grantex/cli`, and
  `grantex-evidence verify` in the Python SDK (a separate name so it does not
  clash with the npm `grantex` binary): exit 0 only when the package verifies,
  1 on any break with entry, field, expected and actual values, 2 on usage
  errors including a missing or malformed `--root`. The output states the
  trust basis: anchor internal-consistency-only, pinned or covered by the
  verified service signature. `--anchor`, `--require-anchor`, `--jwks`,
  `--require-signature`, `--skip-signature`, `--max-bytes`, `--json`.
- `grantex evidence export <caseId>` / `grantex-evidence export` verify the
  exported package against the returned root and anchor before writing it.
- `@grantex/cli` loads the evidence module lazily and starts with an
  `@grantex/sdk` that lacks it, reporting that evidence needs
  `@grantex/sdk >= 0.7.0`; the dependency floor is raised when that SDK is
  released. The command-count test changes to 33.
- Python: `grantex.evidence.record_evidence` (batches of 100),
  `void_record` and `export_package` call the evidence endpoints.

### Evidence package library
- New `grantex.evidence` (Python) and `evidence` namespace of `@grantex/sdk`
  (also `@grantex/sdk/evidence`): build, canonicalise and verify evidence
  packages (`spec/evidence-package.md`) with identical results in both
  languages for every case in `spec/examples/evidence/`.
- Verification requires a trusted root, fails closed and reports the exact
  failing link; it enforces privacy keying, entry authority, recording order,
  clock skew, grant and decision validity windows, complete single-use
  consumptions, unsourced-input marking and void records, and reports the
  anchor and signature trust status.
- Builders key `principal`, `approver`, `subject`, `record` identifiers and
  `content` digests per case (JCS-array HMAC derivations) and replace
  `action_hash` with a keyed `action_ref` while the subject is pseudonymised.
- Canonicalisation uses the shared RFC 8785 implementation
  (`grantex.canonical`, `canonical.ts`).

### Evidence package format
- New specification of the per-case evidence package, format 1.0
  (`spec/evidence-package.md`), JSON Schema
  (`spec/evidence-package-1.0.schema.json`) and shared examples and test cases
  (`spec/examples/evidence/`): grant chain, tool calls with keyed content
  digests and upstream record references, run context, policy evaluations,
  recommendations, screening dispositions, decisions and consumptions,
  revocations and voids; every entry records who asserted it and when it was
  recorded; hash chain, platform anchor and service signature over root and
  anchor.
- Private by default: identifiers, record references and content digests are
  keyed per case, with operator-approved disclosure.
- New concepts page `docs/concepts/evidence-and-verification.md`.

### Migrations are applied once per database
- `runMigrations` keeps a `schema_migrations` ledger (filename, checksum,
  applied-at) and applies each file at most once. Until now every process start
  re-executed all migration files; they are idempotent, so the result was
  correct, but ten of them are `ALTER TABLE grants ADD COLUMN IF NOT EXISTS …`
  and Postgres takes the `ACCESS EXCLUSIVE` lock **before** evaluating
  `IF NOT EXISTS` — a no-op statement still queued behind any in-flight
  transaction on `grants`, and every reader arriving after it queued behind
  that request. On a rolling deploy the starting instance could stall the
  running instance's authorization path. A start with nothing to apply now
  issues no DDL at all. FINDINGS G-18.
- The applying session sets `lock_timeout` (`MIGRATION_LOCK_TIMEOUT`, default
  `2s`) and retries a few times, so a boot that cannot take a lock fails
  loudly instead of stalling a table, then resets it before the connection
  returns to the pool so no application statement inherits it. The value is
  validated at startup rather than on the first boot with something pending.
  A file whose content changed after it was applied is reported and never
  re-applied; so is a ledger row whose file is no longer on disk, because a
  renamed migration counts as pending and runs again.
- An index a cancelled `CREATE INDEX CONCURRENTLY` left `INVALID` is dropped
  before its migration is retried; `CREATE INDEX CONCURRENTLY IF NOT EXISTS`
  matches such an index by name and would otherwise never rebuild it. The
  repair runs per file and on every attempt, and a file is **not** recorded in
  the ledger while one of its indexes is invalid — otherwise a build that
  timed out mid-attempt would be skipped by its own retry, recorded as
  applied, and never looked at again, leaving an index unusable for reads and
  still maintained on every write.
- New `node dist/cli/migrate-baseline.js` records every migration file as
  applied **without executing any of them**, for a database already at head
  that has no ledger. It verifies that precondition itself rather than trusting
  the operator: every `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD
  COLUMN IF NOT EXISTS` in the migration files must already exist in the
  database, or it refuses and names what is missing. Recording a file as
  applied means no later start ever applies it, so baselining a partly
  migrated database would leave the service on an incomplete schema for ever.
  `--dry-run` prints the verdict, writes nothing at all — not even the ledger
  table — and exits non-zero when the database is not at head, so it can gate
  a deploy script. On a database that is not at head it prints what is missing
  and *not* the count of files a baseline would record, which is the number a
  reader would otherwise latch onto.
- The migration summary is logged and counted (`grantex_migrations_total`) by
  both callers instead of being discarded.
- **Upgrade note:** on an existing database, run
  `node dist/cli/migrate-baseline.js` against it immediately before deploying
  this release; the deploy's first start then applies nothing. Without it that
  first start applies every file once (that is what fills the ledger, and all
  files are idempotent) — safe, but it fails the boot if a transaction is
  holding a row in `grants` past `MIGRATION_LOCK_TIMEOUT`, which means a
  retried deploy. See `docs/self-hosting.md` section 6.
- `runMigrations` now returns a summary (`applied`, `skipped`, `changed`,
  `repairedIndexes`) instead of `void`.

### Breaking changes from 0.5 (summary)
`docs/migration-0.6.md` explains each item and what to do. Manifests,
purpose-bound grants, caps, signing and claims each have their own entry
below.

- **Manifests.**
  - Object-form tool declarations are validated strictly.
  - Manifest files with a duplicate key are rejected.
  - `cost_units` is a reserved tool name.
  - `enforce()` denies calls it cannot evaluate: a tool with
    `allowed_purposes` needs a matching grant purpose, a tool with
    `requires_decision` needs decision grants (`decision_required` without
    them), and a tool with
    caps needs a caps meter.
- **Purpose-bound grants.**
  - `POST /v1/authorize` rejects an unknown `purpose`, or a purpose without a
    connector scope, with `INVALID_PURPOSE`.
  - `enforce()` denies every call on a token with malformed
    `authorization_details`.
  - `enforce()` applies a tools entry's `tools` list.
- **Caps.** Grant caps with wildcard or unknown keys, windows or counts deny
  every call on the connector. Units are not refunded when a call fails.
- **Signing.**
  - Key ids are RFC 7638 thumbprints. The RSA key is also published under
    the pre-0.6 `grantex-YYYY-MM` kids, which the auth service still
    accepts, so outstanding tokens keep verifying across months and
    instances.
  - Tokens may be ES256 when a deployment sets `JWT_SIGNING_ALG=ES256`, so
    verifiers that pin RS256 must allow ES256 first.
  - Switching to the postgres key store imports the env keys with the same
    kids.
  - SDK verifiers refuse a key whose type, curve, `alg` or `use` does not
    match the token's algorithm.
  - The auth service refuses to start with an RSA key under 2048 bits, a
    non-P-256 EC key, an invalid verification key set, or (postgres store) a
    retired-key grace shorter than `MAX_GRANT_LIFETIME_SECONDS`.
- **Claims.**
  - `GRANT_TOKEN_LEGACY_CLAIMS` keeps the `agt`, `dev`, `grnt`, `scp`,
    `parentAgt`, `parentGrnt`, `delegationDepth` and `bdg` aliases in tokens.
    It is on for 0.6 and **defaults to off in 0.7**, and SDK verifiers stop
    reading the aliases by default in 0.7.
  - Delegated `act` claims are nested.
  - A 0.6 token whose standard claim and alias disagree is refused; pre-0.6
    tokens are read from `scp`.
  - SDK verifiers refuse null or mistyped claims.
  - New authorization requests refuse scopes containing whitespace. Existing
    such grants keep working, but their tokens omit `scope`.
  - `enforce()` honours decision references in the grant.
  - TypeScript `GrantTokenPayload.agt`, `dev` and `scp` are optional and
    deprecated.

### Migration guide
- `docs/migration-0.6.md` covers every break from 0.5 to 0.6. It gives an
  upgrade order (verifiers first, then the auth service, then new features,
  then turning off legacy claims before 0.7), plus the database migrations,
  the new settings and a checklist.

### Event bridge: ingestion hardening
- Every unverifiable delivery now answers one opaque `401 {"err":
  "unverifiable"}`, including a source whose developer is outside
  `EVENT_BRIDGE_DEVELOPER_IDS`, which used to answer `404` and so was a
  source-existence oracle in exactly the staged rollout the docs recommend.
  Distinguishing an unknown source from a bad signature from a stale timestamp
  told anyone who could reach the endpoint which source ids exist and how far a
  guess had got. The precise reason stays in the log and in the `reason` label
  of the failure counter. The response *body* is what is indistinguishable: a
  real id still costs more time than an invented one, which the concepts page
  now says. **Break:** a sender that matched on the previous `err` values sees
  `unverifiable` instead.
- Ingestion rate limiting is keyed on the client address alone. Including the
  source id let an attacker mint a fresh bucket per made-up id — the bypass the
  default limiter already documents for bearer tokens — and
  `EVENT_BRIDGE_RATE_LIMIT_PER_MINUTE` is now read per request rather than once
  at boot, as its documentation said.
- An hourly worker prunes `event_bridge_receipts`, but only once a receipt is
  older than the window in which its own source would still accept that
  delivery, and never sooner than `EVENT_BRIDGE_RECEIPT_RETENTION_HOURS`
  (default 48): pruning earlier would re-open the replay window the receipt
  exists to close. That window is **twice** `toleranceSeconds` — the webhook
  timestamp check is two-sided, so a delivery timestamped in the future stays
  acceptable until `received_at + 2 × tolerance` — or `maxAgeSeconds` plus
  twice the clock skew for a SET. Raising a source's tolerance later widens the
  window only for new deliveries; rotate its secret at the same time, because
  receipts already pruned cannot come back.
### Revocation reliability
- Revocation transactions (cascade, suspend, resume and re-evaluation) retry on
  `deadlock_detected`, `serialization_failure` and `lock_not_available` instead
  of failing. A revocation competes with delegation, token refresh and — during
  a rolling deploy — the startup migrations, and Postgres raises those errors
  precisely because retrying is the right answer. See FINDINGS G-18.

### Event bridge: review fixes
- Credentials issued for a grant are revoked **in the same transaction** as the
  grant. Fire-and-forget left a status-list bit and a credential row untouched
  whenever the call failed, and because the delivery that caused it was already
  finalised, every retry was a duplicate — the credential stayed verifiable
  after its grant was revoked.
- A target that resolves a parent and its delegated children (a principal or an
  agent) now makes **one** suspension rooted at the top-most grant, instead of
  one per grant; resuming the top-level grant restores the whole subtree. A
  grant already held by an earlier suspension is never moved into a later one,
  so resuming the later one cannot resurrect it.
- Every action carries the context of the event that matched it. A Security
  Event Token carrying several events used to label every revocation with the
  first member's type, and re-evaluation entries inherited that type while
  carrying another event's subject.
- Re-evaluation is at most once per source, event and rule
  (`event_bridge_rule_actions`, migration 115, claimed in the same transaction
  as the audit entries). Revoking and suspending are idempotent; asking the
  relying platform to look again was not, so a retried delivery asked twice.
- The subject copied into the audit chain and the outbound event is bounded:
  scalar members with plain keys, values truncated at 256 characters, at most
  20 members, and `subject_truncated` when anything was dropped. It is
  provider-supplied and was written verbatim.
- Webhook subscriptions accept every event type the platform publishes. The
  route's list was three hardcoded values, so a developer could not subscribe
  to `grant.suspended`, `grant.resumed` or `grant.re_evaluation_requested`
  although they are delivered; both the validation and the error message are
  now derived from `EVENT_TYPES`, with a test that every publishable type is
  subscribable.
- `PUT /v1/grants/:id/subject-refs` checks the grant inside the transaction
  that writes the bindings, holding the row.

### Event bridge: mapping rules and cascade revocation
- Declarative mapping rules per developer (PRD G-6) turn a verified event into
  one action: `POST/GET /v1/event-mapping-rules`, `GET/PATCH
  /v1/event-mapping-rules/:id`. A rule names an event type (exact or a `*`
  prefix), up to ten conditions over paths inside the event, a target
  (`grant_id`, `principal_id`, `agent_id` or a `subject_ref` binding) and one
  action: `suspend`, `revoke` or `re_evaluate`. `mode: observe` records what a
  rule would have done and changes nothing.
- `PUT/GET /v1/grants/:id/subject-refs` binds the identifiers a grant was
  issued for (business reference, case id) so events about a subject resolve to
  it. Bindings on a parent grant cover everything delegated beneath it.
- `revoke` cascades: the grant and every grant delegated beneath it, to any
  depth, are revoked in one transaction, wallet reservations released,
  credentials revoked, one audit entry per grant appended to the developer's
  hash chain, and `grant.revoked` emitted. It takes the same per-developer lock
  as delegation, so a child delegated during a cascade is either included or
  never created.
- `suspend` is reversible revocation (new grant status `suspended`, which every
  authorisation check treats as inactive); `POST /v1/grants/:id/resume`
  restores exactly the grants one suspension suspended, refuses while an
  ancestor is revoked or suspended, and keeps working when the event bridge is
  off. `re_evaluate` changes nothing and emits
  `grant.re_evaluation_requested` to the relying platform.
- Actions of one developer can never reach another developer's grants: every
  resolution and update is scoped by `developer_id`, and a rule may only name
  an event source of its own developer.
- Audit actions `grantex.grant.revoked`, `grantex.grant.suspended`,
  `grantex.grant.resumed` and `grantex.grant.re_evaluation_requested` carry the
  cause, the trigger in the evidence-package vocabulary, the root grant and the
  depth. The `grantex.` prefix and the `grantex:platform` marker stay refused on
  `POST /v1/audit/log`, so a tenant cannot forge one.
- New events `grant.suspended`, `grant.resumed` and
  `grant.re_evaluation_requested` for webhooks and the event stream.
- Metrics `grantex_event_bridge_rule_matches_total{action,mode}`,
  `grantex_event_bridge_actions_total{action,outcome}`,
  `grantex_grant_revocations_total{action,cause}` and
  `grantex_revocation_propagation_seconds{stage}`, with alert rules for slow
  event-driven revocation, unreadable targets and revocation bursts.
- Migration `111_event_mapping_rules.sql` adds three tables (mapping rules,
  subject bindings and the suspension bookkeeping); it alters no existing
  table, and nothing reads them with the flag off.

### Revocation reliability
- Revocation transactions (cascade, suspend, resume, re-evaluation and the
  emergency stop summary) retry on `deadlock_detected`,
  `serialization_failure` and `lock_not_available` instead of failing. A
  revocation competes with delegation, token refresh and — during a rolling
  deploy — the startup migrations, and Postgres raises those errors precisely
  because retrying is the right answer. See FINDINGS G-18.

### Emergency stop
- `POST /v1/emergency-stop` (developer API key, own tenant) and
  `POST /v1/admin/emergency-stop` (`ADMIN_API_KEY`, any tenant) halt every
  agent under a grant, an agent, a principal or a whole developer (PRD G-6,
  US-5). Off unless `EMERGENCY_STOP_ENABLED=true`.
- `confirm` must repeat exactly `stop <type>:<id>`; anything else is refused
  with `412 CONFIRMATION_REQUIRED` before anything is revoked. The expected
  phrase is not echoed back — handing it over defeats the confirmation.
  `dryRun: true` reports how many grants the scope covers and revokes nothing,
  and the rehearsal is itself recorded with `dry_run = TRUE`, so
  `GET /v1/emergency-stops` shows who measured a tenant's blast radius and
  when. A developer key can only ever stop its own grants; an operator call
  records the address it came from, never the key.
- The stop sweeps: it revokes what the scope covers, then re-reads the scope
  until it comes back empty (up to five passes), so a grant delegated while it
  runs is caught. It is **not** a lockout — the same credential can mint a new
  grant immediately afterwards, the response says `lockout: false`, and the
  runbook gives the order (rotate the credential, then stop).
- The `emergency_stops` record is updated as each batch completes and carries a
  `status` (`running`, `completed`, `incomplete`, `failed`), the number of
  sweeps and the error, so a stop that failed part way through can never read
  as though nothing happened.
- Underneath it is a cascade revocation per matched grant, so a stop appears in
  the audit hash chain (one `grantex.grant.revoked` per grant with cause
  `emergency_stop`, plus a `grantex.emergency_stop` summary) and on the
  revocation feed, and SDKs in feed mode deny the agents' next calls.
  `GET /v1/emergency-stops` lists what was stopped, when, by whom and why.
  `agentsStopped` names at most 100 agents; `agentsStoppedTruncated` and
  `agentsStoppedTotal` say when that list was cut and how many there really
  were, in the response and in the permanent audit summary.
- Every grant the scope covers is revoked, including **suspended** ones, and
  the bookkeeping a resume needs goes with them: a suspension pending an
  investigation cannot be resumed after a stop over its scope. The runbook
  says so, alongside what a stop cannot reach at all (decision grants and
  passports already issued, work already in flight, agents watching neither
  the feed nor the status endpoint).
- Release test: `tests/e2e/emergency-stop.test.ts` runs agents at three depths
  of a delegation chain plus one that checks revocations `online` rather than
  through the feed, stops them with one call, cross-checks the reported count
  against the grants the API listed as live, asserts every agent's next call is
  denied within two seconds, and asserts that a grant minted afterwards is
  live — because the stop is a sweep, not a lockout; `scripts/revocation-release-test.sh` runs it
  beside the propagation measurement. A second case delegates grants **while**
  a stop is running and asserts nothing is left live, which is the property
  sweeping exists for.
- The revocation retry backs off with full jitter, so two transactions that
  deadlocked against each other do not collide again on the retry.
- The propagation harnesses now fail when the revoke call *itself* takes more
  than `REVOCATION_REVOKE_CALL_BUDGET_MS` (default 10 s). Propagation is timed
  from when that call returns, so a throttled call used to be printed and
  passed over — on the containment path (FINDINGS G-23). Any latency figure
  from a run is environment-specific: an independent reviewer measured p95
  100–506 ms where this checkout's machine measured tens of milliseconds. The
  release test asserts the requirement, not a number.
- Runbook: section 11 of `docs/self-hosting.md` (rehearsal, blast radius, what
  to do when an agent keeps running, and what to do if the API is
  unreachable). Metric `grantex_emergency_stops_total{scope,outcome}` with an
  alert rule; migration `113_emergency_stops.sql` adds one table, and adds its
  later columns with `ALTER TABLE … ADD COLUMN IF NOT EXISTS` rather than
  inside the `CREATE TABLE IF NOT EXISTS`, which a database that already had
  an earlier version of the table would skip whole.
- FINDINGS **G-22** records the lockout gap as a tracked follow-up: the stop
  revokes what exists and does not stop new grants being issued, which is
  disclosed everywhere but is still a design gap. FINDINGS **G-23** records
  that `DELETE /v1/grants/:id` and the stop share the plan rate-limit bucket,
  so containment is throttled like ordinary traffic on the free plan.

### Revocation feed: SDKs see revocations within seconds
- `enforce()` verifies a grant token offline, so a revoked grant's token stays
  valid until it expires. The revocation feed (PRD G-6) closes that gap, off
  unless `REVOCATION_FEED_ENABLED=true` (optionally limited with
  `REVOCATION_FEED_DEVELOPER_IDS`); with the flag off every route answers 404
  and nothing else changes.
- `GET /v1/revocations` serves a paged snapshot of everything currently revoked
  or suspended with the cursor to stream from, or the changes after a cursor
  (ETag, `304`, optional `wait` long-poll); `GET /v1/revocations/stream` is a
  Server-Sent Events stream of `revocation` entries with a heartbeat every
  second; `GET /v1/revocations/status` answers for one grant or token.
- Both SDKs gain `revocationCheck` / `revocation_check`: `offline` (default,
  unchanged behaviour), `feed` (an in-memory set kept current by the feed) and
  `online` (a check per call), settable per client or per call.
  `RevocationFeed`, `RevokedSet` and the feed state are exported from both.
- **Failing closed is the point.** A feed that has not heard from the auth
  service inside its staleness bound (`staleAfterMs` /
  `revocation_feed_stale_after`, default 5 s) denies every call with
  `grant_revoked` and sub-reason `feed_stale`; a deployment that does not serve
  the feed gives `feed_unavailable`; an online check that cannot be completed
  gives `status_unavailable`; a grant the auth service does not recognise is
  refused. New `RevocationSubReason` in both SDKs (`revoked`, `suspended`,
  `parent_revoked`, `feed_stale`, `feed_unavailable`, `status_unavailable`).
- Feed entries are written by database triggers on `grants` and `grant_tokens`
  — on status changes and on deletion — so every revocation path (API, cascade,
  emergency stop, consent withdrawal, anomaly, DPDP erasure, OAuth revocation,
  and the hard delete behind `DELETE /v1/agents/:id`) reaches the feed in the
  same transaction as the revocation. `pg_notify` wakes receivers on commit and each
  instance also polls, so a lost notification costs latency, not correctness.
  When the triggers are missing the endpoints answer `503 FEED_UNAVAILABLE`
  rather than an empty feed.
- The cursor never advances past entries younger than
  `REVOCATION_FEED_SETTLE_SECONDS` (default 15 s), so a transaction that
  committed out of sequence order is still delivered, and never past the page a
  response actually carried, so a client cannot skip the remainder of a large
  cascade while believing itself up to date.
- An hourly worker prunes feed entries once the credential they are about has
  been expired longer than `REVOCATION_FEED_RETENTION_HOURS`.
- `scripts/revocation-release-test.sh` measures the G-6 acceptance criterion
  against a real auth service with Postgres and Redis: revoke a parent grant,
  time how long the child keeps being authorised, through both SDKs.
- Metrics `grantex_revocation_feed_delivery_seconds`,
  `grantex_revocation_feed_entries_total{action}`,
  `grantex_revocation_feed_polls_total{outcome}`,
  `grantex_revocation_feed_subscribers` and
  `grantex_revocation_feed_stale_seconds`, with alert rules in
  `deploy/prometheus/revocation-feed-alerts.yml`.
- Python `SignupParams` accepts `mode` (`live` or `sandbox`), matching the
  TypeScript SDK.
- Migration `112_revocation_feed.sql` adds one table and two triggers; no
  existing table gains a column.

### Event bridge: signed event ingestion
- The auth service accepts provider events (PRD G-6), off unless
  `EVENT_BRIDGE_ENABLED=true` (optionally limited with
  `EVENT_BRIDGE_DEVELOPER_IDS`). With the flag off every new route answers
  `404` or `403 FEATURE_DISABLED` and nothing else changes.
- `POST/GET /v1/event-sources`, `GET/PATCH /v1/event-sources/:id` and
  `POST /v1/event-sources/:id/rotate-secret` register per-developer sources:
  SSF/CAEP transmitters (issuer, audience, inline JWK Set or `jwksUri`,
  algorithm allow list, maximum age) and generic signed webhook senders
  (secret returned once, stored encrypted with `VAULT_ENCRYPTION_KEY` and bound
  to the source; rotation keeps the previous secret for a grace period, or
  none).
- `POST /v1/event-bridge/ssf/:sourceId` receives Security Event Tokens
  (RFC 8417, RFC 8935 push): `typ` `secevent+jwt`, allow-listed algorithm,
  signature, `iss`, `aud`, `iat` window, `exp`, `jti` and `events` are all
  verified. `POST /v1/event-bridge/webhooks/:sourceId` receives JSON events
  signed with `X-Grantex-Signature: sha256=HMAC(secret, "<timestamp>.<raw
  body>")` inside a replay window, the scheme of the auth service's own
  outbound webhooks.
- Unverifiable deliveries get `401 {"err": "<reason>"}`, are counted and are
  never acted on. Each event id is claimed once per source: a retransmission
  is answered `duplicate` and not acted on again; a different payload reusing
  an id is refused. Verified events that no rule maps are logged, counted and
  ignored.
- Metrics `grantex_event_bridge_events_{received,verified,unmapped,duplicate}_total{source_type}`
  and `grantex_event_bridge_verification_failures_total{source_type,reason}`;
  alert rules in `deploy/prometheus/event-bridge-alerts.yml`.
- Migration `110_event_bridge_sources.sql` adds two tables; nothing existing
  changes. Guide: `docs/concepts/event-bridge-and-revocation.md`.

### Standard grant token claims
- Grant tokens follow the OAuth profile in `spec/grant-token-0.6.md`, and a
  stock JOSE library validates them with standard semantics. The claims are
  `iss`, `sub`, `aud` (when bound), `exp`, `iat`, `jti`, `client_id` and a
  space-delimited `scope`, plus:
  - `cnf.jkt` when the agent key is bound;
  - an RFC 8693 `act` chain on delegated grants;
  - `authorization_details` (RFC 9396) with purpose, tools, caps, budget and
    the new decision references (`urn:grantex:decision:v1`);
  - Grantex's grant record fields under `urn:grantex:grant` (`grant_id`,
    `agent_did`, `developer_id`, `parent_grant_id`, `delegation_depth`).
- **Legacy aliases behind a flag.** `agt`, `dev`, `grnt`, `scp`,
  `parentAgt`, `parentGrnt`, `delegationDepth` and `bdg` are still issued,
  with the same values, while `GRANT_TOKEN_LEGACY_CLAIMS=true`. That is the
  default for 0.6. **The default flips to `false` in 0.7**, when tokens stop
  carrying the aliases.
- **Break: delegation `act` is nested.** A delegated token's `act` now nests
  the parent token's `act`, so a second-level delegation carries
  `{"sub": <parent agent>, "act": {"sub": <grandparent agent>}}` instead of
  only the parent. The chain is stored on the grant (migration
  `098_grant_actor_chain.sql`), so refreshed tokens keep it. Grants delegated
  before the migration refresh with the parent agent only, as before.
- **Break: disagreeing claims are refused.** The auth service and the SDK
  verifiers refuse a 0.6 token (one with `urn:grantex:grant`) whose standard
  claim and legacy alias disagree (for example `scope` and `scp`), and an
  `act` claim without a string `sub` or deeper than 10. Tokens issued before
  0.6 are read from `scp`, so they keep verifying.
- **Break: null claims are refused.** The SDK verifiers refuse a token with a
  `null` `urn:grantex:grant` (or member), `scope`, `scp`, `act`, `cnf`,
  `client_id`, `aud` or `authorization_details`, and a mistyped `client_id`,
  `aud` or `authorization_details`, instead of treating it as absent.
- **Break: whitespace in new scopes.** `POST /v1/authorize` refuses a scope
  containing whitespace with `400 INVALID_SCOPE`. Grants created earlier
  keep working: refresh and delegation still issue tokens, which omit
  `scope` and always carry `scp`, so standard-only readers refuse them rather
  than read a different scope set.
- **`act.sub` is the delegating agent**, not the current actor as in the
  usual RFC 8693 reading. The current actor is `client_id`. The Go SDK keeps
  any other members of `act` (`ActorClaim.Members`).
- **Proof of possession.** The SDK verifiers return `cnf` but do not enforce
  it by default. `proof_jkt` / `proofJkt` / `ProofJKT` requires `cnf.jkt` to
  match a thumbprint the caller verified, and `require_proof_of_possession` /
  `requireProofOfPossession` / `RequireProofOfPossession` fails closed without
  one.
- The auth service logs a deprecation notice at start while
  `GRANT_TOKEN_LEGACY_CLAIMS=true`.
- `spec/examples/grant-token-0.6.issued.json` holds tokens issued by the auth
  service, which the Python and Go SDK tests validate with PyJWT and
  golang-jwt.
- **SDK verifiers.** The Python, TypeScript and Go verifiers read the
  standard claims first. They fall back to an alias when the standard claim
  is absent, and report each alias used:
  - Python: a `LegacyClaimsWarning` (a `FutureWarning`).
  - TypeScript: a `DeprecationWarning` with code `GRANTEX_LEGACY_CLAIM`.
  - Go: `OnLegacyClaim` or a log line.

  `legacy_claims=False` / `legacyClaims: false` / `StandardClaimsOnly: true`
  reads standard claims only and requires `typ: at+jwt`; this becomes the
  default in 0.7. `Grantex(legacy_claims=...)` and
  `new Grantex({ legacyClaims })` pass the setting to `enforce()`.
  `VerifiedGrant` adds `act`, `cnf`, `audience` and `legacy_claims_used` /
  `legacyClaimsUsed` (Go: `Act`, `Cnf`, `Audience`, `AuthorizationDetails`,
  `LegacyClaimsUsed`).
- **Break (TypeScript types):** in `GrantTokenPayload`, `agt`, `dev` and
  `scp` are now optional and deprecated, and `scope`, `act`, `cnf`, `aud`
  and `urn:grantex:grant` are added.
- **Decision references.** `enforce()` requires a decision grant for a tool
  listed in the grant's `urn:grantex:decision:v1` entry (`decision_required`
  without one), even when the manifest does not declare `requires_decision`;
  a decision in the entry's `four_eyes_on` needs two approvers. A malformed decision entry
  denies every call with `malformed_authorization_details`. A delegated grant
  keeps the decision references of the connectors it keeps.
  `parse_decision_references` / `parseDecisionReferences` read them.
- `SPEC.md` §6 and §9, the protocol and concept pages, and the SDK
  verification pages describe the profile.

### ES256 signing
- The auth service can sign grant tokens, OAuth access tokens and its other
  platform JWTs with ES256 (EC P-256) as well as RS256. `JWT_SIGNING_ALG`
  selects the algorithm per deployment and defaults to `RS256`, so existing
  deployments are unchanged. ES256 needs `EC_PRIVATE_KEY` (PKCS#8 PEM).
- **Key ids.** Every platform signing key is published in
  `/.well-known/jwks.json` with `kid`, `alg` and `use: "sig"`.
  - A key's `kid` is its RFC 7638 thumbprint (`grantex-rs256-…`,
    `grantex-es256-…`), so all instances agree whenever they started.
  - **Behaviour change:** the RS256 key's `kid` is no longer `grantex-YYYY-MM`
    of the process start month. Tokens with that kid, or with none, still
    verify in the auth service with the RSA key (`RSA_PRIVATE_KEY`, or
    `JWT_LEGACY_KID_KEY`).
  - The JWK Set also lists the RSA key under `grantex-YYYY-MM` for the last
    `JWT_LEGACY_KID_MONTHS` (13) months, so SDK verifiers find it too.
  - For `SIGNING_KEY_ACTIVATION_DELAY_SECONDS` after start, instances still
    sign under the legacy kid.
  - The JWK Set therefore has more entries than before.
- **Env store.**
  - A configured key for the algorithm that is not signing, and every key in
    `JWT_VERIFICATION_PUBLIC_KEYS`, is published for verification only.
    Rotation is publish-then-sign and never invalidates outstanding tokens.
  - The same key listed twice counts as one key, so rotating RSA to RSA in the
    same month raises no duplicate `kid`.
- **`SIGNING_KEY_STORE=postgres`** (migration `096_platform_signing_keys.sql`).
  - Keys are stored encrypted with `VAULT_ENCRYPTION_KEY` and bound to their
    `kid` as authenticated data.
  - The first start imports the configured env keys: the env signing key
    becomes the stored active key with the same `kid`, and other keys are
    stored as retired.
  - `node dist/cli/rotate-signing-key.js [--alg ES256]` publishes a new pending
    key, which signs after `SIGNING_KEY_ACTIVATION_DELAY_SECONDS` (default
    900). The previous key is then retired with its private key erased, and
    stays published for `SIGNING_KEY_RETIRED_GRACE_SECONDS` (default 30 days).
  - Instances reload every minute and on an unknown `kid`. Periodic reloads do
    not reset the unknown-kid cooldown.
- `MAX_GRANT_LIFETIME_SECONDS` (unset by default) caps grant `expiresIn` at
  authorization and delegation. With the postgres store, start-up refuses a
  retired-key grace shorter than it, and warns when it is unset.
- SSO state HMAC keys fall back to an HKDF of `VAULT_ENCRYPTION_KEY` when no
  `SSO_STATE_SECRET` or private key is configured, so instances agree.
  Production refuses to start without any of them.
- Signing keys are validated at start: an RSA modulus of at least 2048 bits,
  EC keys on P-256 only, no private members in published keys, unique `kid`s.
- Verification everywhere (auth service, Python, TypeScript and Go SDKs) uses
  an explicit allowlist of `RS256` and `ES256` and the JWK Set key named by
  `kid` whose type matches the algorithm. `alg: none`, HS256, a key published
  for another algorithm and a `kid` naming a key of the other type are
  rejected. The SDKs add `algorithms` / `Algorithms` options that can only
  narrow the list, and export `GRANT_TOKEN_ALGORITHMS` /
  `GrantTokenAlgorithms()`.
- **Break for verifiers:** code that pins RS256 on its own (for example a
  resource server calling a JOSE library with `algorithms: ['RS256']`) rejects
  tokens from a deployment that switches to ES256. Allow both algorithms
  before an issuer switches. See `docs/migration-0.6.md`.
- The `did:web` document lists every platform signing key instead of only the
  RS256 key.

### Caps meter
- This is the metering library for spend caps. The consent-page and per-case
  display of caps and remaining budget, and the platform's per-tenant
  `caps.enforce` rollout flag, are not included yet.
- New caps meter in both SDKs (`grantex.caps`, and `CapsMeter` in
  `@grantex/sdk`) enforces per-tool call caps over rolling `per_hour` and
  `per_day` windows and `per_case`, plus cost-unit budgets. Caps come from the
  manifest (tenant-wide) and from the grant's `urn:grantex:tools:v1` entry
  (per grant, including a `cost_units` budget for the connector). Every
  applicable counter is reserved atomically, so concurrent calls cannot exceed
  a cap.
- Backends: Redis (one Lua script, tenant-scoped keys with a shared hash tag,
  server time) and Postgres (row locks and upserts on `grantex_cap_counters` /
  `grantex_cap_reservations`; create them with `SCHEMA_SQL` /
  `CAPS_SCHEMA_SQL`), plus an in-memory backend for tests only. Python and
  TypeScript share counter keys, the Lua script and the SQL. There is no
  automatic failover between backends.
- `Grantex(caps_meter=...)` / `new Grantex({ capsMeter })` meters calls in
  `enforce()`, which takes `case_id` / `caseId` and `cost_components` /
  `costComponents`. Units are reserved as the last check, and
  `EnforceResult.reservation` identifies them. Exceeding a cap denies with
  `cap_exceeded` / `limit_reached` and details carrying error code `E1008`,
  the limit and the window. A cap of zero disables a tool. A missing or
  unavailable meter denies with `meter_unavailable`, a missing case for a
  per-case cap with `case_required`.
- Failed calls are not refunded. `CapsMeter.refund_unsent()` /
  `refundUnsent()` releases a reservation only when the provider call is
  known not to have been sent.
- A tool that declares `cost_units` while the grant sets no cost-unit budget
  is now allowed when a meter is configured, because there is nothing to
  meter. It is still denied without a meter.
- Grant `caps` are validated when the token's `authorization_details` is
  read, for every call on the connector. A key must be an exact tool name or
  `cost_units`; wildcard keys such as `screen_*`, unknown windows and invalid
  counts deny with `token_invalid` / `malformed_authorization_details` instead
  of being ignored.
- **Behaviour change:** `cost_units` is reserved and rejected as a manifest
  tool name, in both object-form and strings-only manifests, because grant
  caps use it for the cost-unit budget.
- `enforce(..., reserve=False)` / `reserve: false` checks caps against
  current usage without consuming anything, and returns `cap_limits` /
  `capLimits` and `caps_tenant_id` / `capsTenantId` for a later
  `CapsMeter.reserve()`. Check early (for example when validating scopes) and
  reserve once, at the call that incurs cost.
- `caps_mode` / `capsMode` on the client or per call: `enforce` (default)
  denies, `warn` allows a call a cap would deny and reports it in
  `would_deny` / `wouldDeny` (reserving only calls that fit), and `off`
  skips caps. Malformed grant caps are denied in every mode.
- `caps_tenant_id` / `capsTenantId` overrides the tenant of a call's counters
  (default: the grant's developer).
- Postgres backend: `prune()` deletes expired reservations and empty
  counters (run it periodically); reservations use READ COMMITTED explicitly.
  Redis backend: requires Redis 6.0 or later.
- CI's `make` job runs the caps integration tests against Redis and Postgres
  service containers.

### @grantex/mcp-auth 3.0.0 (prepared, not published)
`packages/mcp-auth` is at 3.0.0 in the repository. It is **not published**;
`@grantex/mcp-auth@2.0.2` remains the current npm release. Deployment,
configuration, consent-page customisation and the migration table are in
`docs/mcp-auth.md`.

Added
- Durable state: all authorization state (client registrations, consent
  records, pending authorizations, authorization codes with their PKCE
  challenges, refresh-token bindings, revocations) goes through
  `McpAuthStorage`. `PostgresStorage` (`@grantex/mcp-auth/postgres`, migrations
  in `migrations/` recorded in a `mcp_auth_schema_migrations` ledger,
  `runMigrations()`, `purgeExpired()`) and `RedisStorage`
  (`@grantex/mcp-auth/redis`, Redis 6.2+) survive restarts and serve replicas.
  Single-use records are consumed atomically; codes, refresh tokens and
  consent ids are stored only as SHA-256 keys and client secrets as hashes.
  `InMemoryStorage` (`@grantex/mcp-auth/testing`) is for tests and refuses
  `NODE_ENV=production`.
- MCP authorization specification (2026-07-28): RFC 9728 protected-resource
  metadata; RFC 8707 resource indicators with audience binding (an upstream
  token without the matching `aud` is not returned); RFC 8414 metadata at the
  path-inserted location, advertising `authorization_response_iss_parameter_supported`
  and `client_id_metadata_document_supported`; `iss` on every authorization
  response (RFC 9207); PKCE S256 only.
- OAuth Client ID Metadata Documents with SSRF protections (public addresses
  only with connection pinning, port 443 unless `allowedPorts`, no
  redirects, size and time limits, TTL cache, optional host trust policy),
  failing closed with a reason code.
- `/revoke` also revokes refresh tokens bound to the client (RFC 7009).
- Rendered consent page before anything reaches Grantex, showing the client,
  redirect host, purpose, data region, duration, tools with caps and decision
  requirements, labelled as declared by the service; strict CSP with no
  script, CSRF token plus a per-consent `__Host-` SameSite=Strict cookie;
  customisable theme (WCAG AA contrast enforced), text, `lang`, `extraCss`
  and `renderDetails`. New `grant` and `consentPage` options.
- Confused-deputy protection: approval sets a `__Host-` Secure HttpOnly
  SameSite=Lax callback-binding cookie whose hash is stored on the pending
  authorization, and `/callback` issues a code only to the browser that
  presents it.
- `manifests` option and `toolPolicyFromManifests()`: scopes derived from
  tool manifests in the 0.5 and 0.6 form.
- Resource-server guard (`requireMcpAuth` for Express and Hono,
  `createMcpResourceGuard`): RFC 9728 challenges, revocation checks against
  the same storage, and refusal of any `tools/call` outside the grant with
  403. Tools marked `requires_decision` are refused with a `decision_required`
  challenge unless a `DecisionVerifier` accepts (and consumes) a decision
  grant, and a batch with more than one such call is refused (format:
  `spec/mcp-auth-challenges.md`). With a tools policy, a body that is not
  parsed JSON-RPC 2.0 is refused (`body_not_parsed`). `onDenial` reports
  refusals with low-cardinality reasons (`grant_revoked`, ...); a guard
  without `revocations` warns at start-up. `grant.authorizeParams` is the
  extension point for purpose-bound grants.
- Tests: storage contract against memory, real Postgres and real Redis; a
  server-process restart test on both; a conformance suite mapping each
  server-side MUST of the specification and the Security Best Practices'
  state-binding and CSRF requirements to a test (SEC-12, not forwarding the
  client's token upstream, is listed as the host's responsibility); the
  consent page in
  Chromium at 375 px with axe-core; documentation examples compiled and run.

Fixed
- The upstream token exchange sends the consent callback as `redirectUri`;
  2.x omitted it, so live exchanges with the auth service failed.
- `/revoke` records the revocation locally, so `/introspect` and the
  middleware refuse the token even if the upstream call fails.
- Concurrent redemptions of one code or refresh token can no longer both
  succeed.
- An error thrown by a downstream Hono handler is no longer turned into a 401.

Breaking changes
- `storage` is required. `clientStore`, `codeStore`, `pendingStore`,
  `refreshTokenStore`, the `*Store` types and the `InMemory*Store` classes are
  removed; `createMcpAuthServer` throws when given them.
- `ClientRegistration.clientSecret` is replaced by `clientSecretHash`; code,
  pending-authorization and refresh-binding records no longer carry their own
  key. A client record without `tokenEndpointAuthMethod: 'none'` is
  confidential, and one without a secret hash cannot authenticate.
- `resource` (or `allowedResources`) is required; tokens are always
  audience-checked at `/introspect` and `/revoke`.
- `issuer` must be https (http only on localhost) with no query or fragment.
- `GET /authorize` returns the consent page (200 HTML) instead of a 302 to
  Grantex; the flow continues with `POST /consent`, which answers 303.
- `/callback` answers 403 unless the browser presents the callback-binding
  cookie set when it approved consent.
- `requireMcpAuth` requires `audience` and throws without it; its 401 and 403
  responses carry `WWW-Authenticate`.
- Requested scopes outside `scopes_supported` are refused with
  `invalid_scope`.
- `/register` refuses redirect URIs that are neither https nor loopback http,
  a `client_name` that is not 1-200 characters, and `grant_types` other than
  `authorization_code` with optional `refresh_token`.
- A refresh that returns the same refresh token no longer hands it out
  again; the response omits `refresh_token`.
- Upstream consent errors other than `access_denied` reach the client as
  `server_error`; upstream error text is not forwarded, including in
  `error_description` from `/authorize` and `/token`.
- Metadata documents are fetched only from port 443 unless
  `clientIdMetadataDocuments.allowedPorts` allows another.
- With a tools policy, `requireMcpAuth` refuses request bodies that are not
  parsed JSON-RPC 2.0 messages with 400.
- `consentPage.theme.fontFamily` allows only letters, digits, spaces, commas
  and hyphens; `consentPage.expiresInSeconds` must be 60-3600.
- `/introspect` reports a token without `jti` as inactive.
- `consentUi.appLogo`, `privacyUrl` and `termsUrl` must be https URLs.
- A URL-shaped `client_id` is resolved only as a metadata document.
- Removed: the unenforced `allowedRedirectUris` option, and the metadata's
  advertised `grantex_extensions.consent_ui` and `audit_stream` URLs, which had
  no routes.

### Decision grants: specification, concepts and breaking changes
- `spec/decision-grant.md`: the decision-grant profile (roles and
  credentials, semantic action, token header and claims, approver identity
  providers, browser sign-in and step-up, decision requests, approval on the
  auth service's page, audit, case-bound validity, verification and single
  use, errors, threat model, APIs).
- `docs/concepts/decision-grants.md`: who can approve and how, the four-eyes
  model, validity, enforcing, refusals, rolling out with `decisions.required`,
  operating, and what decision grants do and do not protect against. Its code
  examples are files under `packages/sdk-py/tests/docs_examples` and
  `packages/sdk-ts/tests/docs/examples`, run and checked verbatim in CI.
- `spec/manifest-0.6.md` and `docs/concepts/tool-manifests.mdx` describe
  `requires_decision` enforcement instead of the interim always-deny rule.

Breaking and behaviour changes across the decision-grant series, for
reviewers and integrators:
- **Behaviour:** `enforce()` can now **allow** a call to a
  `requires_decision` tool, when it carries decision grants that verify and
  that the auth service consumes. Before, every such call was denied. Calls
  without decision grants are denied as before.
- **Behaviour:** `decision_required` denials now carry
  `details: {"decision_required": "<connector>:<tool>"}` (previously empty
  `details`).
- **Rollout mode:** `decisions_mode="warn"` / `decisionsMode: 'warn'` does
  not deny calls that lack a valid decision grant; it reports them in
  `would_deny` / `wouldDeny`. It exists for measured rollout and must not be
  used where decisions are required. The default is `enforce`.
- **New dependency on the auth service at call time** for decision tools:
  `enforce()` consumes grants online and refuses the call when the service
  cannot confirm (`consume_unavailable`). Offline-only deployments cannot call
  decision tools. A consumed grant stays spent if the response is lost or the
  tool call fails.
- **Break:** decision actions whose `case_id`, `subject` or extra values
  contain invisible Unicode format characters are refused.
- **Break:** the manifest unknown-key error message now lists
  `decision_fields`.
- `@grantex/mcp-auth`: `DecisionOutcome` sub-reasons include the new values
  (`case_changed`, `wrong_case`, `four_eyes_incomplete`, `malformed`,
  `revoked`, `unknown_grant`, `consume_unavailable`); the type was already a
  string, so no type break. `grantexDecisionVerifier` refuses calls without
  the grant's developer or the tool's connector.
- Auth service: migration `097_decision_grants.sql` adds tables only (safe on
  a live database, no effect on issued tokens); all decision endpoints and
  pages are off unless `DECISION_GRANTS_ENABLED=true`. Approvals are possible
  only on the auth service's approval page, after signing in with an identity
  provider the service administrator allow-listed.
- Auth service: decision grants are verified against the platform signing
  key ring, so unconsumed grants survive a key rotation while the old key is
  kept for verification.
- No existing public API was removed or renamed.

### Decision grants in the SDKs and mcp-auth
- `enforce()` in both SDKs now accepts decision grants for tools whose
  manifest entry has `requires_decision` (previously every such call was
  denied): `decision_grants` / `decisionGrants` (one token, or two for a
  decision in `four_eyes_on`), the action to compare them with
  (`decision_action` / `decisionAction`, or derived from `arguments`) and
  `case_version` / `caseVersion`. Grants are verified offline (typ
  `decision+jwt`, signature by the issuer's JWKS, issuer, audience
  `urn:grantex:decision`, developer, connector, action hash, case version,
  expiry, four eyes with different `sub` and the second approval naming the
  first) and then consumed at the auth service as the last step, after caps
  are reserved; a failed consumption refunds the reservation. Without grants
  the result is `decision_required` (with `details.decision_required`
  `<connector>:<tool>`); otherwise `decision_invalid` with a sub-reason from
  the new `DecisionSubReason` (`action_mismatch`, `wrong_case`,
  `case_changed`, `expired`, `consumed`, `same_approver`,
  `four_eyes_incomplete`, `malformed`, `unknown_grant`, `revoked`,
  `consume_unavailable`). Offline verification alone never allows a call.
  `EnforceResult.decision` records what was consumed. Any consumer failure
  denies the call and refunds the caps reservation. Consumption spends the
  grant: a lost response or a tool failure afterwards needs a new approval.
- When both `decision_action` and `arguments` are given they must hash
  identically (`action_mismatch`). A tool's manifest `decision_fields` are
  read from the arguments and must be bound by the grant.
- Grants must carry a `kid`; keys are chosen by `kid` and type from the
  issuer's JWKS; RS256 and ES256 are accepted (`decision_algorithms` /
  `decisionAlgorithms` narrows the list). Grants must carry
  `dwell_source: "server"`, `memo_hash` and `policy_score_hash`.
- `wrap_tool` / `wrapTool` take `decision_grants` / `decisionGrants` and
  `case_version` / `caseVersion` (values or per-call getters) and derive the
  action from the tool input; `enforceMiddleware` takes
  `extractDecisionGrants`, `extractArguments` and `extractCaseVersion`, and
  its 403 body now includes `reason` and `subReason`.
- The FastAPI `GrantexEnforcer` passes decision grants to `enforce()`: grants
  from the `Grantex-Decision-Grant` header (comma-separated), arguments from
  the JSON body, and the case version from a required `case_version`
  callback (server case state); each source can be replaced. Its 403 detail
  adds `reason_code` and `sub_reason`.
- `decisions_mode` / `decisionsMode` (client option and per call):
  `enforce` (default) denies. `warn` is for rollout only and is not a
  control: it does not deny a `requires_decision` call without a valid
  decision grant; it lets the call through and reports what would have been
  denied in `would_deny` / `wouldDeny`. Valid grants presented in warn mode
  are still consumed. Platforms map their `decisions.required` flag to
  `enforce` (on) or `warn` (off). `decision_consumer` / `decisionConsumer`
  replaces the auth-service consumer.
- `grantex.decisions` / `Grantex.decisions`: `set_case_version`,
  `create_request` (with `memo` and `policy_score`), `get_request`,
  `cancel_request`, `consume` (never retried; an unconfirmed consumption
  raises `consume_unavailable`). There is no approval API: people approve on
  the auth service's approval page.
- Manifest 0.6: tools may declare `decision_fields` (requires
  `requires_decision`). **Break:** the unknown-key error message now lists
  `decision_fields` among the allowed keys.
- `verify_decision_grant(s)` / `verifyDecisionGrant(s)` for offline checks,
  with shared cases in `spec/examples/decision-grant/verification.json`.
- `@grantex/mcp-auth`: `grantexDecisionVerifier()` reference
  `DecisionVerifier`, reading grants from the `grantex-decision-grant` header,
  requiring the grant's developer and the tool's connector (refused as
  `malformed` otherwise), binding manifest `decision_fields`, and answering
  `valid` only after consumption. Tool policies carry `decisionFields`.
  The guard and the verifier apply the access token's
  `urn:grantex:decision:v1` entries: a listed tool needs a decision grant,
  the entry's `four_eyes_on` requires two approvers, and a token with a
  malformed decision entry is refused for every `tools/call`
  (`decision_invalid` / `malformed_authorization_details`). **Behaviour
  change** for tokens that carry such entries.
- Behaviour change (no API break): a call to a `requires_decision` tool that
  carries a valid decision grant which the auth service consumes is now
  allowed. Calls without one are denied exactly as before.

### Decision grants in the auth service
Behind `DECISION_GRANTS_ENABLED` (default off; every decision endpoint and page
answers 404 until it is `true`). Profile in `spec/decision-grant.md`.

- **Who can approve.** A person signed in on the service's approval page
  (`/decisions/:id`) through an OpenID Connect authorization code flow with
  PKCE, state bound to the browser and a nonce (`/decisions/login`,
  `/decisions/callback`), with an identity provider the **service
  administrator** allow-listed for the developer
  (`POST /v1/admin/developers/:developerId/decision-approver-idps`,
  `ADMIN_API_KEY`, the operator named and audited). A developer API key cannot
  add an identity provider, sign an approver in or approve; `sso_connections`
  are not used for approvals.
- **ID token checks.** Discovery `issuer` equals the configured issuer; key by
  `kid` from the provider's JWKS (refetched once for an unknown `kid`),
  asymmetric algorithms only; `iss`, `aud`, `azp`, `exp`, `iat`, `nonce`;
  step-up is an `acr` in `DECISION_STEP_UP_ACR` or an `amr` in
  `DECISION_STEP_UP_AMR` (default `mfa,hwk`) with `auth_time` within
  `DECISION_STEP_UP_MAX_AGE_SECONDS` (default 3600). A nonce is accepted once
  per issuer and subject. An email counts only when `email_verified`; an
  identity provider can require it.
- **Session.** The secret is only in a `__Host-` HttpOnly Secure SameSite=Lax
  cookie on the service's origin (only its hash is stored) and lasts until the
  step-up window ends.
- **Decision requests** (developer API key): `POST /v1/decisions/requests` with
  the semantic action, connector, case version, `memo` and `policyScore`
  (content stored with its SHA-256, shown verbatim, bound into the grant) and
  `fourEyesOn`; `GET`, `cancel`; `PUT /v1/decisions/cases/:caseId` supersedes
  open requests and revokes unconsumed grants (`case_changed`). Bodies with
  duplicate member names are refused.
- **Approval** only by form post from the approval page: session cookie, CSRF
  token bound to session, request and rendering, `Origin` of the service
  and `Sec-Fetch-Site: same-origin` both required, `Referrer-Policy:
  same-origin` (so the browser sends the real `Origin`), CSP without script,
  `frame-ancestors 'none'`. Dwell time is measured by the service from
  rendering to submission; approvals faster than `DECISION_MIN_DWELL_MS`
  (default 2000) are refused.
- **Token.** `typ: decision+jwt`, audience `urn:grantex:decision`, `kid`;
  `sub` is `user:<issuer hash>:<idp sub>`; `approver_auth`, `acr`, `amr`,
  `auth_time`, `action`, `action_hash`, `connector`, `case_version`,
  `dwell_ms`, `dwell_source: "server"`, `memo_hash`, `policy_score_hash`,
  `decision_request`, `jti`, expiry capped at 24 hours and at the request's
  expiry; for four eyes the second grant names the first. The same approver
  (namespaced subject) or the same verified email cannot approve twice.
- **Consumption** (developer API key): `POST /v1/decisions/consume` verifies
  (key chosen by `kid`, RS256 or ES256) and atomically consumes one grant or
  both grants of a four-eyes decision. Refusals carry `reason:
  decision_invalid` and a `subReason`. Every refusal is audited with the
  attempted action and hash; if that record cannot be written the answer is
  503 `DECISION_AUDIT_UNAVAILABLE`.
- **Audit chain:** identity-provider changes, sign-ins, requests, approvals
  (approver, identity provider, authentication method, dwell time and source,
  action, memo and policy score hashes), consumptions, refusals, case changes
  and cancellations, each in the transaction it records. Approver emails are
  stored only as keyed hashes and names encrypted.
- **Metrics:** `grantex_decision_grants_minted_total{approvals_required,position,dwell_source}`,
  `grantex_decision_grants_consumed_total`,
  `grantex_decision_grants_rejected_total{stage,reason}`,
  `grantex_decision_dwell_seconds{dwell_source}`.
- **Migration** `097_decision_grants.sql`: new tables only.
- No change to existing endpoints or tokens.

### Decision action hash: stricter inputs and extra decision fields
- The semantic action may carry `extra`: further fields the manifest declares
  for a tool (`decision_fields`, for example a currency), included in the
  hash. `from_tool_call` / `decisionActionFromToolCall` take the declared
  names and require them in the call. Hashes of actions without `extra` are
  unchanged.
- **Break:** `case_id`, `subject` and extra string values containing invisible
  Unicode format characters (soft hyphen, zero-width, bidirectional controls,
  tags) are now refused (`invalid_value`). Such actions hashed before.
- `DecisionAction.from_json` (Python) and `parseDecisionActionJson`,
  `parseJsonRejectingDuplicates` (TypeScript) refuse duplicate member names
  (`duplicate_key`).
- Python canonicalisation ignores overridden `__repr__` / `__str__` on
  `float`, `int` and `str` subclasses.

### Canonicalisation and decision action hash
- RFC 8785 JSON canonicalisation in both SDKs: `grantex.canonical`
  (`canonicalize`, `canonicalize_bytes`, `serialize_number`) and
  `canonicalize`, `canonicalizeToBytes`, `serializeNumber` in `@grantex/sdk`.
  Values without one canonical form (NaN, infinities, unpaired surrogates,
  non-JSON types, nesting deeper than 64; in Python, integers a double cannot
  hold exactly) raise `CanonicalizationError`. Tested against the RFC 8785
  test vectors, the first 100,000 lines of the RFC 8785 ES6 number test and
  shared fixtures in `spec/examples/canonicalization/`.
- The semantic action a decision grant approves (PRD G-3) and its hash:
  `grantex.decisions.DecisionAction` (`from_dict`, `from_tool_call`,
  `canonical_json`, `action_hash`), `compute_action_hash`, `is_action_hash`,
  and `parseDecisionAction`, `decisionActionFromToolCall`,
  `canonicalActionJson`, `computeActionHash`, `isActionHash` in
  `@grantex/sdk`. `action_hash = "sha256:" + base64url(SHA-256(JCS({case_id,
  action, decision, subject, amount?})))`. Extra tool arguments, member order
  and whitespace do not change the hash; any change to those five fields
  does. Rules in `spec/canonicalization.md`, cross-language cases in
  `spec/examples/decision-grant/action-hash.json`.
- New modules only; no existing API or behaviour changes.

### Purpose-bound grants
- `POST /v1/authorize` accepts `purpose`: a term from the controlled
  vocabulary (`aml.cdd.onboarding`, `aml.cdd.ongoing`, `aml.screening`,
  `procurement.vendor_onboarding`, `payments.payout`) or a private
  `x-<org>.<term>`. Anything else, or a purpose without a
  `tool:<connector>:<permission>` scope, is rejected with `INVALID_PURPOSE`.
- The approved purpose is shown on the consent page, stored on the grant,
  carried in grant tokens as `authorization_details` entries of type
  `urn:grantex:tools:v1` (one per connector), kept on refresh, inherited by
  delegated grants, returned by the grants API and recorded on audit entries.
  Migration `095_purpose_bound_grants.sql` adds nullable `purpose` columns to
  `auth_requests`, `grants` and `audit_entries`.
- The Python and TypeScript SDKs add the purpose vocabulary and matcher
  (`grantex.purpose`, `purposeMatches`), `purpose` on `AuthorizeParams`,
  `Grant`, `AuditEntry` and `EnforceResult`, and read
  `authorization_details` from verified grant tokens.
- `enforce()` denies a call to a tool that declares `allowed_purposes` with
  `purpose_not_allowed` when the grant has no purpose (`missing`), a purpose
  outside the vocabulary (`unknown_purpose`) or one that matches no pattern
  (`not_matched`). Wildcards are prefix-segment based: `aml.cdd.*` matches
  `aml.cdd.onboarding`, not `aml.cddx`, and `aml.*` does not match `aml`.
- `enforce()` also applies a `urn:grantex:tools:v1` entry's `tools` list
  (`tool_not_granted` / `not_in_authorization_details`), denies every call when
  `authorization_details` is malformed (`token_invalid` /
  `malformed_authorization_details`), and fails closed with
  `meter_unavailable` when the grant declares caps for the tool.
- No change for tools without `allowed_purposes` or for requests without a
  purpose.

### Tool manifest schema 0.6
- Tool values in a manifest may now be objects carrying `permission`,
  `allowed_purposes`, `caps` (`per_hour`, `per_day`, `per_case`),
  `cost_units`, `requires_decision` and `four_eyes_on`, alongside the existing
  permission strings; both forms can be mixed in one file. The schema is
  published as JSON Schema 2020-12 in `spec/manifest-0.6.schema.json`, with
  the rules in `spec/manifest-0.6.md`.
- The Python and TypeScript loaders validate such manifests strictly and raise
  `ManifestValidationError` naming the offending path for an unknown key, a
  `requires_decision` on a `read` tool, `four_eyes_on` without
  `requires_decision`, or a malformed purpose pattern, cap or cost unit. New
  exports: `ToolSpec`, `ToolCaps`, `ManifestValidationError`,
  `ToolManifest.get_tool_spec()` / `getToolSpec()`, `to_dict()` / `toJSON()`.
- Denied `enforce()` results carry a stable `reason_code` / `reasonCode` from
  the new `DenialReason` taxonomy (`purpose_not_allowed`, `tool_not_granted`,
  `permission_insufficient`, `cap_exceeded`, `decision_required`,
  `decision_invalid`, `grant_revoked`, `region_mismatch`,
  `manifest_unknown_tool`, `token_invalid`), an optional sub-reason and
  structured details. `reason` is unchanged.
- `enforce()` fails closed on declarations it cannot evaluate yet: a tool
  declaring `allowed_purposes` is denied (`purpose_not_allowed`), one with
  `requires_decision` returns `decision_required`, and one with `caps` or
  `cost_units` is denied (`cap_exceeded` / `meter_unavailable`).
- No change for existing manifests: tools declared with a permission string
  are enforced exactly as before. Manifests made only of permission strings
  still load with unknown top-level keys, now with a deprecation warning; a
  future minor release will reject them.
- **Behaviour change:** manifest files (JSON and YAML) with a key repeated
  inside one object are rejected with `ManifestValidationError`
  (`duplicate key "<key>" in manifest file`) by `from_file` / `fromFile` and
  `load_manifests_from_dir` / `loadManifestsFromDir`, instead of silently
  keeping the last value.

### Verified Python SDK publication (2026-09-15)
- Published Python `grantex==0.5.1` to PyPI (uploaded 2026-09-15 01:56 UTC),
  built from `main` at `1bc13b2e`. Distribution SHA-256 values:
  wheel `5fce7d63dc8d6202c9ed9a4213de0125bd6cde9fe15d5aa5c373b5c36c3e836d`,
  sdist `e1bd608fd236b30e93e4fc69ac5e2a596f7f80c254bfe53cc61b4e49065031cc`.
- Before upload, Ruff, strict Mypy and all 623 Python tests passed on
  Python 3.12 and 3.9. The installed PyPI wheel then passed the same 623 tests
  in a clean virtual environment.
- 0.5.1 is a patch release: `enforce()` applies the tightest cap and fails
  closed on malformed, negative or non-finite amounts; the FastAPI enforcer
  reads the `Authorization` header; JWKS verification is cached and runs off
  the event loop; resource ids are percent-encoded; single-use codes are never
  retried; and event streams bound connect time.
- The public release snapshot (`release-status.json`, verified 2026-09-15) and
  current-release documentation now advertise `grantex==0.5.1`. TypeScript
  `0.6.0`, x402 `0.4.0`, Go `v0.3.0`, CLI `0.3.0` and MCP Auth `2.0.2` are
  unchanged and re-verified against their registries. The OpenAPI contract
  version is unrelated and remains `0.5.0`.

### Python SDK 0.5.1
- Prepares `grantex==0.5.1`, a patch release of the Python SDK carrying the
  SDK fixes merged since 0.5.0: `enforce()` applies the tightest budget cap,
  honours `agenticorg:` scopes and denies malformed, negative or non-finite
  caps and amounts; the FastAPI enforcer reads the `Authorization` header
  instead of the query string; grant-token verification caches the JWKS
  (10-minute TTL, rate-limited refresh on an unknown `kid`) and runs off the
  event loop; resource ids are percent-encoded in every request path;
  single-use authorization codes are never retried; and event streams bound
  connect, write and pool time at 10 seconds.
- **Behaviour change:** calls that `enforce()` previously allowed with a
  malformed or negative cap, or a non-finite amount, are now denied.

### x402 UK Taxi / PHV compatibility fixture
- The external compatibility fixture and report now use the service's
  canonical host, `uk-taxi-phv-mcp-production.up.railway.app`, after the
  provider retired its previous Railway host (#1233). The 402 challenge was
  re-captured with the same unsigned request; payment terms are unchanged.

### Makefile
- `make install`, `make check` and `make test` cover the Python SDK, the
  TypeScript SDK, `@grantex/mcp-auth` and the auth service, and run as the
  `make` job in CI. See "Development Setup" in `CONTRIBUTING.md`.

### Published auth-service image
- `ghcr.io/mishrasanjeev/grantex-auth-service` is built for amd64 and arm64
  on changes to `main` and on `v*` tags, scanned before push, and published
  with build provenance and SBOM attestations and a keyless cosign signature.
  Pull requests build and scan without pushing. See "Prebuilt image" in
  `DEPLOYMENT.md`.

### Container scanning and SBOM
- CI builds the auth-service image on every pull request, push to `main` and
  weekly, scans it with Trivy 0.74.0 (failing on fixable HIGH/CRITICAL
  vulnerabilities) and publishes a CycloneDX SBOM artifact. Accepted
  exceptions are dated and expire; see "Container scanning" in
  `CONTRIBUTING.md`. The 16 findings in today's image are tracked in
  `FINDINGS.md` (base image OpenSSL, npm's bundled packages, and a TypeScript
  compiler binary in the runtime image) with exceptions expiring 2026-10-14.

### CodeQL for Python
- CodeQL analysis now covers the Python packages as well as
  JavaScript/TypeScript, on pull requests, pushes to `main` and weekly.

### Python static security analysis
- CI runs bandit 1.9.4 over every Python package's shipped source on each pull
  request, push to `main` and weekly. See "Python static security analysis" in
  `CONTRIBUTING.md`.

### Secret scanning
- CI scans every pull request, every push to `main` and, weekly, the full
  history with gitleaks 8.30.1 (pinned and checksum-verified). A pre-commit
  hook is available; see "Secret scanning" in `CONTRIBUTING.md`. Existing
  findings were triaged as placeholders and baselined in `.gitleaksignore`.

### Python SDK event stream timeouts
- `EventsClient.stream()` and `subscribe()` no longer wait forever for a server
  that never accepts the connection: connect, write and pool acquisition are
  bounded at 10 seconds. Reads stay unbounded so an idle stream is not closed
  between events.

### Security bug sweeps (2026-09-13)
- auth-service: inbound commerce webhooks verify the HMAC over the raw request
  bytes (canonical re-serialisation rejected real senders); tenant owners can no
  longer rebind another developer's default commerce tenant; MPP passport
  budget caps are enforced at zero remaining; vault credential exchange requires
  the exact `vault:<service>:exchange` scope and a DPoP proof for key-bound
  tokens; Plural sandbox webhooks are gated on the intent's environment;
  `/oauth/revoke` with a refresh token revokes the grant; string quantities pass
  the safe-integer check. Earlier in the series: consent FIDO gate, passport
  lifetime, SSO state key, mcp-auth exchange/introspect/revoke hardening.
- Public host: Firebase rewrites for `/mcp`, `/v1/commerce/**`, `/permissions`,
  `/v1/principal/**`, `/v1/agents`, `/v1/authorize`, `/v1/token/**` and
  `/v1/x402/**`; commerce discovery advertises the MCP endpoint from
  `MCP_PUBLIC_BASE_URL`; mpp-demo verify screen escapes pasted credentials; the
  playground mints a sandbox key instead of a dead hard-coded one.
- SDKs: gateway strips inbound `x-grantex-*` identity headers; Go `Exchange`
  never retries a single-use code; the Python FastAPI enforcer reads the
  `Authorization` header (it bound to the query string); JWKS caching and
  off-loop verification in Python and Go; CLI `verify` no longer fetches JWKS
  from the unverified `iss`; adapters pick the tightest constrained scope;
  mcp-auth binds refresh tokens to the authenticated client and rejects string
  `scp`; resource ids are percent-encoded in every SDK path. Python paths are
  3.9-compatible and `mypy --strict` clean.
- Conformance runner no longer deletes other agents in the target tenant;
  the Terraform provider matches the real SSO/webhook/budget/grants contracts,
  drops 404s from state and supports import.
- Rollout: grants issued with the old vault exchange scopes get 403 after
  deploy (re-issue with `vault:<service>:exchange`); set `MCP_PUBLIC_BASE_URL`
  where the public host serves a page at `/mcp`.

### Dependency integration (2026-09-07)
- Merged the 49 pending dependency PRs through integration PR #1156,
  including Vitest 5, SimpleWebAuthn 14, solc 0.8.36 and framework/type patches.
- Paired Vitest and coverage upgrades, regenerated overlapping lockfiles and
  grouped future Dependabot updates. CI source tooling uses Node.js 24.
- Updated the WebAuthn transport type for v14 and added real-library option
  generation and malformed-evidence rejection tests. Security policy is unchanged.
- Updated contributor, README, deployment and release-status guidance. Published
  SDK versions are unchanged; deployment/test evidence is recorded separately.
- Revalidated and merged three post-scan lockfile updates through PR #1160:
  x402 core/fetch 2.25.0 and destinations S3 3.1126.0. A fresh public npm consumer
  passed the local Docker payment suite and all 255 local API E2E tests.
- Cloud Run and Firebase deployments passed. The final production E2E run passed
  255/255 tests across 23 files, with zero skips. Full local SDK/app, Python,
  Go, security and deployment evidence is in the
  [validation report](docs/internal/dependency-batch-2026-09-07.md).
- Corrected Terraform availability guidance: its public provider registry lookup
  returns 404. Source builds pass, but publication and live provider acceptance
  remain separate work; ordinary registry installation is not available.

### Verified SDK publications (2026-09-07)
- Published `@grantex/sdk@0.6.0` and `@grantex/x402@0.4.0` to npm after the
  workstation publishing approval completed. Both registry integrity hashes
  exactly match the tested tarballs. A new consumer installed both exact versions
  from npm and passed public-export, license/notice, Base safety, authenticated
  reconciliation, and zero-vulnerability audit checks. The public registry
  packages also passed the isolated Docker Base and existing wallet lifecycles,
  then all 255 production E2E tests across 23 files in 281.80 seconds.
- Published Python `grantex==0.5.0` to PyPI and Go SDK `v0.3.0` to the standalone
  module. Verified distribution hashes, clean public-registry installs, all
  613 Python tests, the Go race suite, and production reconciliation authentication
  boundaries. Both expose EVM payment responses and principal/agent reconciliation;
  neither adds an automatic x402 HTTP payment wrapper.
- Included Apache-2.0 LICENSE and NOTICE files in the four primary release
  artifacts. The public snapshot now reflects all four verified versions.
  Local EVM tests do not prove a funded mainnet payment.

### SDK release candidates (2026-09-07)
- Prepared TypeScript SDK 0.6.0, x402 0.4.0, Python SDK 0.5.0 and Go SDK
  v0.3.0 for the governed Base USDC release. These versions add EVM payment
  responses and authenticated finalized-chain reconciliation. The x402 adapter
  provides opt-in request-bound Base 402/sign/retry; Python and Go do not add
  automatic HTTP payment wrappers. Existing prepaid behavior remains the default.
- Updated package runtime identifiers and the guarded primary-SDK publication
  workflow. Publication and clean-install verification subsequently completed
  for all four versions as recorded above.

### Added
- Added opt-in governed Base native USDC x402 v2 EIP-3009 payments, verified
  finalized funding, encrypted restart-safe signature recovery, and finalized
  settlement/expiry reconciliation. Signed exposure survives blocks and timeouts.
  Migration `094` and explicit custody/RPC provisioning are required. Added
  TypeScript/Python/Go reconciliation methods, API documentation and isolated
  Docker tests with official x402 facilitator execution. Published client versions
  are recorded separately in the verified SDK publications above.
- Added layered prepaid-wallet spend governance across assignment, wallet,
  agent, shared budget-group, principal, and developer scopes. Policies support
  deny, exact principal approval, amount/count limits, reservation-aware rolling
  and calendar windows, semantic filters, and verified-merchant requirements.
- Added safe assignment defaults, wallet balance/reload velocity limits,
  exact-bound single-use payment approvals, semantic authorization binding,
  durable append-only policy decisions, and principal dashboard approval/policy
  controls.
- Added wallet-governance clients to TypeScript `0.5.0`, x402 `0.3.0`, Python
  `0.4.0`, and Go `v0.2.0`, including ES256 DPoP agent requests in Python and Go.
- Added a responsibility and gap matrix separating Grantex governance from
  AgenticOrg/runtime, issuer/custodian, merchant, and principal obligations.
- Added TypeScript SDK 0.4.0 prepaid-wallet clients and auth-service APIs for principal-owned multi-wallet assignment, per-transaction and rolling cumulative spend limits, recipient/scope allowlists, threshold reload requests with separate principal approval/funding, reservation release, activity views, and assignment/wallet/all-wallet agent stop controls.
- Added durable atomic-unit wallet balances, reservations, reload requests, and append-only ledger entries with serialized concurrent spend enforcement and agent/principal-wide idempotency.
- Added `@grantex/x402` 0.2.0 integration with official x402 v2 headers and Foundation client packages, backed by DPoP wallet reservations and idempotent facilitator verification/settlement.
- Added profile-aware agent registration metadata, resolvable keyed agent DID documents, standard OAuth `scope` and `client_id` token claims, resource and redirect binding, signed audit checkpoints, and maintained SDK coverage for those custom API features.
- Published `@grantex/cli` 0.3.0 on 2026-08-10 with one-command Agent Skills installation for Hermes, OpenClaw, portable `.agents/skills` workspaces, and custom skill roots.
- Added the `use-grantex-cli` and `integrate-grantex` skills for safe JSON-first operations and service-boundary implementation guidance.
- Added cross-platform token input from environment variables, files, and stdin, plus non-zero JSON-mode status codes for invalid or denied checks.
- Added `audience` support to TypeScript, Python, and Go authorization requests.
- Added missing TypeScript Vault documentation, package READMEs, JSON-LD contexts, and documentation health checks.
- Added transactional Redis-backed throughput enforcement for developer API-key requests handled by the standard auth plugin, keyed by developer and plan: Free 100, Pro 500, and Enterprise 2,000 requests per 60 seconds. It runs after the active Fastify per-IP policy (the 5,000/min default or a route-specific override); exhaustion returns structured `429` headers, and counter unavailability fails closed with `503`.
  Commerce, SCIM Bearer data-plane, admin, and other custom-auth routes remain outside these plan buckets.

### Changed
- TypeScript, Python, and Go HTTP clients now honor an explicit server
  `Retry-After` window beyond the ten-second exponential-backoff ceiling, with
  a two-minute defensive cap.
- Published `@grantex/sdk@0.5.1` to npm on 2026-09-01 and verified the
  registry integrity, exact-version clean install, public exports, and
  zero-vulnerability consumer audit. TypeScript `0.5.1`, Python
  `grantex==0.4.1`, and Go SDK `v0.2.1` include five-minute in-process refresh
  retry-key retention and an explicit durable idempotency-key option for
  retries that cross restarts.
- Published Python SDK `grantex==0.4.1` to PyPI and Go SDK `v0.2.1` to the
  standalone module on 2026-09-01; verified both from clean public-registry
  installs, including the explicit refresh idempotency-key APIs.
- Published `@grantex/sdk@0.5.0` and `@grantex/x402@0.3.0` to npm on
  2026-08-31; verified registry integrity and installed both exact versions in
  a clean project, including the layered-wallet and x402 approval exports.
- Published Python SDK `grantex==0.4.0` to PyPI and Go SDK `v0.2.0` to the
  standalone Go module on 2026-08-31; verified both from clean registry
  installs, including the layered prepaid-wallet governance clients.
- Published `@grantex/sdk@0.4.0`, corrective `@grantex/sdk@0.4.1`, and `@grantex/x402@0.2.0` to npm on 2026-08-30; registry-smoke-tested the prepaid-wallet exports, corrected SDK runtime identifier, x402 exports, and `grantex-x402` CLI.
- Replaced the x402 client's simulated custom payment-proof flow with official x402 v2 `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and `PAYMENT-RESPONSE` handling. The standalone GDT APIs remain available but are now documented as authorization context rather than durable cumulative spend enforcement.
- Published TypeScript SDK 0.3.13, Python SDK 0.3.14, and Go SDK v0.1.10 on 2026-07-11; synchronized the public release snapshot across the landing page, README, compatibility matrix, and SDK documentation.

### Fixed
- Made migration `093_encrypt_refresh_replay_state.sql` clear legacy plaintext
  replay state exactly once. A durable migration sentinel prevents subsequent
  auth-service restarts from erasing valid encrypted recovery responses.
- Encrypted refresh lost-response replay tokens at rest with AES-256-GCM,
  removed legacy plaintext replay state during migration, and added a bounded
  cleanup sweep that erases expired response material.
- Added 300-second lost-response recovery to standards-based OAuth refresh
  rotation. Recovery requires the same old refresh token, client, DPoP key,
  and idempotency key; mismatched reuse still revokes the token family.
- Closed npm and Go dependency advisories, pinned every GitHub Action to an
  immutable commit, added complete Dependabot manifest coverage, and added
  npm, Python, Go, and license-policy gates to the security workflow.
- Enabled generic SLSA provenance generation for tagged source releases using
  the verified upstream `v2.1.0` builder workflow.
- Preserved structured `PrepaidPaymentApprovalRequiredError` details across the
  official x402 fetch wrapper so an approved retry can reuse the exact wallet,
  approval request, and idempotency key.
- Serialized cross-agent policy evaluation and policy mutation under a shared
  advisory lock and fixed PostgreSQL array type inference in policy filters.
- Corrected the TypeScript SDK `User-Agent` version and tied its regression test to `package.json` so future package bumps cannot publish a stale runtime identifier.
- Hardened live authorization so policy decisions cannot replace authenticated Principal consent; bound redirects, resources, scopes, and registered agent keys through issuance and delegation.
- Made refresh rotation recoverable for 300 seconds only when the authenticated caller repeats the same old token and idempotency key; recovery returns the exact committed token values with a recalculated remaining lifetime and survives a server restart without extending expiry.
- Corrected the Go SDK source contract across Agent and Audit reads/writes: `agentId` mapping, optional registration fields, status updates, explicit scope clearing, required audit-write fields, `developerId` reads, and list envelopes.
  Removed unsupported audit filters and URL-encoded query values, with API-shaped regression tests.
  These fixes are not part of the currently published `v0.1.10` module.
- Corrected SDK quick starts, audit payloads, verification examples, endpoint paths, usage semantics, package metadata, and OpenAPI coverage.
- Fixed production issuer alias handling across offline verifiers and tightened Go grant-claim verification.
- Hardened JWKS key selection and caching, LDAP bind framing and DN escaping, and production deployment-secret validation.
- Secured Trust Registry DNS ownership verification, removed unsupported seeded claims, and fixed filtered cursor pagination.
- Prevented duplicate active MCP certification applications and persisted their pending state in the portal.
- Reconciled landing-page examples and product claims with the implemented APIs and supported verification workflows.

### Documentation
- Added a self-hosted prepaid-wallet production-readiness guide covering public OAuth resource routing, migration `091`, external custody fail-closed behavior, reload notification delivery, merchant idempotency, regulatory boundaries, and a guarded PowerShell npm publication runbook.
- Added dedicated Hermes, OpenClaw, and generic agent-CLI guides and made the support visible on the landing page, integration index, README, and machine-readable LLM guides.
- Expanded the core OpenAPI description and aligned landing pages, SDK guides, compatibility data, deployment guidance, and release metadata.
- Replaced unsupported certification, compliance, latency, cache, and automatic-audit claims with implementation-backed behavior.

## v0.3.12 / Integration SDK verification releases (2026-06-20)

### Added
- Added `@grantex/strands` 0.1.0, a TypeScript Strands Agents SDK integration with JWKS-backed grant verification, optional `client.enforce()` mode, and 9 Vitest coverage cases.

### Security
- Python SDK `grantex` 0.3.12 tightens published dependency floors for token verification libraries.
- A2A, AutoGen, LangChain, Vercel AI, CrewAI, Google ADK, OpenAI Agents, and Strands integrations now verify grant tokens against JWKS before enforcing scopes.

### Releases
- Publishable patch releases prepared: `@grantex/a2a` 0.1.3, `grantex-a2a` 0.1.3, `@grantex/autogen` 0.1.6, `@grantex/langchain` 0.1.7, `@grantex/vercel-ai` 0.1.6, `@grantex/strands` 0.1.0, `grantex-crewai` 0.1.6, `grantex-adk` 0.1.5, and `grantex-openai-agents` 0.1.5.
- `grantex-strands` 0.1.1 prepared as the corrected PyPI release with verification docs and project metadata.

## v0.3.11 (2026-06-14)

### Fixes
- TypeScript, Python, and Go SDKs trim API key input before constructing `Authorization` headers.
- TypeScript SDK package version advanced to `0.3.11` for the publishable Commerce V1/OACP npm release.
- Python SDK package version advanced to `0.3.11` after the `0.3.10` Commerce upload.

## v0.3.10 (2026-06-14)

### Added
- Python SDK: `client.commerce.*` Commerce V1/OACP client for merchant discovery, catalog grounding, MCP tool calls, carts, consent, Commerce Passport, payment intents, checkout links, provider credentials, webhook sources, and operator health.
- Go SDK: `client.Commerce.*` Commerce V1/OACP client with matching discovery, catalog, idempotent write, MCP, provider webhook, and ops helpers.
- Python and Go Commerce V1 SDK docs.

### Fixes
- Python and Go SDK HTTP clients now support per-call headers for idempotency keys and provider webhook handling.
- Python and Go SDK error handling now parses nested Commerce/Fastify error envelopes.
- Python and Go SDK user-agent versions updated to `0.3.10`.

## v0.3.9 (2026-06-14)

### Added
- TypeScript SDK: `grantex.commerce.*` Commerce V1/OACP client for merchant discovery, catalog grounding, MCP tool calls, carts, consent, Commerce Passport, payment intents, checkout links, provider credentials, webhook sources, and operator health.
- TypeScript SDK docs: Commerce V1 guide published under the TypeScript SDK resources.

### Fixes
- TypeScript SDK HTTP client now supports per-call headers for idempotency keys and provider webhook handling.
- TypeScript SDK error handling now parses nested Commerce/Fastify error envelopes.
- TypeScript SDK user-agent version updated to `@grantex/sdk/0.3.9`.

### Verification
- SDK typecheck, tests, build, Commerce hardening validator, pilot-readiness validator, and live production read-path SDK probe passed.
- Live probe covered the Shopify merchant profile, authenticated catalog search, MCP catalog search, ops health, and Plural webhook signature fail-closed behavior.

## v0.3.8 / @grantex/mcp 0.1.9 (2026-04-08)

### Security
- `@grantex/mcp` 0.1.8 → 0.1.9: include `server.json` in npm tarball so MCP registry can index the manifest
- `@grantex/mcp` 0.1.8: shipped hono >=4.12.12 override + @hono/node-server 1.19.13 (6 CVEs)

### Fixes
- Python SDK 0.3.8: fixed `dict` type annotation for mypy `--strict` compatibility
- MCP registry re-published at 0.1.9 (0.1.7 and 0.1.8 tarballs lacked `server.json`)

### CI
- Expanded CI from 5 to 22 tested packages across 10 jobs (all green)
- Fixed Vitest 4 constructor mock compatibility in auth-service, CLI, and policy tests
- Auth-service: `validateConfig()` now called on startup (was defined but never invoked)
- Added `vitest.config.ts` to adapters, excluded gemma E2E from unit test runs

### Documentation
- Updated test stats: 3,536 tests across 28 packages (was 3,332 / 27)
- CHANGELOG: added v0.3.5, v0.3.6, v0.3.7 entries
- SECURITY.md: updated supported versions (0.1.x → 0.3.x), added gateway/mcp/dpdp to scope
- Python SDK passports page added to docs.json navigation

## v0.3.7 (2026-04-08)

### Added
- **TypeScript SDK: DpdpClient** — 11 methods for DPDP Act 2023 compliance (consent records, notices, grievances, erasure, exports), 14 tests
- **Python SDK: DpdpClient** — full DPDP parity with TypeScript SDK, 13 tests
- **Go SDK: DPDPService** — full DPDP parity, 12 tests
- **CLI: `grantex dpdp`** — 11 subcommands for DPDP operations (consent CRUD, notices, grievances, erasure, exports, principal records), 42 tests
- Auth service: 11 DPDP endpoints with Ed25519 consent proofs, access tracking, 7-day grievance SLA, retention policies
- Auth service: auto-revoke on consent withdrawal, data deletion enforcement
- Auth service: CSP header enforcement

### Security
- Upgraded `hono` to 4.12.12 — resolved 5 CVEs (cookie bypass, IPv6 matching, path traversal, serveStatic bypass, setCookie validation)
- Upgraded `@hono/node-server` to 1.19.13 — resolved CVE-2026-39406 (middleware bypass)
- Fixed SSRF vulnerability in CLI `dpdp` command (CodeQL js/file-access-to-http)
- Resolved all 21 Dependabot vite alerts across packages

### Documentation
- README: DPDP CLI commands, SDK usage examples, API endpoint table
- Landing page: version badges updated, DPDP feature card
- Mintlify docs: CLI DPDP section, SDK overview pages (TS/Py/Go) updated
- llms.txt: updated SDK versions and resource count

### Fixes
- Fixed E2E health check (`"healthy"` vs `"ok"` mismatch)
- Regenerated root package-lock.json to sync with updated deps
- Updated stale version references across DEPLOYMENT.md, requirements.txt, llms.txt

## v0.3.6 (2026-04-06)

### Security
- Resolved all npm vulnerabilities across all packages
- Upgraded brace-expansion to fix CVE (moderate severity)
- Bumped Go SDK to go 1.26.1 (fixes 3 stdlib CVEs)
- Tightened dependency version minimums (grantex-fastapi 0.1.4)

### Documentation
- Added comprehensive DEPLOYMENT.md with production deployment guide
- Added requirements.txt for Python projects
- Expanded .env.example to all 30 environment variables

## v0.3.5 (2026-04-06)

### Added
- Enterprise hardening: Fastify per-IP rate limiting with endpoint overrides (JWKS exempt), HTTP security headers (HSTS, CSP, X-Frame-Options), SDK retry with exponential backoff, structured JSON logging via pino, database connection pools, graceful shutdown
- Landing page: test coverage trust card, enterprise hardening features section
- OWASP ZAP CI integration for security scanning

### Fixes
- Added vitest.config.ts to 6 packages with undiscoverable tests
- Windows compatibility for CLI tests (shell:true)
- SEO improvements: twitter:site meta tags, crawlability updates
- Resolved 3 Codex review comments on enterprise hardening PR

## v0.3.4 (2026-04-05)

### SDK Parity
- Python SDK: Added PassportsClient (issue, get, revoke, list)
- Python SDK: Added EventsClient.subscribe() with Subscription class
- Python SDK: Fixed usage.history() and budgets.transactions() optional parameters
- Go SDK: Added PassportsService and VaultService (20/20 service parity)
- TypeScript SDK: Added AuthorizationRequest optional fields (sandbox, policyEnforced, effect)
- Python SDK: Added SSO type aliases (SsoConnectionListResponse, SsoSessionListResponse)

### Documentation
- 35 new API reference pages (budgets, domains, usage, vault, events, tokens, signup, policies, anomalies)
- Custom Manifests dedicated guide page
- Manifest messaging reframed: "bring your own manifest" as primary story

### Testing
- 315+ new tests across all SDKs and packages
- Auth service passport endpoint tests (25)
- Anomalies endpoint tests expanded (15 new)
- MCP server tests expanded (43 new, all 17 tools covered)
- Gemma module tests (78), DPDP module tests (66), JWT tests (44)

### Fixes
- Fixed mcp-auth peer dep constraint (^0.1.8 → >=0.1.8)
- Fixed manifest count: 53 connectors / 339 tools (was incorrectly 54/340)
- Dropped orphaned signing_keys table (migration 030)
- Tightened SDK version constraints across 13 integration packages
- Corrected README badges: 3,900+ tests, 27 packages

## [2.5.0] — April 2026

### Added

#### Anomaly Detection Dashboard & Custom Rules
- Anomaly detection dashboard with severity overview, activity chart, and alert management
- Alert detail page with timeline, context viewer, and resolution notes
- Rule builder page: view built-in rules, create custom rules, toggle enable/disable
- Anomaly detection landing page (`/anomaly`) with built-in rules table, integration logos, custom rule DSL example
- Mintlify docs: `features/anomaly-detection.mdx` (full reference) and `guides/anomaly-detection-setup.mdx` (setup guide)
- Expanded portal API client: alert CRUD, metrics, rules, channels
- 10 built-in anomaly detection rules: velocity spike, scope escalation, unknown agent, token replay, off-hours activity, high failure rate, concurrent sessions, delegation depth, budget overspend, geographic anomaly
- Alert lifecycle: open, acknowledged, resolved with audit trail
- Multi-channel notifications: Slack, PagerDuty, Datadog, email, webhook
- Custom rule DSL with agent filters, scope filters, time windows, and thresholds

#### Trust Registry Portal & Documentation
- Trust Registry portal screens (search, org detail, registration wizard) in developer portal
- `src/api/registry.ts` — API client for registry endpoints
- `RegistrySearch` page — filterable org card grid with verification badges and stats
- `RegistryOrgDetail` page — org profile with compliance grid, agent table, public keys, and DNS verify
- `RegisterOrgForm` page — 4-step wizard (details, contact, verification method, review)
- Trust Registry sidebar link in portal navigation
- `web/registry.html` — landing page with live search, featured orgs, verification methods, embeddable trust badge demo
- `docs/features/trust-registry.mdx` — feature documentation (data model, API endpoints, SDK usage, embeddable widget)
- `docs/guides/trust-registry-setup.mdx` — step-by-step registration and verification guide

#### @grantex/dpdp — DPDP Act 2023 & EU AI Act Compliance
- `@grantex/dpdp` package — DPDP Act 2023, GDPR, and EU AI Act compliance module for AI agent deployments
- `DPDPConsentRecord` — structured consent records with purpose mapping, retention periods, and DPDP section references
- `DPDPClient.createConsentRecord()` — create DPDP-compliant consent records linked to Grantex grants
- `DPDPClient.withdrawConsent()` — one-click consent withdrawal with instant grant revocation and cascade
- `DPDPClient.checkPurposeAdherence()` — verify agents stay within declared processing purposes
- `DPDPClient.exportAudit()` — generate framework-specific audit exports (DPDP, GDPR, EU AI Act)
- `DPDPClient.submitGrievance()` — data principal grievance mechanism with SLA tracking
- `DPDPClient.exportPrincipalData()` — data principal data export (DPDP S.11 / GDPR Art.20)
- Data principal portal with consent management, activity history, and grievance submission
- Compliance dashboard with consent status, purpose adherence, and withdrawal metrics
- DPDP Act 2023 section-by-section compliance mapping documentation
- EU AI Act article-by-article compliance mapping documentation
- DPDP compliance landing page at `grantex.dev/dpdp`
- Blog post: "DPDP Act 2023 and AI Agents: What Your Engineering Team Must Know"

#### @grantex/gemma — Offline Authorization for Gemma 4
- `createConsentBundle()`: Issue offline-capable consent bundles (online, once)
- `createOfflineVerifier()`: < 5ms JWT verification with zero network calls
- `createOfflineAuditLog()`: Ed25519-signed, hash-chained local audit log
- `auditLog.sync()`: Batch sync offline entries when connectivity restores
- `withGrantexAuth()` adapter for Google ADK tool wrapping
- LangChain adapter
- New backend endpoints: POST /v1/consent-bundles, POST /v1/audit/offline-sync,
  GET /v1/consent-bundles/:bundleId/revocation-status
- Examples: Android (Kotlin), Raspberry Pi (Python), iOS (Swift bridging)
- `grantex init gemma` CLI scaffold command

#### grantex verify CLI enhancement
- Full token inspection: scopes, expiry, delegation chain, signature
- `--check-revocation`: live revocation status check
- `--json`: machine-readable JSON output for scripting
- `--verbose`: full JWT header and claims display
- `--jwks-file`: offline verification from local JWKS file
- `--stdin`: pipe token from stdin
- `grantex decode`: decode without verify (jwt.io equivalent)
- `grantex audit inspect`: local audit log viewer
- `grantex audit verify`: hash chain integrity check
- `grantex registry lookup`: registry DID lookup from CLI
- `grantex registry verify-dns`: DNS verification from CLI

#### @grantex/mcp-auth GA — OAuth 2.1 + PKCE for MCP Servers
- `@grantex/mcp-auth` GA release — OAuth 2.1 + PKCE authorization server for any MCP server
- `createMcpAuthServer()` — single function call to register six RFC-compliant endpoints
- OAuth 2.1 authorization endpoint with mandatory PKCE S256 (no `plain`, no implicit grant)
- Dynamic Client Registration (RFC 7591) at `/register`
- Server metadata discovery (RFC 8414) at `/.well-known/oauth-authorization-server`
- Token introspection (RFC 7662) at `/introspect` with Grantex-specific claims
- Token revocation (RFC 7009) at `/revoke` with per-RFC 200 OK semantics
- Express.js middleware (`requireMcpAuth`) for JWT validation with scope enforcement
- Hono middleware (`requireMcpAuth`) with the same API surface
- `McpGrant` decoded token type with `sub`, `agentDid`, `scopes`, `grantId`, `delegationDepth`
- Custom `ClientStore` interface for persistent client registrations (Postgres, Redis, etc.)
- Consent UI customization (`appName`, `appLogo`, `privacyUrl`, `termsUrl`)
- Lifecycle hooks (`onTokenIssued`, `onRevocation`) for audit logging
- Per-endpoint rate limiting (10/min authorize, 20/min token, 30/min introspect)
- MCP Server Certification program — Bronze, Silver, and Gold tiers
- MCP Server Registry with certification badges and scope listings
- 13 automated conformance checks for MCP auth compliance
- Landing page at `grantex.dev/mcp`
- Mintlify docs: `features/mcp-auth-server` and `guides/mcp-certification`

### Changed
- Dashboard: New Bundles section for consent bundle management
- API: `POST /v1/authorize` accepts optional `offlineTTL` parameter

### Security
- Offline verifier: algorithm confusion attack (alg:none, HS256) blocked
- PKCE code_verifier comparison: timing-safe across all runtimes

## [0.2.4-mpp] - 2026-03-20

### Added
- `@grantex/mpp` package — agent identity and delegation for MPP (Machine Payments Protocol)
- `AgentPassportCredential` — W3C VC 2.0 credential type for MPP agent identity
- `POST /v1/passport/issue` — issue an agent passport credential
- `GET /v1/passport/:id` — retrieve a passport
- `POST /v1/passport/:id/revoke` — revoke a passport (flips StatusList2021 bit)
- `GET /v1/trust-registry/:orgDID` — public org trust record lookup
- `verifyPassport()` — merchant-side offline passport verification (<50ms on warm cache)
- `requireAgentPassport()` — Express middleware for passport verification
- `createMppPassportMiddleware()` — fetch middleware to attach passport headers
- `lookupOrgTrust()` — trust registry client with in-memory caching
- `grantex.passports` namespace in `@grantex/sdk` (issue, get, revoke, list)
- `agent-passport` as a valid `credentialFormat` in `POST /v1/token`
- MPP Payment Scopes (`payments:mpp:*`) in SPEC.md §4.2
- SPEC.md §15 — MPP Agent Passport specification
- Trust registry database table with 5 seeded demo orgs
- MPP demo service (`apps/mpp-demo-service/`) — MPP 402 flow simulator
- MPP demo UI (`apps/mpp-demo/`) — 3-screen interactive demo (issue, flow, verify)
- W3C JSON-LD context document at `grantex.dev/contexts/mpp/v1`
- E2E test for full MPP passport lifecycle

## [0.1.5] - 2026-03-01

### Added
- Principal sessions — `POST /v1/principal-sessions` creates short-lived session JWTs for end-users
- End-user permissions dashboard — `GET /permissions` serves HTML self-service UI
- Three principal endpoints: `GET /v1/principal/grants`, `GET /v1/principal/audit`, `DELETE /v1/principal/grants/:id`
- Express middleware (`@grantex/express`) — drop-in Grantex token verification for Node.js APIs
- FastAPI middleware (`grantex-fastapi`) — drop-in Grantex token verification for Python APIs
- Go SDK (`github.com/mishrasanjeev/grantex-go`) v0.1.0 — 12 resource services, offline JWT verification, PKCE, webhook HMAC-SHA256
- Service provider adapters (`@grantex/adapters`) — Google Calendar, Gmail, Stripe, Slack
- Reverse-proxy gateway (`@grantex/gateway`) — YAML-configured, Fastify-based token verification proxy
- `principalSessions.create()` in TypeScript and Python SDKs
- Conformance suite: principal-sessions test suite

### Changed
- Bumped `@grantex/sdk` to 0.1.5 and `grantex` (Python) to 0.1.5
- Bumped `@grantex/conformance` to 0.1.2

## [0.1.4] - 2026-02-28

### Added
- Token refresh — `POST /v1/token/refresh` with single-use rotation per SPEC §7.4
- `tokens.refresh()` method in TypeScript and Python SDKs
- Conformance suite: token refresh tests
- Troubleshooting guide in docs

### Changed
- Bumped `@grantex/sdk` to 0.1.4 and `grantex` (Python) to 0.1.4

## [0.1.3] - 2026-02-28

### Added
- PKCE (S256) support in authorization and token exchange flows
- `generatePkce()` helper in TypeScript SDK
- `generate_pkce()` helper in Python SDK
- Rate limiting on auth-service (100/min global, 20/min token, 10/min authorize)
- CHANGELOG.md, CODE_OF_CONDUCT.md, issue templates, PR template

### Changed
- Bumped `@grantex/sdk` to 0.1.3 and `grantex` (Python) to 0.1.3

### Fixed
- "ML-based detection" copy corrected to "Pattern-based detection" on landing page

## [0.1.2] - 2026-02-27

### Added
- `tokens.exchange()` method to TypeScript and Python SDKs for exchanging authorization codes for grant tokens
- Python examples for the token exchange flow
- OpenAI Agents SDK integration (`grantex-openai-agents`)
- Google ADK integration (`grantex-adk`)
- MCP server package (`@grantex/mcp`) with 13 tools for Claude Desktop / Cursor / Windsurf
- Health endpoint (`GET /health`) in auth-service
- CLI commands for policies, billing, SCIM, and SSO
- Portal webhooks management page
- Webhook retry with exponential backoff (persistent delivery table + background worker)
- Anomaly detection background worker (runs every 60 minutes)
- Plan limit enforcement for grants, audit entries, and policies

### Changed
- Bumped `@grantex/sdk` and `grantex` (Python) to 0.1.2
- Webhook delivery is now persistent with retry instead of fire-and-forget

## [0.1.1] - 2026-02-26

### Added
- CrewAI integration (`grantex-crewai`) published to PyPI
- Vercel AI SDK integration (`@grantex/vercel-ai`)
- AutoGen integration (`@grantex/autogen`)
- CLI tool (`@grantex/cli`) with commands for agents, grants, tokens, audit, and anomalies
- LangChain integration (`@grantex/langchain`)
- Example apps: quickstart-ts, quickstart-py, langchain-agent, crewai-agent, vercel-ai-chatbot
- Developer portal with React dashboard (agents, grants, audit, policies, anomalies, compliance, billing, settings)
- Landing page deployed to Firebase Hosting at grantex.dev
- Comprehensive documentation across all packages

### Changed
- Bumped integration packages to 0.1.1

### Fixed
- Compliance timestamptz cast using null instead of empty string
- Startup migration runner for production DB schema

## [0.1.0] - 2026-02-25

### Added
- Protocol specification v1.0 (SPEC.md)
- Auth service (Fastify + PostgreSQL + Redis) with full API surface:
  - Authorization flow (`POST /v1/authorize`, consent, approve/deny)
  - Token exchange, verification, and revocation
  - Grant management with delegation support
  - Tamper-evident audit log with hash chaining
  - Anomaly detection (rate spikes, high failure rates, new principals, off-hours activity)
  - Policy engine (allow/deny rules with priority, scopes, time-of-day constraints)
  - SCIM provisioning (users + tokens)
  - SSO configuration (OIDC)
  - Billing integration (Stripe)
  - Webhook registration and delivery
  - JWKS endpoint for offline token verification
- TypeScript SDK (`@grantex/sdk`) published to npm
- Python SDK (`grantex`) published to PyPI
- CI/CD pipelines (GitHub Actions): CI, deploy, CodeQL, dependency review
- Cloud Run deployment configuration
- Docker Compose for local development

## Ownership

Grantex is owned by Orchestrum Technologies LLP. Inventor and owner: Sanjeev Kumar. Ownership contact: [sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in) or [mishra.sanjeev@gmail.com](mailto:mishra.sanjeev@gmail.com).
