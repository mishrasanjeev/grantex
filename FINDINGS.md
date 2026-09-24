# Findings

Defects found while doing other work and deliberately left out of that change.
Each entry says where it was found, what is wrong and what fixing it involves.
Remove an entry in the pull request that fixes it.

Numbers are permanent: they appear in commit messages, changelog entries and
code comments (`FINDINGS G-17` and `FINDINGS G-18` are cited in source today,
and the release harnesses cite `FINDINGS G-23`), so a fixed or withdrawn
finding leaves its number behind rather than having it reused. **Retired:
G-5, G-9** (fixed and removed before this file was kept under review) and
**G-19, G-20** (renumbered to G-24 and G-25 while three branches were open at
once, before either had merged — no other branch or commit ever referred to
them).

Cite a finding as **`FINDINGS G-nn`**, never as a bare `G-nn`: `G-3`, `G-5`
and `G-6` are also PRD section numbers, and "PRD G-6" appears in source dozens
of times, so a bare citation cannot be grepped for reliably. An entry that
lives on an unmerged branch is not citable from code yet — put the entry in
the pull request that references it.

## G-1 — OpenSSL in the auth-service base image has a fixable HIGH advisory

- **Found:** container scan of `apps/auth-service` (2026-09-14).
- **What:** `node:26-alpine@sha256:2d984a15…` ships `libcrypto3` and `libssl3`
  3.5.7-r0, affected by CVE-2026-14456 (fixed in 3.5.8-r0).
- **Fix:** move the pinned base image digest in `apps/auth-service/Dockerfile`
  to a build carrying openssl 3.5.8-r0 or later, rebuild, rescan and drop the
  two entries from `.trivyignore.yaml`.

## G-2 — npm's bundled dependencies in the runtime image have fixable HIGH advisories

- **Found:** container scan of `apps/auth-service` (2026-09-14).
- **What:** the base image's global npm carries `brace-expansion` 5.0.7
  (CVE-2026-14257, CVE-2026-69152), `ip-address` 10.2.0 (CVE-2026-69192) and
  `tar` 7.5.19 (CVE-2026-73566). These are npm's own dependencies, not the
  service's, but they are present in the production image.
- **Fix:** a newer base image, or removing npm from the runtime stage once
  dependencies are installed (the service runs with `node`, not `npm`).

## G-3 — Native TypeScript compiler binary is shipped in the production image

- **Found:** container scan of `apps/auth-service` (2026-09-14).
- **What:** `npm ci --omit=dev` still installs `typescript` and
  `@typescript/typescript-linux-x64` into `/app/node_modules`, pulled in by a
  production dependency (at least `@opentelemetry/instrumentation-grpc`
  references it). The Go-built binary carries ten fixable HIGH advisories in
  its Go standard library and `golang.org/x/text`. The runtime does not need a
  compiler.
- **Fix:** find the dependency path (`npm ls typescript --omit=dev` in
  `apps/auth-service`), then exclude it from the runtime install or prune it in
  the Dockerfile, and drop the ten entries from `.trivyignore.yaml`.

## G-4 — The OAuth agent-grants flow does not validate tools entries in `authorization_details`

- **Found:** adding purpose-bound grants (2026-09-15).
- **What:** `POST /oauth/par` in `apps/auth-service/src/routes/oauth.ts` accepts
  any typed `authorization_details` objects from the client and copies them
  into the consented grant and its access token. A `urn:grantex:tools:v1`
  entry pushed there is not checked. It can carry a purpose outside the
  vocabulary, an unknown key, or duplicate connectors, all of which
  `POST /v1/authorize` refuses and the SDKs' `enforce()` denies. The consent
  page shows such entries only as raw JSON, and `grants.purpose` is not set
  for OAuth grants.
- **Fix:** validate `urn:grantex:tools:v1` entries in the PAR handler with the
  same rules as `apps/auth-service/src/lib/purpose.ts` and the SDK parsers
  (known purpose, connector name, no unknown keys, one entry per connector,
  well-formed `tools` and `caps`). Reject with `invalid_authorization_details`,
  persist the purpose on the grant, and show it on the consent page.

## G-6 — mcp-auth uses the OAuth client id as the Grantex principal

- **Found:** `@grantex/mcp-auth` 3.0 work (PRD G-7), 2026-09-15.
- **What:** `startUpstreamAuthorization` in
  `packages/mcp-auth/src/endpoints/authorize.ts` calls `grantex.authorize`
  with `userId: client_id` (unchanged from 2.x). Every person who authorizes
  through one MCP client gets grants for the same principal, and a
  metadata-document client's id is a public URL shared by every
  installation. `/revoke` also relies on it (`sub` must equal the
  authenticated client), and grant lists or audit by principal cannot tell
  people apart.
- **Fix:** establish the person's identity during the consent step (host
  authentication hook or the Grantex consent result) and pass it as the
  principal; change the revocation ownership check to use the grant's client
  binding rather than `sub`.

## G-7 — mcp-auth `/revoke` hides upstream revocation failures

- **Found:** `@grantex/mcp-auth` 3.0 work (PRD G-7), 2026-09-15.
- **What:** `packages/mcp-auth/src/endpoints/revoke.ts` catches and ignores any
  error from `grantex.tokens.revoke` (RFC 7009 lets it answer 200). 3.0 records
  the revocation in its own storage first, so this server and middleware
  sharing that storage refuse the token, but Grantex and every other verifier
  may still accept it, and nothing logs or counts the failure.
- **Fix:** log the failure with the `jti` and a reason code, count it, and
  retry the upstream revocation from a durable queue until it succeeds.

## G-8 — Verifiers outside the core SDKs pin RS256

- **Found:** adding ES256 signing (2026-09-15).
- **What:** these reject every token or key from a deployment that sets
  `JWT_SIGNING_ALG=ES256`, and some already disagree with the default JWK Set:
  - `packages/cli/src/commands/verify.ts` calls `jwtVerify` with
    `algorithms: ['RS256']`.
  - `packages/gemma/src/verifier/jwks-cache.ts` and `offline-verifier.ts`, and
    `packages/gemma-py/src/grantex_gemma/_verifier.py`, accept only RS256.
  - `packages/mpp/src/verifier.ts` verifies agent passports with RS256 only;
    passports are signed with the platform signing key.
  - `packages/conformance/src/suites/security.ts` ("JWKS only contains RS256
    keys") fails whenever the JWK Set holds any other key. The auth service
    always publishes an EdDSA key (`initEdKey` generates one), so this check
    already fails against a default deployment.
- **Fix:** accept `RS256` and `ES256` with key-type matching by `kid` (as the
  core SDKs now do), and change the conformance check to "every platform
  signing key is RS256 or ES256 with `kid`, `alg` and `use: sig`", ignoring
  keys published for other purposes.

## G-10 — `POST /v1/authorize` cannot request caps or decision references

- **Found:** aligning grant token claims with the OAuth profile (2026-09-15).
- **What:** `authorization_details` in grant tokens can carry per-grant caps
  (`caps` in `urn:grantex:tools:v1`) and decision references
  (`urn:grantex:decision:v1`), and the SDKs enforce both. But
  `POST /v1/authorize` only accepts `purpose`, and
  `apps/auth-service/src/lib/purpose.ts` builds tools entries with
  `connector` and `purpose` only. Tokens from the Grantex flow therefore never
  carry them. The OAuth PAR flow copies client-supplied entries unchecked
  (G-4).
- **Fix:** accept and validate `caps`, `tools`, `data_region` and decision
  references on the authorization request (the same rules as the SDK
  parsers), show them on the consent page, store them on the grant, and cover
  them in `spec/grant-token-0.6.md` issuance tests.

## G-11 — Scopes containing whitespace are accepted outside authorization requests

- **Found:** aligning grant token claims with the OAuth profile (2026-09-15).
- **What:** `POST /v1/authorize` now refuses scopes containing whitespace, but
  agent registration (`apps/auth-service/src/routes/agents.ts`) and consent
  bundles (`apps/auth-service/src/routes/consent-bundles.ts`) still accept
  them. Tokens for such scopes omit the space-delimited `scope` claim and rely
  on the deprecated `scp` alias, so they stop working for standard-only
  readers and once legacy claims are off in 0.7.
- **Fix:** validate scopes as RFC 6749 scope-tokens (printable ASCII, no
  space, `"` or `\`) at agent registration and consent-bundle creation,
  returning `400 INVALID_SCOPE`, and plan a migration for stored grants that
  already hold such scopes before 0.7.

## G-12 — Integrations read legacy grant token claims directly

- **Found:** aligning grant token claims with the OAuth profile (2026-09-15).
- **What:** these read `agt`, `dev`, `grnt` or `scp` from decoded tokens
  instead of the SDK's `VerifiedGrant`:
  - `packages/a2a`, `packages/a2a-py`
  - `packages/anthropic`, `packages/crewai`, `packages/google-adk`,
    `packages/openai-agents`, `packages/strands`, `packages/strands-py`,
    `packages/vercel-ai`
  - `packages/cli` (`verify`)
  - `packages/gemma`, `packages/gemma-py`
  - `packages/mcp-auth` (`endpoints/introspect.ts` and the Express and Hono
    middleware)

  They keep working while `GRANT_TOKEN_LEGACY_CLAIMS=true`. They break against
  a deployment that sets it to `false`, and by default from 0.7.
- **Fix:** read `scope`, `client_id`, `act` and `urn:grantex:grant` (or use
  the core SDK verifiers' `VerifiedGrant`) before 0.7. Coordinate the
  `mcp-auth` change with the open 3.0 pull requests.

## G-13 — Audit chain entries written in the same millisecond can fork the chain

- **Found:** evidence package export work (PRD G-5), 2026-09-15.
- **What:** `POST /v1/audit/log` (`apps/auth-service/src/routes/audit.ts`) and
  `appendDecisionAudit` take the chain head with
  `ORDER BY timestamp DESC, id DESC` and stamp the new entry with
  `new Date().toISOString()`. Two entries for one developer in the same
  millisecond get equal timestamps, and `newAuditEntryId()` uses the
  non-monotonic `ulid()`, so the later entry's id can sort before the earlier
  one. The next writer then links to the wrong head, and chain verification
  (`/v1/compliance/evidence-pack`, `audit-log verify`) reports a broken link
  that is not tampering. The evidence endpoints avoid it for their own entries:
  they stamp `max(now, head timestamp)` and, within the head's millisecond,
  derive an id that sorts after the head's.
- **Fix:** stamp every audit entry with `max(now, head timestamp + 1 ms)` under
  the existing advisory lock (or use `monotonicFactory()` for audit ids), in
  every writer of `audit_entries`.

## G-14 — Evidence records containing U+0000 fail with a 500

- **Found:** evidence package export work (PRD G-5), 2026-09-15.
- **What:** JSONB cannot store the code point U+0000 in a string. A record
  whose strings contain it passes schema validation in
  `POST /v1/evidence/cases/{caseId}/records` (and any `POST /v1/audit/log`
  metadata containing it) and then fails on insert with an unhandled database
  error instead of a 400 with a reason code.
- **Fix:** refuse U+0000 in audit metadata and evidence record strings before
  the insert, with `BAD_REQUEST` / `EVIDENCE_RECORD_INVALID` and the field path.

## G-15 — SSO ID-token verification does not refresh the JWKS for an unknown `kid`

- **Found:** decision grants (PRD G-3), 2026-09-15.
- **What:** `verifyIdToken` in `apps/auth-service/src/lib/sso.ts` caches an
  identity provider's JWKS for one hour and only refetches when the cache is
  older than that. A token signed with a key the provider rotated in within
  the hour fails verification until the cache expires, so SSO logins fail
  (closed) after a provider key rotation. The decision-grant approver sign-in
  has its own verification with a rate-limited refetch and is not affected.
- **Fix:** on a `kid` not in the cached set, refetch once, rate-limited by a
  cooldown (as `createRemoteJWKSet` and the Python SDK's JWKS cache do), and
  add a test with a rotated provider key.

## G-16 — SSO discovery does not check the issuer, and ID tokens are checked against the discovered issuer

- **Found:** review of decision grants (PRD G-3), 2026-09-15.
- **What:** `discoverOidcProvider` in `apps/auth-service/src/lib/sso.ts` accepts
  any `issuer` in the discovery document fetched from an SSO connection's
  `issuer_url`, and `verifyIdToken` then verifies `iss` against
  `discovery.issuer` rather than the configured `issuer_url`. OpenID Connect
  Discovery 1.0 section 4.3 requires the two to be identical. A discovery
  document served from the configured host can therefore name another issuer
  whose tokens SSO login accepts. Decision grants do not use this code (their
  approver sign-in checks the issuer itself), but SSO login does.
- **Fix:** refuse a discovery document whose `issuer` differs from the
  configured `issuer_url`, verify `iss` against the configured value, and add
  tests for both.

## G-17 — The decision-grant migration test sees another test's tables (fixed)

- **Found:** event bridge cascade revocation work (PRD G-6), 2026-09-20.
- **What:** `tests/decision-grants-postgres.integration.test.ts` asserted the
  `decision_%` tables by querying `information_schema.tables` without a schema
  predicate. `tests/evidence-postgres.integration.test.ts` creates its own
  schema containing `decision_requests` and `decision_grants`, so when the two
  files ran at the same time against one database the assertion saw duplicate
  names and failed.
- **Fixed:** the query is now scoped with `AND table_schema = current_schema()`.

## G-18 — Every startup re-ran `ALTER TABLE grants` against live traffic (fixed)

- **Found:** event bridge cascade revocation work (PRD G-6), 2026-09-20;
  reproduced independently on merged `main`.
- **What:** `runMigrations` had no ledger and re-executed all migration files on
  every process start, ten of them `ALTER TABLE grants ADD COLUMN IF NOT
  EXISTS …`. Postgres takes the `ACCESS EXCLUSIVE` lock **before** evaluating
  `IF NOT EXISTS`, so a no-op statement still queued behind any in-flight
  transaction on `grants`, and every reader arriving afterwards queued behind
  that request — `/v1/authorize`, token exchange, delegation and every enforce
  path. No `lock_timeout` was set, so the stall was unbounded. On each merge to
  `main` the starting instance could stall the running one's live traffic.
  Seen in the Postgres log as migration 095's `ALTER TABLE …` waiting for
  `AccessExclusiveLock` on `audit_entries` while a cascade transaction waited
  for `AccessShareLock` on `grants` (a deadlock, the visible tip of the same
  hazard).
- **Fixed:** a `schema_migrations` ledger (filename, checksum, applied-at)
  applies each file once per database, so a repeat start issues no DDL at all;
  the applying session sets `lock_timeout` (`MIGRATION_LOCK_TIMEOUT`, default
  2 s) and retries, so a boot that cannot take a lock fails loudly instead of
  stalling a table; an index a cancelled `CREATE INDEX CONCURRENTLY` left
  `INVALID` is dropped before its file is retried, since `IF NOT EXISTS`
  matches such an index by name and would otherwise skip it forever.
  Revocation transactions also retry on `deadlock_detected`
  (`lib/revocation/retry.ts`).
- **Also fixed after review:** `lock_timeout` is a *session* setting and the
  migration connection returns to the pool, so it leaked onto one pooled
  connection for the life of the process — roughly one statement in `max`
  would abort with `55P03` instead of waiting for a contended row, on the
  revocation, wallet-reservation, refresh-rotation and audit-trigger paths. It
  is now reset before the connection is released, on every path.
- **Left:** nothing, once the database is baselined. The first start on a
  database that predates the ledger still applies every file (that is what
  fills it), which is safe but fails the boot if a transaction holds a `grants`
  row past `MIGRATION_LOCK_TIMEOUT`. `node dist/cli/migrate-baseline.js`
  records the files without executing them, so run it on an at-head database
  immediately before that deploy; see `docs/self-hosting.md` section 6.

## G-21 — Subject bindings are stored in plaintext

- **Found:** event bridge mapping work (PRD G-6), 2026-09-20; confirmed open in review.
- **What:** `grant_subject_refs.value` holds the identifier a developer binds a
  grant to — a company registration number, a tax id, an account id at the
  provider. It is stored as plaintext, so anyone with read access to the
  database or a backup of it can enumerate which identifiers a developer is
  operating on, and join them to principals and agents. Every other
  developer-supplied secret in this service is encrypted with
  `encryptWithContext`.
- **Why not fixed here:** matching needs equality lookups (`by: subject_ref`
  resolves a `kind`/value pair to grants on every delivery), so it wants a
  keyed hash for lookup and an encrypted copy for display, plus a migration
  that rewrites existing rows and a decision about what the API returns. That
  is its own change.
- **Impact:** confidentiality of the binding values, not authorization
  correctness. The bridge never echoes a stored value back to an
  unauthenticated caller.

## G-22 — The emergency stop cannot lock a tenant out

- **Found:** emergency stop work (PRD G-6), 2026-09-20; accepted in review as
  documented rather than closed.
- **What:** the stop revokes every grant the scope covers, sweeping until the
  scope comes back empty, and then it is finished. It does not prevent new
  grants being issued a second later: whoever holds the developer's API key
  can call `POST /v1/authorize` and mint another one. For the incident this
  control exists for — a leaked credential — that means the containment
  measure does not, by itself, contain anything unless the credential is
  rotated first.
- **Disclosed, not hidden:** the response says `lockout: false`, the runbook
  has a "What it does not do" section giving the ordered rotate-then-stop
  procedure, and the OpenAPI description, concepts page and changelog all say
  the same. The release test asserts that a grant minted after a stop is
  **live**, so the behaviour cannot drift away from the documentation
  silently.
- **Follow-up:** a real lockout — a tenant-level or credential-level freeze
  that refuses issuance until an operator lifts it — is its own feature. It
  needs a state the authorization path reads on every issuance, an
  authenticated way to lift it, and a decision about what happens to agents
  mid-task. Tracked here so "the incident control does not stop the incident"
  stays visible.

## G-23 — Revoking during an incident is rate-limited like ordinary traffic

- **Found:** review of the propagation measurement (PRD G-6), 2026-09-21.
- **What:** the plan limiter counts `DELETE /v1/grants/:id` and the emergency
  stop in the same per-developer bucket as every other call (100 req/min on
  the free plan), so containment competes with ordinary traffic for the
  tenant's quota. The 26–58 s waits the harness saw came from *it* bursting
  hundreds of revokes in a row, which no incident looks like — an emergency
  stop is a single request that revokes a whole tree. The realistic case is
  milder: a free-plan tenant already near its quota, or an operator scripting
  revocations one grant at a time, waiting out `Retry-After` on the one path
  that ends the incident.
- **Proposal:** put containment calls in a bucket of their own —
  `DELETE /v1/grants/:id`, `POST /v1/grants/:id/suspend`,
  `POST /v1/emergency-stop` — sized for the shape of the work (a burst of a
  few hundred, refilling slowly) and counted separately from the plan quota.
  Revocation is idempotent and reduces load rather than creating it, so the
  abuse case the plan limiter protects against does not apply. Keep a limit:
  an unbounded revoke endpoint is still a way to make the database work.
- **Impact:** slow containment, on the free plan only, and a misleading
  propagation measurement if the limiter is not accounted for.

## G-24 — Postgres integration tests share one database, which flakes (fixed)

- **Found:** review of the migration ledger (PRD G-6), 2026-09-21.
- **What:** every `*-postgres.integration.test.ts` file runs against the same
  database, and several call `runMigrations` in their setup. Concurrent runs
  can deadlock inside the runner: the reviewer saw
  `PostgresError: deadlock detected` inside `runMigrations` once in two full
  suite runs, and the file passed in isolation. The ledger makes this much
  rarer (a repeat run issues no DDL) but does not remove it, because the first
  file to reach the ledger still applies everything.
- **Not fixed here:** giving each integration file its own database — as
  `tests/migrate-ledger-postgres.integration.test.ts` already does with
  `CREATE DATABASE` — would remove the class of flake entirely. It touches
  every integration file, so it does not belong in this PR. **Next after this
  stack lands:** branch protection requires green CI, so a flake at this rate
  teaches everyone to re-run without reading the failure, which is how a real
  failure gets waved through.
- **Impact:** an occasional red CI run that is green on re-run.
- **Fixed:** every integration file now creates a database of its own
  (`createTestDatabase` in `tests/helpers/database.ts`, #1343).
  `scripts/migration-contention-probe.mjs` (`npm run probe:migrations`)
  reproduces the deadlock in the shared shape and not in the per-file one.
  Keeping it fixed is G-30.

## G-25 — A migration seeds real third-party company DIDs

- **Found:** review of the migration ledger (PRD G-6), 2026-09-21.
- **What:** `062_trust_registry_verification_token.sql` hardcodes
  `did:web:shopify.com`, `did:web:doordash.com` and `did:web:pinelabs.com` in
  its seed data. These are real companies that have no relationship with this
  project, and the rows are indistinguishable from a real trust-registry
  entry — exactly what the "no data that could be mistaken for real" rule
  exists to prevent. Pre-existing, unrelated to this PR.
- **Not fixed here:** the values are already applied in every existing
  database, so replacing them means a new migration that rewrites the rows,
  plus checking nothing keys off those DIDs. Worth doing on its own.
- **Impact:** presentational and legal, not functional.

## G-26 — The feed's settle window measures insert time, not commit time

- **Found:** review of the revocation feed (PRD G-6), 2026-09-21.
- **What:** `settledCursor` holds the cursor back from entries younger than
  `REVOCATION_FEED_SETTLE_SECONDS`, so a transaction still in flight cannot
  have its entry skipped. It measures that with `created_at`, which is set
  when the row is **inserted**, not when its transaction **commits**. A
  transaction that inserts a feed row and then runs for longer than the settle
  window would have its entry passed over: the cursor advances past a sequence
  number that was not yet visible.
- **Why it has not bitten:** the entries are written by AFTER triggers on
  `grants` and `grant_tokens`, at the end of revocation transactions that are
  short by construction (the cascade batches at 200 roots), and the default
  window is 15 s. The sequence numbers also come from a sequence, so a gap is
  visible in principle but nothing reads it that way yet.
- **The real fix:** compare against `pg_xact_commit_timestamp(xmin)` (requires
  `track_commit_timestamp = on`), or track the oldest in-progress transaction
  id with `pg_snapshot_xmin(pg_current_snapshot())` and hold the cursor behind
  it. Either is a change to how the feed reasons about visibility, not a
  tweak, so it wants its own PR and its own test.
- **Impact:** a revocation could be missed by streaming clients under a very
  long revocation transaction. Snapshot readers (`GET /v1/revocations`) are
  unaffected, and a client that reconnects re-reads the snapshot.

## G-27 — Helpers still widen a transaction handle back to the pool (fixed)

- **Found:** review of the `TxSql` typing fix (PRD G-6), 2026-09-21.
- **What:** #1338 made `TxSql` the real transaction type, so `tx.begin(…)` is
  a compile error — but a handful of call sites widened a transaction handle
  back to the pool type on the way into a helper, which put `begin` back
  within reach of anything that helper called: `vc.ts:119`
  (`claimIndexFromExistingList`), `evidence-service/service.ts:417/539/773`,
  `budget.ts:77`, `signing-keys.ts:499/561/610`, `event-actions.ts:134`, and
  `revocation/emergency-stop.ts` (narrowed while merging #1333). A nested
  transaction on a passed-in handle throws `sql.begin is not a function`,
  aborts the caller's transaction and rolls its work back — how a cascade
  revocation once left grants active while reporting success.
- **Fixed:** every `sql.begin(async (raw) => …)` callback in the service — 114
  of them — now types its handle as a transaction, and the helpers those
  callbacks reach take `TxSql` rather than the pool type: `lockAndHead`,
  `caseState`, `caseConsumed`, `auditEntryCount`, `loadGrantChain`,
  `loadDecisions`, `loadStoredRecords`, `insertPlatformAudit`, `insertKey`,
  `claimIndexFromExistingList`. Pool-side callers of those helpers go through
  `queries()`.
- **On the private aliases:** a file-local `type Sql = ReturnType<typeof
  postgres>` is not itself the bug — 45 files have one and it correctly means
  "the pool". The bug is handing a transaction to a parameter of that type,
  and that is now a compile error wherever it happens, whichever alias the
  file uses. `emergency-stop.ts` is the example: its private alias meant the
  shared fix did not reach it, and the compiler objected the moment the alias
  it *did* use was narrowed.
- **`queries()`** returned something typed as a transaction, which promises a
  `savepoint` the pool does not have. The type cannot take it away — an
  intersection that removes it also removes the tagged-template call
  signature, which is the whole point of the type — so the value does: the
  pool is wrapped so that reaching for `savepoint` throws where the mistake is
  made, naming it, instead of failing inside postgres.js. `vc.ts:417` no
  longer goes around `queries()` with a cast.
- **Guarded by** `tests/tx-sql-type.test.ts`: `@ts-expect-error` on
  `tx.begin(…)` and on the pool's `begin`, a probe that a query-only handle is
  accepted where a transaction is wanted, and a runtime case for the
  `savepoint` refusal.

## G-28 — The revocation stream advanced its cursor before writing

- **Found:** automated review of the revocation feed (PRD G-6), 2026-09-21.
- **What:** `routes/revocations.ts` moved the stream's cursor past an entry
  before `reply.raw.write` had succeeded. A transient write failure on a
  still-open socket therefore left the hub believing the entries were
  delivered, the route's cursor past entries nobody received, and the
  subscriber still attached — while heartbeats went on reporting the stream
  healthy. The client never learned about those revocations.
- **Fixed:** in PR #1337. The write happens first and the cursor advances
  after it, and a throwing write ends the stream instead of being logged and
  ignored, so the client reconnects and replays from its own cursor.
- **Left: nothing, and the reason is measured.** There is no test for the
  throwing-write path because **there is no throwing-write path**. Against a
  real HTTP server on an ephemeral port under Node 24, with the peer
  destroyed, with `res.end()` already called, and with the socket destroyed,
  `res.write()` returned `false` every time and never threw; with no `'error'`
  listener — which is how this route is written — there was no uncaught
  exception either, and the peer disconnect fired `request.raw.on('close')` so
  cleanup ran normally. Node signals a dead-socket write by returning `false`
  and reporting asynchronously, not by throwing. A test built on "destroy the
  socket and expect a throw" would therefore have gone green while proving
  nothing.
  The `catch` around the subscriber's `send()` stays as defence-in-depth: it
  costs nothing, and it covers a future write path that does throw
  (a compression or framing layer, say). It is not the guard against a dead
  socket. **A writer seam to make the branch testable was considered and
  rejected**: five lines of production surface for a branch neither reviewer
  could construct is the wrong trade.
- **The real exposure is next door:** see G-29.

## G-29 — The revocation stream ignores what `write()` tells it

- **Found:** measurement of the stream's failure modes (PRD G-6), 2026-09-21.
- **What:** `res.write()` returns `false` when the socket's buffer is full,
  and that is how Node reports a dead or slow peer — it does not throw (see
  G-28). `routes/revocations.ts` discards the return value on both the data
  path and the heartbeat, so a client that has stopped reading, or one behind
  a stalled proxy, accumulates entries in the process's memory for as long as
  the connection is held open. Nothing sheds load, nothing logs it, and the
  heartbeat keeps writing into the same buffer every second.
- **Why it matters:** this is the live failure mode in this area, and the only
  one left: the throwing-write branch does not exist, and a slow reader does.
  One developer's stuck stream is bounded by the connection cap, but each
  stalled connection holds whatever the feed produces while it is stuck —
  which during a large cascade or an emergency stop is exactly when memory
  matters.
- **Fix:** honour the return value — stop writing while it is `false` and
  resume on `'drain'`, with a bound on how far behind a stream may fall before
  it is closed and told to reconnect (the client replays from its own cursor,
  so closing costs nothing but a reconnect).
- **Also, asymmetric today:** the heartbeat's `write` sits outside the
  try/catch that the data path has (`revocations.ts:300-305`), and the
  heartbeat writes far more often. Harmless while nothing throws, but it
  should be both or neither, with a comment saying which and why.

## G-30 — Nothing stopped a test file from migrating the shared database again (fixed)

- **Found:** review of the G-24 fix, 2026-09-24.
- **What:** the G-24 fix gives each integration file its own database, but
  only by convention. The tenth file was missed in the first pass, and a
  reviewer who pointed it back at the shared database found that it still
  passed: nothing in the suite noticed. Any new file written the old way would
  have brought the deadlock back, one CI run in several.
- **Fixed:** a Vitest `globalSetup` (`tests/global-setup.ts`) records the
  shared database's tables before the run and fails the run afterwards if any
  were added, naming them and `createTestDatabase`. It refuses to start if the
  shared database already holds a `schema_migrations` ledger, because a
  migration into it would then add nothing and a regression would pass unseen.
  It fails closed if it cannot reach the database. With no shared database
  configured it does nothing.
- **Also caught on its first CI run:** the Chromium decision-grant test
  (`tests/e2e/decision-grants-browser.e2e.test.ts`, run by `npm run test:e2e`,
  whose config inherits the guard) migrated the shared database. It ran alone,
  so it never deadlocked, but it left a ledger behind that would make the next
  local `npm test` refuse to start. It now uses `createTestDatabase` too.
- **Proved:** with one file pointed back at the shared database, every test
  passes and the run now exits 1 with the ledger named first.
- **Limit:** it fails the run on names that `information_schema.tables`
  lists after the run but not before, nothing else. That covers ordinary,
  unlogged, partitioned and foreign tables, partitions and views, in any
  schema except the temporary ones, so a table in a newly created schema is
  caught, and so is a rename, which shows up as a new name. It does not see:
  - other DDL on a table that was already there, a table dropped, or rows
    written to one;
  - a table created and dropped within the run, including temporary tables;
  - materialized views, sequences, types, functions, foreign servers, a
    schema left empty, or an extension that creates no table or view;
  - anything outside the shared database, such as roles or other databases;
  - tables the guard's connection has no privilege on, because
    `information_schema` hides them. CI connects as a superuser, so this
    matters only for a local run as a less privileged role.

  The migrations always create tables, so the regression it exists for is
  caught; a test doing only one of the others would not be. None does so to
  the shared database today. The integration files do create and drop
  databases through the shared connection, by design (G-24): through
  `createTestDatabase`, which most files call once and the guard's own test
  file and `migrate-ledger-postgres.integration.test.ts` call in each test
  that needs one. The guard does not see them. A database left behind by a
  failed drop is reported on stderr by `createTestDatabase` (G-31).

## G-31 — The migrate-ledger test drops its databases silently (fixed)

- **Found:** review of the G-30 wording, 2026-09-24.
- **What:** `tests/migrate-ledger-postgres.integration.test.ts` creates a
  database per test through its own `freshDatabase()` and drops it with
  `.catch(() => undefined)` (line 38). A drop that fails leaves the database
  on the Postgres server with nothing said. `createTestDatabase`, which every
  other integration file uses, writes the same failure to stderr.
- **Impact:** a leaked database per failure on a developer's machine; none on
  CI, whose Postgres is discarded after the job. The shared-database guard
  (G-30) does not see databases, so it cannot catch this either.
- **Fixed:** `freshDatabase` is now built on `createTestDatabase`, so there
  is one drop path and it reports a failure. Shown by making the drop fail:
  the run writes `could not drop test database t_migrate_…` to stderr, where
  before it said nothing.
