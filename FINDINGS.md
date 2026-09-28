# Findings

Defects found while doing other work and deliberately left out of that change.
Each entry says where it was found, what is wrong and what fixing it involves.
The pull request that fixes an entry keeps it, adds "(fixed)" to its heading
and a **Fixed:** line saying what changed and how it was shown, so the record
of what went wrong and why stays next to the fix.

Numbers are permanent: they appear in commit messages, changelog entries and
code comments (`FINDINGS G-17` and `FINDINGS G-18` are cited in source today,
and the release harnesses cite `FINDINGS G-23`), so a fixed or withdrawn
finding leaves its number behind rather than having it reused. **Retired:
G-5, G-9** (fixed and removed before this file was kept under review) and
**G-19, G-20** (renumbered to G-24 and G-25 while three branches were open at
once, before either had merged — no other branch or commit ever referred to
them).

Outside this file, cite a finding as **`FINDINGS G-nn`**, never as a bare
`G-nn`: `G-3`, `G-5` and `G-6` are also PRD section numbers, and "PRD G-6"
appears in source dozens of times, so a bare citation cannot be grepped for
reliably. Inside this file, entries cite each other as a bare `G-nn`, and a
PRD section is always written `PRD G-n`, so a bare number here is always a
finding. An entry that
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
  - `packages/mcp-auth` (`endpoints/introspect.ts`)

  They keep working while `GRANT_TOKEN_LEGACY_CLAIMS=true`. They break against
  a deployment that sets it to `false`, and by default from 0.7.
- **Fix:** read `scope`, `client_id`, `act` and `urn:grantex:grant` (or use
  the core SDK verifiers' `VerifiedGrant`) before 0.7. Coordinate the
  `mcp-auth` change with the open 3.0 pull requests.
- **Partly fixed:** the `mcp-auth` resource guard (the Express and Hono
  middleware) reads `scope` and `urn:grantex:grant` first and the aliases only
  as a fallback. `packages/mcp-auth/tests/grant-token-profile.test.ts` shows it
  with the auth service's own tokens from
  `spec/examples/grant-token-0.6.issued.json`, including the standard-only
  ones. `/introspect` still reads only the aliases (G-42).

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

## G-22 — The emergency stop cannot lock a tenant out (fixed)

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
- **Fixed:** a stop can now ask for a lockout, `lockout: true` on
  `POST /v1/emergency-stop` and on the operator's
  `POST /v1/admin/emergency-stop`. It records a freeze (`issuance_freezes`,
  migration `120_emergency_stop_lockout.sql`) in the same transaction as the
  stop's own row, before the first sweep, and every issuance path reads it and
  answers `403 ISSUANCE_FROZEN`: `POST /v1/authorize`, the code exchange,
  refresh and delegation, the OAuth profile's pushed request and its
  authorization-code, refresh and token-exchange grants, consent bundles and
  passports. A freeze covers what a stop over the same scope would revoke, so
  a refresh or delegation is checked against the lineage of its grant. If the
  freeze state cannot be read, issuance is refused with
  `503 FREEZE_STATE_UNAVAILABLE`. Freezing and issuing meet on a per-developer
  advisory lock, so a grant or a passport written while a freeze lands is
  either swept or refused; a passport's two rows are written in one
  transaction that takes the lock. `POST /v1/emergency-stop/unfreeze` and
  `POST /v1/admin/emergency-stop/unfreeze` lift it, and both the freeze and
  the lifting go on the audit chain (`grantex.issuance_frozen`,
  `grantex.issuance_unfrozen`). A freeze the operator placed cannot be lifted
  with the tenant's key, which may be the leaked one. Agents mid-task: nothing
  changes for tokens already held. The sweep revokes their grants as before,
  and the lockout only refuses new issuance. A stop without the option is
  unchanged: it says `lockout: false`, and the release test still asserts that
  a grant minted afterwards is live. It is off with the rest of the stop unless
  `EMERGENCY_STOP_ENABLED=true`. Shown against real Postgres by
  `tests/emergency-stop-lockout-postgres.integration.test.ts`, which failed on
  the code before the change and passes after it. It covers: every path
  refused under a lockout and open again once it is lifted; a lockout whose
  sweep failed still refusing refresh and delegation of the grants it had not
  reached; issuance refused while the freeze state cannot be read; exchanges
  racing a lockout leaving nothing live; a passport held mid-write while a
  lockout lands ending with its status bit set; a passport whose grant a stop
  revoked mid-issue being refused; and the migration applied forward onto a
  database at the previous head.

## G-23 — Revoking during an incident is rate-limited like ordinary traffic (fixed)

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
- **Fixed:** in the `fix/containment-rate-limits` change. Routes now declare
  which per-developer bucket they draw on (`config.rateLimitClass`, read by
  `plugins/dynamicRateLimit.ts`). Containment routes — `DELETE
  /v1/grants/:id`, `POST /v1/tokens/revoke`, `POST /v1/emergency-stop`,
  `POST /v1/passport/:id/revoke` and `POST /v1/consent-bundles/:id/revoke` —
  share a bucket of 2,000 a minute on every plan, counted apart from the plan
  quota. When Redis fails, or does not answer within 500 ms, they fail open
  to an in-process count of the same size instead of the plan limiter's 503,
  so a cache outage cannot block a revocation and the endpoint still has a
  ceiling on each instance. Against a stopped Redis container a revoke
  through the plugin was let through in 505 ms; without the 500 ms bound it
  took 73.8 s for the counter to fail (see G-46). The revocation feed and
  status reads (`/v1/revocations`, `/status`, `/stream` and a consent
  bundle's `revocation-status`) moved to a status bucket of 6,000 a minute,
  keep their per-address limits, and still fail closed. Every other route is
  unchanged, including the 503. `grantex_rate_limit_decisions_total{bucket,
  outcome}` counts each decision, and two alert rules watch it.
  `RATE_LIMIT_ROUTE_CLASSES_ENABLED=false` restores the old behaviour. There
  is no `POST /v1/grants/:id/suspend`: suspension comes only from the event
  bridge. DPDP consent withdrawal (with `revokeGrant: true`) and erasure
  also mark grants revoked, and stay in the plan bucket, failing closed, on
  purpose: they are compliance operations rather than the incident path,
  they revoke only the grants their records name without the cascade (see
  G-49), and erasure rewrites the principal's audit entries, a write that
  should not run on a per-instance count during an outage. The guides send
  an operator containing an incident to `DELETE /v1/grants/:id` and the
  emergency stop.
- **Shown by** `tests/containment-rate-limits.test.ts`, against the real
  routes: a revoke with the plan exhausted, with the limiter down and with a
  limiter that never answers; every containment route off the plan bucket;
  feed and status reads off it; the containment ceiling. On the old code
  those failed — 429 and 503 where a revoke now answers 204, and the plan
  bucket counted where the containment or status bucket now is. The tests
  that an ordinary route still answers 503, that resuming still uses the
  plan, and that the feed keeps its per-address limits passed before and
  after. Two more pin what the change leaves alone: DPDP withdrawal and
  erasure still draw on the plan bucket and still answer 503.
  `tests/dynamicRateLimit.test.ts` covers the plugin on its own, including
  the in-process ceiling and the opt-out.

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

## G-28 — The revocation stream advanced its cursor before writing (fixed)

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

## G-32 — The signing-key test migrated a fresh database under a 10s limit (fixed)

- **Found:** a full local run during #1352, 2026-09-24.
- **What:** since G-24, `signing-keys-postgres.integration.test.ts` has a
  database of its own, and its first test migrates it from empty under the
  suite's 10-second `testTimeout`. Before G-24 it usually found the shared
  database already migrated by another file, which took almost no time. On
  loaded local machines the first test took from under 2 to about 25
  seconds: one run before this fix took 10.02 seconds and timed out, and
  three runs with it went past 10 seconds and passed. A timeout leaves the
  migration
  running, and one of two things follows:
  - the next test's migration deadlocks against it. `40P01` appears in the
    Postgres server log; the test output shows timeouts and an unhandled
    `Cannot read properties of null (reading 'write')` from the abandoned
    connection;
  - or the migration finishes, the abandoned test body's `finally` deletes
    the signing keys, and the next test fails with
    `No active platform signing key is stored`.

  Every other test that migrates a fresh database already had a limit of a
  minute or more.
- **Fixed:** the first test has a 120-second limit, like the other files that
  migrate from empty. The other two re-run migrations that apply nothing and
  take under three seconds even under load. Shown by forcing a short global
  limit: before the fix, at 1 second all three tests time out with the
  unhandled error and a deadlock in the server log, and at 2 seconds the
  second test usually loses its keys; after it all three pass at both
  limits, the
  first on its own limit. A failure in the first test that is not a timeout
  does not leave a migration running, so it cannot cause either.

## G-33 — Tracked files use terms the house terminology replaces

- **Found:** the first audit with the vendor denylist's terminology warnings
  (`python scripts/check_denylist.py audit`), 2026-09-27.
- **What:** 1,715 warnings in the files tracked before the check was added.
  1,628 are *anomaly*, *anomalies* or *anomalous*, most of them the legacy
  detector's published names: the `/v1/anomalies` routes, the
  `anomaly.detected` event, the `anomalies`, `anomaly_rules` and
  `anomaly_channels` tables, the SDK resources and types in TypeScript, Python
  and Go, the CLI, the portal page, the OpenAPI document and API reference, the
  IETF draft and the `web/anomaly.html` landing page. 71 are *verification
  result(s)*, nearly all naming the outcome of checking an evidence package, a
  credential, a token or an audit hash chain (`VerificationResult` in the SDKs
  and the auth service, `VCVerificationResult`, the Android example's
  `ChainVerificationResult`, the token-verification guide) rather than an
  identity attestation. The other 16 are *kill switch(es)* (8), *white label*
  or *white-labeling* (4), *trust provider* (2) and *verification partner* (2):
  the rule in `AGENTS.md` itself and its copy, planning and review documents,
  the Custom Domains heading in `README.md` and one readiness-check description
  in `apps/auth-service/src/lib/commerce/live-mode-guard.ts`. The warnings do
  not fail anything; this entry records why they are there.
- **Fix:** a product decision per surface. A published name (route, event
  type, table, SDK export) needs a new name, with the old one kept as a
  deprecated alias and a `CHANGELOG.md` entry; documentation, comments and the
  landing page are reworded once the new names exist, so that documentation
  and API agree. If the `VerificationResult` names stay because they name a
  different concept, the check should learn that exception rather than warn
  on them for ever.

## G-34 — mcp-auth tests build their first server under a 5s limit

- **Found:** a full local `make test` on a loaded machine while adding the
  vendor denylist check (G-33), 2026-09-27.
- **What:** in several `packages/mcp-auth` test files, the first test that seeds
  storage and builds a server with `createMcpAuthServer` does so cold (in
  `client-metadata.test.ts` it also imports the server module), under
  vitest's default 5-second `testTimeout`: `vitest.config.ts` sets none. In
  one run six files failed that test with
  `Test timed out in 5000ms` (`client-metadata`, `consent`, `protocol`,
  `state`, `token` and the 2026-07-28 conformance suite) and a seventh file's
  worker exited unexpectedly; a second run failed one of them. Run on its own,
  `client-metadata.test.ts` passes all 35 tests in under two seconds, and
  nothing in the package changed between the runs.
- **Fix:** find which part of the first build is slow when cold, then build
  once per file in a `beforeAll` with a generous hook timeout or give the
  package a `testTimeout` that covers it, as the auth service did for its
  migrations (G-32). Show it by forcing a short limit before and after, as
  G-32 did.

## G-35 — mcp-auth records nothing when most upstream authorizations fail

- **Found:** sending the consent page's purpose to Grantex from mcp-auth
  (2026-09-27).
- **What:** `startUpstreamAuthorization` in
  `packages/mcp-auth/src/endpoints/authorize.ts` answers every
  `grantex.authorize` failure other than a purpose refusal with
  `502 server_error`, "The upstream authorization request failed", and
  records nothing. The `warn` option reports only a purpose refusal and an
  answer that does not confirm the purpose. A request Grantex refuses for a
  configuration reason (callback URL or resource not registered on the
  agent, a scope outside the agent's registration, a rate limit) looks to the
  operator exactly like an outage, and the code Grantex returned is lost.
  `/revoke` has the same gap (G-7).
- **Fix:** report the other upstream failures through `warn` with the
  Grantex error code and request id (not the message text, which, unlike the
  fixed `INVALID_PURPOSE` reasons, can echo request details), and count them
  by code.

## G-36 — mcp-auth is built and tested only against the published SDK

- **Found:** the same work (2026-09-27).
- **What:** the `Makefile` says `@grantex/mcp-auth` resolves `@grantex/sdk`
  from the local build, but `packages/mcp-auth/package-lock.json` pins
  `@grantex/sdk` 0.6.0 from the npm registry, and the package's typecheck,
  unit, integration and browser suites all resolve that copy. Nothing checks
  mcp-auth against `packages/sdk-ts`, so an SDK change that breaks it (a
  renamed type, a changed error shape) is not caught until the SDK is
  published. Typechecking `packages/mcp-auth/src` against the in-repo build
  by hand passed during this work.
- **Fix:** add a CI step that typechecks and runs the mcp-auth unit suite
  with `@grantex/sdk` resolved to the in-repo build (a tsconfig path and a
  vitest alias behind an environment variable, as the root
  `vitest.config.ts` does with `GRANTEX_SDK_TEST_ROOT`), and correct the
  Makefile comment.

## G-37 — The Go SDK's JWKS fetch is unbounded and its `IssuerDID` is not validated

- **Found:** bounding the JWKS fetch in the TypeScript and Python SDKs
  (2026-09-27).
- **What:** `packages/go-sdk/verify.go` registers the JWKS URL with the jwx
  `jwk.Cache` and its default HTTP client: no response size limit, no
  `Content-Type` check, no limit on the number of keys and no deadline on the
  whole fetch. `resolveVerificationEndpoints` turns `did:web:<x>` into
  `https://<x with ":" replaced by "/">/.well-known/jwks.json` without
  checking the host, so an IP address, `localhost`, a single label or user
  information is fetched and trusted, a percent-encoded port produces an
  unusable URL, and an `IssuerDID` that is not `did:web` is ignored in favour
  of `JwksURI`.
- **Fix:** give the cache a fetch with the TypeScript and Python limits (HTTP
  200 only, `application/json` or `application/jwk-set+json`, 64 KiB, 128
  keys, 5 seconds for the whole exchange) and validate `IssuerDID` with the
  same did:web rules (did:web §2.3, §2.5.2 and §3.5: ASCII only, an
  internationalized name as its `xn--` A-label, never mapped), with the shared
  cases from `packages/sdk-py/tests/test_verify_jwks_fetch.py`.

## G-38 — Other TypeScript verifiers fetch JWKS without bounds

- **Found:** bounding the JWKS fetch in the TypeScript and Python SDKs
  (2026-09-27).
- **What:** these call `jose.createRemoteJWKSet(url)` with no options, so they
  accept any response size, media type and number of keys, with only JOSE's
  default five-second timeout:
  - `packages/cli/src/commands/verify.ts` (`grantex verify`);
  - `packages/mcp-auth/src/lib/verify.ts` and
    `packages/mcp-auth/src/resource/guard.ts`.

  `packages/mpp/src/verifier.ts` fetches the JWK Set with plain `fetch`: no
  timeout at all, no size or key limit, and redirects are followed.
- **Fix:** export the SDK's bounded key set (`createBoundedRemoteJWKSet` in
  `packages/sdk-ts/src/jwks.ts`, not yet part of the package's public API) and
  use it in these packages, and give the mpp fetch the same limits.

## G-39 — The auth service can publish a JWK Set the SDKs refuse

- **Found:** choosing the SDKs' JWKS key-count limit (2026-09-27).
- **What:** with `boundedJwksFetch` / `bounded_jwks_fetch` on (opt-in until
  G-41 is fixed, then the default), the TypeScript and Python SDKs refuse a
  JWK Set of more than 128 keys or 64 KiB. The auth service publishes its
  legacy RSA key under one `grantex-YYYY-MM` alias per month of
  `JWT_LEGACY_KID_MONTHS` (13 by default, up to 120), beside its signing-key
  ring, every key in
  `JWT_VERIFICATION_PUBLIC_KEYS`, its EdDSA key and the commerce passport keys
  in their grace window. Nothing stops that set from passing either limit: at
  120 months it is close to both with 2048-bit keys, and larger RSA keys reach
  64 KiB well before 120 aliases. Every relying party using the SDKs with the
  option on would then refuse every token.
- **Fix:** check the size of the published set when the auth service starts
  (and when keys are reloaded), and refuse to start, or at least warn, when it
  exceeds what the SDKs accept; or lower the `JWT_LEGACY_KID_MONTHS` maximum
  to a window that fits.

## G-40 — Docs say the standalone verifier fetches the JWKS on every call

- **Found:** documenting the bounded JWKS fetch (2026-09-27).
- **What:** both SDKs have cached the key set per JWKS URL since 0.5.1
  (10-minute TTL, one refresh per 30 seconds for an unknown `kid`), but the
  docs still describe a fetch on every call:
  `docs/sdks/python/offline-verification.mdx` (description and overview),
  `docs/sdks/typescript/offline-verification.mdx` (overview),
  `docs/guides/token-verification.mdx` (introduction and the "do not assume
  ... a persistent JWKS cache" recommendation) and
  `packages/sdk-py/README.md` ("Local JWKS verification").
- **Fix:** describe the cache, its TTL and the unknown-`kid` refresh, and
  keep the note that the JWKS endpoint must be reachable for the first fetch
  and for refreshes.

## G-41 — The bounded JWKS fetch is opt-in until the next major release

- **Found:** putting the bounded JWKS fetch and the `did:web` checks behind an
  option that defaults off, as `AGENTS.md` ("Feature flags") requires for a
  behaviour change on an existing path (2026-09-27).
- **What:** `boundedJwksFetch` (TypeScript: `verifyGrantToken`,
  `verifyDecisionGrant`, `verifyDecisionGrants`) and `bounded_jwks_fetch`
  (Python: `VerifyGrantTokenOptions`, `grantex.decisions.verify_decision_grant`
  and `verify_decision_grants`) default to off, and the clients' `enforce()`
  cannot turn them on. While the option is off, the JWK Set is fetched without
  bounds: the TypeScript SDK reads a response of any size, media type and
  number of keys, and the Python SDK reads any `2xx` response whole under a
  10-second timeout per network operation, so a server sending a byte at a
  time is never cut off. `issuerDid` / `issuer_did` is not checked either: a
  caller-supplied `did:web` issuer can name an IP address, `localhost`, a
  private or single-label name, or user information, and its keys are fetched
  without bounds from that host and trusted, while a value that is not
  `did:web` is ignored in favour of `jwksUri` / `jwks_uri`.
- **Fix:** in a major release, make the option on by default in both SDKs,
  with `boundedJwksFetch: false` / `bounded_jwks_fetch=False` as the explicit
  opt-out, recorded in `CHANGELOG.md` as a breaking change; give the clients'
  `enforce()` the same option; and fix G-39 first, so the auth service cannot
  publish a set the new default refuses. Owner: the TypeScript and Python SDK
  maintainers. Exit criterion: that major release ships with the default
  flipped, the explicit opt-out, and tests of both settings in both SDKs.

## G-42 — mcp-auth `/introspect` reports the developer as `client_id` and reads only legacy claims

- **Found:** aligning the mcp-auth resource guard with the grant token profile
  (2026-09-27).
- **What:** `packages/mcp-auth/src/endpoints/introspect.ts` builds its RFC 7662
  response from the legacy aliases: `scope` from `scp` (a string `scp`, which
  the guard refuses, is passed through), `grantex_agent_did` from `agt`,
  `grantex_grant_id` from `grnt`, `grantex_delegation_depth` from
  `delegationDepth` (0 when absent), and `client_id` from `dev`. `dev` is the
  Grantex developer, not the OAuth client that RFC 7662 §2.2 means by
  `client_id`, and the token's own `client_id` claim is ignored. For a token
  issued with `GRANT_TOKEN_LEGACY_CLAIMS=false` the response is `active: true`
  with no `scope`, no Grantex fields, and a delegation depth of 0 even for a
  delegated grant. G-12 lists the alias reading.
- **Fix:** read the claims with `readGrantTokenClaims`
  (`packages/mcp-auth/src/lib/grant-token.ts`), as the resource guard does;
  report `client_id` from the token's `client_id` and the developer as a
  separate `grantex_developer_id`; omit `grantex_delegation_depth` when the
  token has none. Changing `client_id` changes the response for existing
  callers, so it belongs in the 3.0 break list.

## G-43 — The mcp-auth resource guard admits key-bound grant tokens as bearer tokens

- **Found:** review of the mcp-auth resource guard's grant token reading
  (2026-09-27).
- **What:** `spec/grant-token-0.6.md` ("Validation", step 5) requires a
  resource server to verify proof of possession (RFC 9449) when a grant token
  has `cnf.jkt`. The auth service binds a grant token to the agent's key
  whenever the grant has an agent key thumbprint
  (`apps/auth-service/src/routes/token.ts`). `createMcpResourceGuard` and the
  Express and Hono `requireMcpAuth` built on it never read `cnf` or a `DPoP`
  header, so a stolen key-bound grant token is accepted at any MCP server
  behind the guard as if it were a bearer token. The 2.0.2 middleware does
  the same.
  `docs/mcp-auth.md` and the package README now say so and tell servers to
  check the proof themselves against `raw.cnf.jkt`.
- **Fix:** add a guard option that verifies the `DPoP` proof (RFC 9449 §4.3:
  `htm`, `htu`, `iat`, `jti` replay, `ath`, and the key thumbprint against
  `cnf.jkt`), answers `401` with a `DPoP` challenge when it fails, and can be
  set to refuse any token without `cnf.jkt`. Off by default, since enabling it
  refuses the key-bound tokens that clients present today as bearer tokens.

## G-44 — The mcp-auth resource guard admits a pre-0.6 token with no agent or developer

- **Found:** review of the mcp-auth resource guard's grant token reading
  (2026-09-27).
- **What:** the SDK verifiers (`packages/sdk-ts/src/verify.ts`,
  `normalizeGrantClaims`) and the auth service
  (`apps/auth-service/src/lib/grant-token-claims.ts`) refuse a grant token
  that names no agent (`urn:grantex:grant.agent_did` or `agt`) or no
  developer (`urn:grantex:grant.developer_id` or `dev`). The guard now refuses
  such a 0.6 token (one with `urn:grantex:grant`), but still admits a token
  that carries only `scp`, as it always has, with `agentDid` and
  `developerId` unset. The auth service never issued such a token; the
  package's own tests and examples sign `scp`-only tokens throughout
  (`tests/resource-guard.test.ts`, `tests/middleware.test.ts`, the
  conformance suite, `tests/docs-examples.test.ts` and
  `tests/integration/restart.integration.test.ts`).
- **Fix:** require `agt` and `dev` on a pre-0.6 token too, in the 3.0 break
  list, after moving those tests and examples to tokens shaped like the auth
  service's (`spec/examples/grant-token-0.6.issued.json`).

## G-45 — `DELETE /v1/grants/:id` cannot revoke a suspended grant

- **Found:** containment rate-limit work (G-23), 2026-09-27.
- **What:** `revokeGrantCascade` (`lib/revoke.ts`) updates only rows with
  `status = 'active'`, for the root and for every descendant it walks. A grant
  the event bridge suspended therefore cannot be revoked through the API:
  `DELETE /v1/grants/:id` answers `404 Grant not found or already revoked`
  and the grant stays `suspended`. A later `POST /v1/grants/:id/resume`
  restores it — and everything suspended with it — to `active`. The same
  walk stops at a suspended descendant, so revoking an active parent leaves a
  suspended subtree beneath it suspended rather than revoked; that subtree
  cannot be resumed while its parent is revoked (`ANCESTOR_INACTIVE`), so the
  exposure is the grant revoked directly. The emergency stop does revoke
  suspended grants, and says so in its runbook.
- **Why it matters:** an operator who revokes a grant that is suspended
  pending an investigation gets a 404 that reads like success ("already
  revoked"), and the decision to end the grant is undone by the next resume.
  Revoking is the irreversible action; it should win over a reversible one.
- **Fix:** revoke `active` or `suspended` in both statements, drop the
  grant's `grant_suspensions` bookkeeping in the same transaction (as the
  emergency stop does), and answer 404 only when the grant does not exist or
  is already revoked. It changes what an existing endpoint does, so it wants
  its own flag and tests: revoke a suspended grant, revoke a parent over a
  suspended child, and resume after either.

## G-46 — A Redis outage holds requests for minutes instead of failing them

- **Found:** containment rate-limit work (G-23), 2026-09-27, against a local
  Redis container that was stopped mid-run.
- **What:** `redis/client.ts` creates the client with ioredis defaults: an
  offline queue, 20 retries per command and no command timeout. A stopped or
  unreachable Redis does not refuse a command; the client queues it and
  retries. Measured through the rate-limit plugin: an ordinary route took
  107 s to reach its `503 RATE_LIMIT_UNAVAILABLE`, and a revocation took
  73.8 s to reach the fail-open path, before G-23 bounded that one path at
  500 ms. Every standard API-key request waits the same way, and so does the
  response of every revocation, because `lib/revoke.ts`,
  `lib/revocation/cascade.ts` and `POST /v1/tokens/revoke` await their
  post-commit cache writes. The revocation is committed and on the feed
  before that wait, so containment takes effect; the caller just does not
  hear about it for minutes, and may retry.
- **Fix:** give the client a command timeout and a bounded retry count (or
  `enableOfflineQueue: false`) so an outage fails in well under a second,
  and do not await best-effort cache writes on the response path. Both
  change failure timing on every route, so they want their own change, a
  flag, and a test against a stopped Redis.
- **Impact:** availability during a Redis outage: requests pile up in
  memory and hold connections instead of failing fast.

## G-47 — A migration-runner unit test runs close to the 10s limit

- **Found:** full auth-service runs during containment rate-limit work
  (G-23), 2026-09-27, on a machine shared with other test stacks.
- **What:** `tests/database-performance.test.ts` › "refuses to record a
  concurrent-index file while its index is invalid" drives `runMigrations`
  through all five lock-retry attempts, which sleep 3.75 s between them by
  design (`LOCK_RETRY_BASE_MS` 250, doubling), on top of reading and hashing
  every migration file. It has the suite's default 10-second limit. Across
  seven runs it passed twice and timed out (10.0 s) five times, including a
  run of that file alone on an unmodified checkout of `main`; with a
  120-second limit the test alone took 20.5 s there.
- **Fix:** give the test its own limit, as G-32 did for the signing-key
  test, or make the backoff injectable so the test does not sleep for real.
- **Impact:** a red run that says nothing about the change under test.

## G-48 — A revocation-feed hub test gives the hub a fixed 300 ms

- **Found:** full auth-service runs during containment rate-limit work
  (G-23), 2026-09-27.
- **What:** `tests/revocation-feed-postgres.integration.test.ts` › "reads a
  full page of unsettled entries once, instead of spinning on it" subscribes,
  calls `hub.pollNow`, then sleeps 300 ms and expects the page delivered.
  `subscribe` starts the hub's first poll without awaiting it, and `pollNow`
  returns at once while that poll is in flight (`feed.polling`), so the page
  arrives only when the first poll finishes. On a loaded machine its queries
  over the 1,001-entry backlog take longer than 300 ms and the test fails
  with `expected +0 to be 1000`. It failed in two full runs on the G-23
  change and passed in a full run on the unmodified base and when the file
  runs alone (11/11); it uses neither HTTP nor the rate limiter.
- **Fix:** wait for the page (`vi.waitFor` on `seen.length`, with a bound
  well inside the test's 180 s limit) and keep the read-count assertion, or
  have `pollNow` await a poll already in flight. A separate change.
- **Impact:** a red full run that says nothing about the change under test.

## G-49 — DPDP withdrawal and erasure revoke a grant without the cascade

- **Found:** containment rate-limit work (G-23), 2026-09-27, by reading
  `routes/dpdp.ts` beside `lib/revoke.ts`.
- **What:** `POST /v1/dpdp/consent-records/:recordId/withdraw` with
  `revokeGrant: true` and `POST /v1/dpdp/data-principals/:principalId/erasure`
  revoke with a bare `UPDATE grants SET status = 'revoked'` on the grants
  their consent records name. `revokeGrantCascade`, which `DELETE
  /v1/grants/:id` uses, also revokes every delegated descendant in the same
  transaction, revokes the credentials issued for those grants, releases
  their wallet reservations, writes the revocation cache and emits
  `grant.revoked`. The DPDP routes do none of that. The named grant stops
  verifying, because token checks read its status from Postgres, and the
  feed triggers record it; but a grant delegated from it keeps its own
  `active` status and its tokens keep verifying, and a verifiable credential
  bound to it is not revoked.
- **Why it matters:** a data principal who withdraws consent, or asks for
  erasure, expects every agent acting under that consent to stop, including
  sub-agents it delegated to.
- **Fix:** revoke through `revokeGrantCascade` (or the same statements in the
  route's transaction) for each grant, and add tests that a delegated grant
  and a bound credential are revoked by both routes. It changes what existing
  endpoints do, so it wants its own flag.
- **Impact:** delegated grants and credentials outlive a consent withdrawal
  or erasure until they expire or are revoked directly.

## G-50 — A lockout does not refuse resuming a suspended grant

- **Found:** emergency stop lockout work (G-22), 2026-09-27.
- **What:** `POST /v1/grants/:id/resume`, and the event bridge's resume
  action, make a suspended grant tree active again without reading the
  issuance freeze. After a stop that completed there is nothing to resume
  under its scope, because the sweep revokes suspended grants as well as
  active ones. But a lockout whose sweep failed or came back `incomplete`
  can leave suspended grants under the frozen scope, and resuming one brings
  authority back under a scope that is meant to issue nothing.
- **Impact:** narrow. It needs a stop that did not finish and a resume of a
  subtree it had not reached. Repeating the stop, which the runbook says to do
  for any status other than `completed`, revokes that subtree.
- **Proposal:** read the freeze in `resumeSuspendedGrants`
  (`lib/revocation/cascade.ts`). Do it inside its transaction, after the
  delegation lock, with the root grant as the subject so its lineage is
  covered. Refuse with a new outcome that the route answers as
  `403 ISSUANCE_FROZEN` and the event bridge records as refused.

## G-51 — The release test's mid-stop delegation case usually has nothing to catch

- **Found:** emergency stop lockout work (G-22), 2026-09-27, running
  `tests/e2e/emergency-stop.test.ts` against a local service with Postgres
  and Redis.
- **What:** "catches a grant delegated while the stop is running" needs at
  least one delegation to succeed while the stop request is in flight, and
  asserts `delegated.length > 0` before checking that nothing is left live.
  The delegation and the stop's first cascade both take the per-developer
  revocation lock. Before asking for it, the delegation checks the parent
  token, looks up the sub-agent and signs; the stop only writes its own record
  and reads the scope once. Reading the code, that is why the stop usually
  gets there first. The first delegation then finds its parent revoked, and
  so does every later one. On unmodified `main` the case failed 3 runs out of 3 here
  with `no grant was delegated while the stop ran: expected 0 to be greater
  than 0`, and with the lockout change it failed 2 out of 3. The stop itself
  was correct every time: nothing was left live.
- **Impact:** the release rehearsal in `scripts/revocation-release-test.sh`
  fails on a timing race rather than on the property it is meant to check.
  The property is proven deterministically elsewhere: the Postgres test
  "sweeps again, so a grant delegated while it runs is caught" injects the
  late grant between two sweeps.
- **Proposal:** make the race deterministic rather than waiting for it. For
  example, let the harness hold a delegation inside its transaction until the
  stop's first sweep has read the scope. Or give the stop a subtree large
  enough that its first sweep takes measurably longer than one delegation.

## G-52 — Revoking a grant leaves its passports' own rows reading active

- **Found:** emergency stop lockout work (G-22), 2026-09-27, in review of the
  passport path.
- **What:** revoking a grant (`POST /v1/grants/:id/revoke`, the cascade, an
  emergency stop) sets the status-list bit of every credential issued from it
  and marks its `verifiable_credentials` rows revoked, through
  `revokeVCsByGrantIds` (`lib/vc.ts`). Nothing updates `mpp_passports`: the
  only write to `mpp_passports.status` is `POST /v1/passport/:id/revoke`. So
  after a grant is revoked, `GET /v1/passport/:id` and `GET /v1/passports`
  still report its passports as `active`.
- **Impact:** reporting, not authority. A verifier checks the status list,
  which does say revoked. But an operator confirming after an incident that
  nothing is left live, from the passport endpoints, is told the opposite.
- **Proposal:** in `revokeVCsByGrantIds`, in the same transaction, mark the
  `mpp_passports` rows whose ids it revoked (`status = 'revoked'`,
  `revoked_at`), behind a flag since it changes what every revoke reports.
  A one-off backfill can then correct passports of grants already revoked.

## G-53 — With the emergency stop off, a passport can be written under a grant revoked mid-issue

- **Found:** emergency stop lockout work (G-22), 2026-09-27.
- **What:** `POST /v1/passport/issue` reads the grant, allocates a status-list
  index and signs, then writes. With `EMERGENCY_STOP_ENABLED=true` the write's
  transaction reads the grant again with `FOR SHARE`: a revocation that
  committed first refuses the passport, and one that comes later waits for it
  and then sets its status bit. With the flag off that re-read is not made,
  because the flag keeps the path as it was. A revocation that commits
  between the first read and the write then leaves a passport whose
  credential no revocation found, and which verifies offline until it expires
  (up to `MPP_PASSPORT_MAX_EXPIRY_HOURS`, capped at the grant's own expiry).
- **Impact:** narrow. It needs a revocation of the grant inside a window of a
  few milliseconds of an issuance from it. Revoking the passport itself
  (`POST /v1/passport/:id/revoke`) still works.
- **Proposal:** make the locked re-read unconditional. It only refuses a
  passport whose grant is no longer active, which the route already means to
  refuse.

## G-54 — A lockout does not cover commerce passports

- **Found:** emergency stop lockout work (G-22), 2026-09-27, in review.
- **What:** commerce passports (`POST /v1/commerce/passports/exchange`,
  signed by `signCommercePassport` in `lib/commerce/passport.ts`) are minted
  for a commerce tenant's agent from a consent the shopper approved, not from
  a grant. The issuance freeze does not read them, and the emergency stop
  does not sweep them. A leaked commerce agent credential can keep exchanging
  approved consents for passports under a `developer` lockout.
- **Impact:** a lockout is not the control for commerce; the runbook says so
  and names the one that is. Disabling the commerce tenant
  (`PATCH /v1/commerce/tenants/:tenant_id`, `status: "disabled"`) refuses new
  exchanges, and `POST /v1/commerce/passports/revoke` revokes those issued.
- **Proposal:** decide whether an emergency stop should reach commerce at
  all. If so, map a commerce tenant to the developers bound to it
  (`commerce_developer_tenants`) and have the exchange read the freeze of
  those developers, with a stop that also revokes the tenant's live commerce
  passports.

## G-55 — Other grant token verifiers accept any `aud` when no audience is set

- **Found:** adding the audience check to `enforce()`, `@grantex/gateway` and
  `@grantex/adapters` (2026-09-27).
- **What:** with no audience configured, these still accept a token that
  carries `aud`, however it is set: `packages/express/src/middleware.ts`
  (`audience` "leave undefined to skip audience check"),
  `packages/fastapi/src/grantex_fastapi/_middleware.py`, and the standalone
  `verifyGrantToken` / `verify_grant_token` in both SDKs (which pass
  `verify_aud: False` or no `audience` to the JOSE library). A token requested
  for one relying party is therefore accepted by every relying party that
  uses these paths without an audience, while `enforce()`, the gateway and
  the adapters now deny it (`audience_unconfigured`).
- **Fix:** give each verifier the same `audience` / `audienceCheck` semantics
  as `enforce()` (deny `aud` without a configured audience; exact match of one
  value; `'off'` as the explicit opt-out), as a breaking change recorded in
  `CHANGELOG.md`, and run `spec/examples/enforce-audience.json` against each.

## G-56 — The gateway classifies token errors by substrings of their message

- **Found:** reading `packages/gateway/src/server.ts` while adding the
  audience check (2026-09-27).
- **What:** a `GrantexTokenError` whose message contains `exp` anywhere
  (for example "expected", "unexpected") is answered `TOKEN_EXPIRED`, and one
  whose message contains `scope` anywhere (for example "Grant token claim
  scope must be a string") is answered 403 `SCOPE_INSUFFICIENT` instead of 401
  `TOKEN_INVALID`. `packages/express/src/middleware.ts` and
  `packages/fastapi/src/grantex_fastapi/_middleware.py` use the same `exp`
  test. The status stays a denial, but the code and status tell the client
  the wrong remedy.
- **Fix:** have the SDK verifiers raise typed errors (or a stable `code` on
  `GrantexTokenError`) for expiry and missing scopes, and map those instead of
  the message text.

## G-57 — `grantex enforce test` cannot set the expected audience (fixed)

- **Found:** checking the callers of `enforce()` for the audience check
  (2026-09-27).
- **What:** `packages/cli/src/commands/enforce.ts` builds its client with only
  `baseUrl` and `apiKey`. Once the CLI runs on an SDK release with the
  audience check, every token that carries `aud` is reported as denied with
  `audience_unconfigured`, and there is no flag to pass the audience or turn
  the check off.
- **Fix:** add `--audience <value>` (passed to `enforce()`) and
  `--audience-check <on|off>` (passed to the client) to `grantex enforce test`,
  with tests, and require an `@grantex/sdk` peer range that has the options.
- **Fixed:** in the `fix/enforce-audience` change. `grantex enforce test`
  takes `--audience` (passed to `enforce()` as the per-call audience) and
  `--audience-check <on|off>` (passed to the client through `requireClient`);
  other `--audience-check` values, an empty `--audience` and `--audience` with
  `--audience-check off` are refused. No `@grantex/sdk` release has the
  options yet, so instead of a version range the command checks that the
  installed SDK exports the audience sub-reasons and refuses both options
  when it does not, rather than ignoring them. Shown by
  `packages/cli/tests/enforce.test.ts`, `packages/cli/tests/client.test.ts`
  and `packages/cli/tests/enforce-older-sdk.test.ts`, which fail without the
  change.

## G-58 — Permissive enforce mode allows a token that fails verification

- **Found:** making the audience denials fail closed in permissive mode
  (2026-09-28).
- **What:** with `enforceMode: 'permissive'` (TypeScript) or
  `enforce_mode="permissive"` (Python), `enforce()` passes every denial
  through the permissive conversion, including `token_invalid` for a token
  whose signature, issuer, expiry or claims fail verification, and
  `grant_revoked`. A forged, expired or revoked token is therefore reported
  `allowed: true` with a warning (`packages/sdk-ts/src/client.ts`, `denied()`
  and `#applyEnforceMode`; `packages/sdk-py/src/grantex/_client.py`,
  `_apply_enforce_mode`). Permissive mode is documented as development only
  and meant to relax scope and manifest checks while a manifest is written,
  not to accept tokens nobody issued. The audience denials already bypass the
  conversion.
- **Fix:** have token verification and revocation denials fail closed in
  every enforce mode, as the audience denials do, as a breaking change
  recorded in `CHANGELOG.md`, with tests in both SDKs.

## G-60 — The FastAPI enforcer and the Python Strands tool cannot pass an amount

- **Found:** making a `capped:N` scope deny a call without an amount
  (`amount_missing`) in both SDKs and adding amount extractors to
  `wrap_tool`, `wrapTool` and `enforceMiddleware` (2026-09-27).
- **What:** `grantex.fastapi.GrantexEnforcer`
  (`packages/sdk-py/src/grantex/_fastapi.py`) and `grantex_strands`'s online
  mode (`packages/strands-py/src/grantex_strands/_tool.py`) call `enforce()`
  with no `amount` and have no way to supply one. Under a capped grant every
  call through them is now denied with `amount_missing`; the only ways through
  are calling `enforce()` directly or `caps_mode="warn"`. The TypeScript
  Strands tool takes only a fixed `amount` per tool, not one per call.
- **Fix:** give `GrantexEnforcer` an `amount(request, arguments)` callable
  (plain or async, like `case_version`) and the Strands tools a per-call
  amount extractor, passing the value to `enforce()` and refusing the call
  when the extractor raises, as `wrap_tool` does. Owner: the Python SDK and
  Strands integration maintainers. Exit criterion: a capped grant used
  through each integration is allowed with an amount within the cap, denied
  above it, and denied `amount_missing` without an extractor, with tests.
  Schedule it before, or in, the release that ships the `amount_missing`
  change, so these integrations are not left with only the opt-out.

## G-61 — mcp-auth's tool guard ignores `capped:N` scopes

- **Found:** looking for other places that read `capped:N` scopes while
  making the SDKs deny a capped call without an amount (2026-09-27).
- **What:** `grantedPermission` in
  `packages/mcp-auth/src/resource/tool-policy.ts` reads a
  `tool:<connector>:<permission>` scope "with any trailing resource or cap
  segments" and the guard admits a `tools/call` on permission alone. A grant
  of `tool:merchant:write:*:capped:50` therefore authorizes any amount through
  an mcp-auth protected resource, the fail-open the SDKs no longer allow.
- **Fix:** decide whether the guard enforces amount caps (it would need an
  amount extractor over the JSON-RPC arguments, and `amount_missing` and
  `amount_cap` denials) or refuses capped scopes it cannot evaluate; document
  the choice in `docs/mcp-auth.md`. Ship the behaviour change behind an
  option that defaults off, or as a recorded breaking change in the next
  major. Owner: the mcp-auth maintainers. Exit criterion: a capped grant is
  either capped or refused by the guard, with tests of both outcomes.

## G-65 — Default online revocation checks share a 1,200-per-minute limit (fixed)

- **Found:** turning revocation checking on by default in both SDKs
  (2026-09-27).
- **What:** from the next SDK release, every `enforce()` of a client that does
  not set `revocationCheck` / `revocation_check` calls
  `GET /v1/revocations/status`. That route is limited to 1,200 requests a
  minute per client address (`apps/auth-service/src/routes/revocations.ts`),
  so a process making more than 20 checked calls a second, or several agents
  behind one egress address, is answered `429`; the SDKs retry and then deny
  with `grant_revoked` / `status_unavailable`. The check also adds one round
  trip to every call.
- **Fix:** size the limit for per-call checks (per developer rather than per
  address, and higher), document the cost next to the default, and point
  high-volume clients at `feed`. Owner: the auth-service maintainers. Exit
  criterion: a load test at the documented rate passes without a `429`.
- **Fixed:** the status route's per-address limit is now the developer's
  revocation-status budget (`STATUS_RATE_LIMIT`, 6,000 a minute, per developer
  on every plan since G-23's buckets), so one address can use the developer's
  whole budget; the per-address limit stays as an abuse ceiling counted before
  authentication. The cost of `online` and the advice to use `feed` above
  100 checked calls a second are documented in
  `docs/concepts/event-bridge-and-revocation.md`,
  `docs/guides/rate-limits.mdx` and `docs/self-hosting.md`. Shown by
  `apps/auth-service/tests/containment-rate-limits.test.ts`: "serves many
  status calls from one address within a minute while the developer is under
  its status budget" (1,500 calls from one address; 300 were refused `429`
  before), "still refuses status calls past the per-developer status budget"
  and "keeps an abuse ceiling per address on the status route, before
  authentication". Still true, and documented rather than changed: each checked
  call is one round trip; a developer's checked calls are capped at 6,000 a
  minute across all its instances; and developers sharing one egress address
  share that address's 6,000 a minute. The exit criterion was met with
  in-process requests, not a load test against a deployed service.

## G-66 — The first revocation feed prune after turning the feed on is one unbounded DELETE (fixed)

- **Found:** reading what the auth service does when the revocation feed
  turns on by default (2026-09-27).
- **What:** the triggers from migrations 112, 114 and 116 fill
  `grant_revocation_events` whether or not the feed is served, but the prune
  worker (`apps/auth-service/src/workers/revocationFeedPrune.ts`) starts only
  while it is. On a deployment where the feed was off, the first prune after
  it turns on deletes the whole backlog past retention in a single statement
  (`pruneFeed` in `apps/auth-service/src/lib/revocation-feed/store.ts`), one
  long transaction on a table the revocation triggers write to. The first
  prune runs as soon as each instance starts (`startRevocationFeedPruneWorker`
  calls `pruneRevocationFeedOnce` before arming its hourly timer), not an
  hour later, so on the first deploy with the feed on every Cloud Run
  instance (up to five, `--max-instances=5` in
  `.github/workflows/deploy.yml`) runs the same unbounded DELETE at once,
  at deploy time. Measuring the row count of `grant_revocation_events` in
  production before the merge tells how large that backlog is.
- **Fix:** delete in bounded batches (for example `seq` ranges or a
  `LIMIT`ed subquery) until nothing is left, and count the batches in the
  prune metrics. Owner: the auth-service maintainers. Exit criterion: a
  Postgres integration test prunes a backlog larger than one batch in
  several statements, and instances that start together do not prune the
  same backlog concurrently (an advisory lock, or a start-up jitter).
- **Fixed:** `pruneFeedBatch` deletes at most 1000 rows per statement, oldest
  first through `idx_grant_revocation_events_created`, and the worker loops
  it with a pause between batches, stopping after 50 batches or 60 seconds
  and leaving the rest to the next run. A run holds a session advisory lock
  (`hashtextextended('grantex:revocation-feed-prune', 0)`) on the connection
  that deletes, and skips when another instance holds it. The first run waits
  a random delay of up to `REVOCATION_FEED_PRUNE_JITTER_SECONDS` (default
  300) instead of running at start, and the hourly timer is armed from there.
  Each run logs the rows it deleted and its outcome, counted in
  `grantex_revocation_feed_pruned_total` and
  `grantex_revocation_feed_prune_runs_total{outcome}`. Shown by
  `apps/auth-service/tests/revocation-feed-prune.test.ts` (batching, the
  batch and time caps, the lock skip, failure handling, jitter bounds) and the
  Postgres test "prunes a backlog larger than one batch across capped runs,
  one instance at a time" in
  `apps/auth-service/tests/revocation-feed-postgres.integration.test.ts`:
  750 rows past retention, two prunes started together (one deletes three
  batches, the other skips), later runs finish the backlog, and the four rows
  inside retention survive.

## G-67 — The gateway and the Go SDK never check revocation

- **Found:** looking for every caller the revocation default flip should
  cover (2026-09-27).
- **What:** `packages/gateway` authorizes a proxied request with
  `verifyGrantToken` alone (`packages/gateway/src/server.ts`), and the Go SDK
  has no `enforce()` or revocation check, so a revoked grant's token is
  accepted there until it expires, whatever the TypeScript and Python SDKs
  default to.
- **Fix:** give both an online and a feed revocation check, on by default
  with an explicit opt-out, recorded as breaking. Owner: the gateway and Go
  SDK maintainers. Exit criterion: a revoked grant is refused by both in a
  test against the auth service.

## G-68 — The event-bridge receipt prune is one unbounded DELETE on every instance at start

- **Found:** bounding the revocation feed prune (2026-09-28).
- **What:** `apps/auth-service/src/workers/eventBridgeReceiptPrune.ts` runs
  `pruneEventBridgeReceiptsOnce` when each instance starts and then on an
  interval. Each run is a single `DELETE FROM event_bridge_receipts` over
  everything past retention, with no batch limit and no lock between
  instances, so every instance that starts together runs the same large
  delete at once, as the revocation feed prune did before it was bounded.
- **Fix:** batch the delete with a per-run cap, run it under a
  `pg_try_advisory_lock` so one instance prunes at a time, and jitter the
  first run, as `workers/revocationFeedPrune.ts` now does. Owner: the auth
  service maintainers. Exit criterion: a Postgres test in which two
  concurrent prunes over a backlog larger than one batch leave one skipped
  and the retained rows untouched.

## G-70 — With the emergency stop off, a failed passport credential insert leaves the passport behind

- **Found:** emergency stop lockout work (G-22), 2026-09-27, in review.
- **What:** `POST /v1/passport/issue` writes its `mpp_passports` row and its
  `verifiable_credentials` row as two separate statements on the pool. If the
  second fails, the route answers 500 but the passport row stays, reading
  `active`, with no credential row. A revocation of the grant finds
  credentials through `verifiable_credentials`, so it never sets that
  passport's status bit. With `EMERGENCY_STOP_ENABLED=true` the two rows are
  written in one transaction, because the lockout needs the credential row
  committed with the passport. With the flag off the route keeps the original
  two writes, since every behaviour change on an existing path ships behind a
  flag that defaults off; the Postgres test "keeps the passport writes as they
  were while the stop is off, and atomic while it is on" pins both.
- **Impact:** narrow. It needs the second insert to fail after the first
  succeeded (a dropped connection, a constraint on the credential row). The
  caller gets a 500 and no credential, so nothing was presented; what is
  wrong is the record, and `GET /v1/passports` lists a passport that was
  never issued.
- **Proposal:** write the two rows in one transaction unconditionally, under
  its own flag or once the emergency stop is on by default. It only changes
  what a failed issuance leaves behind.

## G-71 — With the emergency stop off, a best-effort credential can outlive a revocation of its grant

- **Found:** emergency stop lockout work (G-22), 2026-09-27, in review.
- **What:** with `credentialFormat` `vc-jwt` or `both` and portable passkey
  evidence off, `POST /v1/token` and `POST /v1/grants/delegate` issue the
  grant's verifiable credential after the grant's transaction commits. A
  revocation of the grant that commits in that gap sets the status bits of
  the credentials it finds, which do not yet include this one, and the
  credential is then written with a clear bit under a revoked grant. No later
  revocation starts from a revoked grant, so it verifies until it expires.
  With `EMERGENCY_STOP_ENABLED=true` the credential is written in a
  transaction that re-reads the grant `FOR SHARE` and the lockout under its
  lock (`issueForCommittedGrant` in `lib/revocation/issuance-freeze.ts`),
  which closes the gap for stops and ordinary revocations alike. With the
  flag off the original path is kept.
- **Impact:** narrow: a revocation within milliseconds of an exchange or a
  delegation that asked for a credential.
- **Proposal:** make the same re-read the path with the flag off too, under
  its own flag. It only withholds a credential from a grant that is no longer
  active.

## G-72 — SD-JWT credentials from the code exchange carry no revocation status

- **Found:** emergency stop lockout work (G-22), 2026-09-27, checking every
  issuance path for credentials issued after the grant commits.
- **What:** `POST /v1/token` with `credentialFormat: "sd-jwt"` signs an SD-JWT
  (`issueSDJWT` in `lib/sd-jwt.ts`) after the grant's transaction commits. It
  has no `credentialStatus` and is not stored, and `verifySDJWT` checks only
  the signature, the disclosures and expiry. No revocation, emergency stop or
  lockout can reach one: revoking its grant leaves it verifying until it
  expires, whether it was issued before the stop or in the gap after the
  grant committed. The lockout change leaves it as it was, because gating its
  issuance would not make one issued a moment earlier revocable.
- **Impact:** an SD-JWT is only as revocable as its expiry. A verifier that
  also checks the grant token, or the grant online, is not affected.
- **Proposal:** give SD-JWTs a status-list entry and a `verifiable_credentials`
  row, issued the way the VC-JWT is (in the grant's transaction, or through
  `issueForCommittedGrant` while the stop is on), so a revocation sets their
  bit, and have `verifySDJWT` check it.

## G-80 — The public trust-registry reads have no limit of their own

- **Found:** adding `GET /v1/registry/issuers`, which is limited per client
  address, and comparing it with the registry reads already served
  (2026-09-28).
- **What:** `GET /v1/trust-registry/:orgDID`, `GET /v1/registry/orgs`,
  `GET /v1/registry/orgs/:did` and `GET /v1/registry/orgs/:did/jwks`
  (`apps/auth-service/src/routes/trust-registry.ts`) skip authentication and
  set no `rateLimit` of their own, so the only limit is the service-wide
  5,000 requests a minute per address. `GET /v1/registry/orgs` runs a
  `COUNT(*)` and an `ILIKE` search over `trust_registry` on every call, so one
  address can keep the database busy with unauthenticated searches.
- **Impact:** load, not disclosure: the data is public by design.
- **Proposal:** give each route a per-address limit sized for its use (the
  issuer list uses 60 a minute; search probably wants less), behind a flag
  that defaults off because it changes an existing path, with a test that the
  limit answers 429 and that another address is unaffected. Owner: the
  registry maintainers. Exit criterion: every unauthenticated registry read
  has a route limit, with tests.

## G-85 — The single-key token paths do not read the agent key history

- **Found:** agent key history work (Agent Trust Registry, PRD §8.8),
  2026-09-28.
- **What:** migration 122 adds `agent_keys` with pending, active, rotated and
  compromised keys and a rotation overlap, but every path that binds or checks
  an agent key still reads the single registered key,
  `agents.key_thumbprint`: the OAuth profile's PAR, code exchange, refresh,
  revocation and token exchange (`routes/oauth.ts`), `POST /v1/authorize` and
  `POST /v1/token` (`cnf.jkt`), delegation (`routes/delegate.ts`) and the
  agent DID document (`routes/did.ts`). Consequences: a key added and proven
  through the history is not usable there until it is also set as
  `publicJwk`; a key rotated through the history stays accepted there after
  its `valid_to` for as long as it remains the registered key; a pending key
  is accepted there with a DPoP proof (which is also what proves it). A
  compromise is handled: it moves the registered key to a proven replacement
  or clears it and suspends the agent.
- **Impact:** the overlap and the `key_unproven` / `key_not_active` denials
  apply to the key routes and to relying parties that read the history, not
  yet to the auth service's own token endpoints. The provider documentation
  (`docs/providers/registering-agents.md`) and `spec/agent-keys.md` §5 and §7
  say so, and tell providers to set `publicJwk` to the replacement with
  `PATCH /v1/agents` after a rotation.
- **Proposal:** switch those paths to evaluate the presented key against
  `agent_keys` (`evaluateAgentKey` in `lib/registry/agent-keys.ts`), behind a
  flag that defaults off, then drop `idx_agents_key_thumbprint_unique` once no
  path reads `agents.key_thumbprint`.

## G-86 — A compromise does not reach grants in other tenants bound to the same key

- **Found:** agent key history work, 2026-09-28.
- **What:** `POST /v1/agents/:id/keys/:thumbprint/compromise` revokes the
  grants whose `cnf.jkt` is the key only within the reporting developer's
  tenant. A key can have been held earlier by an agent of another developer:
  a key released by a replacement (`PATCH /v1/agents`, or a rotation whose
  overlap ended) can be registered by another agent, which the registered-key
  index has always allowed. Grants the earlier holder obtained with the key
  keep their binding and are not revoked by the compromise. (Registration
  after a compromise is closed on every path that writes the history:
  `compromised_agent_keys` records every compromised thumbprint and outlives
  the agent. `POST` and `PATCH /v1/agents` check it only with the history
  mirror on; see G-87.)
- **Impact:** narrow. It needs one key to move between developers and then be
  reported compromised while grants from the earlier holder are still active.
- **Proposal:** decide with the owner whether a compromise should revoke
  grants bound to the key in every tenant, or whether a released key should
  stay reserved to its developer.

## G-87 — With the history mirror off, the agents routes do not consult the key history

- **Found:** review of the agent key history work, 2026-09-28.
- **What:** mirroring the key `POST` and `PATCH /v1/agents` write into
  `agent_keys` is behind `AGENT_KEY_HISTORY_MIRROR_ENABLED`, default off, so
  those routes keep their earlier behaviour. With it off they do not add the
  key to the history, do not end the replaced key there, and do not refuse a
  key another agent holds in its history, a key in `compromised_agent_keys`,
  or a non-P-256 key for an agent that declares a payments rail. The history
  of an agent whose registered key changed through them can therefore list a
  key it no longer registers as pending or active, and a compromised key can
  be registered again as `publicJwk`.
- **Impact:** a key registered again that way is still refused by the key
  routes and by delegation (`routes/delegate.ts` checks
  `compromised_agent_keys` under the cascade lock), but `POST /v1/token` and
  the OAuth profile bind grants to the registered key and do not check it
  (G-85).
- **Proposal:** turn the flag on once its exit criterion is green (the flag-on
  suite in `tests/agent-keys-postgres.integration.test.ts`) and the owner has
  approved the runbook; then make it the default in a release that records the
  flip as a breaking change with the flag as the opt-out.

## G-90 — The grant credential status list is served unsigned, as a superseded format

- **Found:** registry attestation-acceptance status lists (Stage 1), 2026-09-28,
  reading `lib/vc.ts` for how platform-signed artefacts are signed.
- **What:** `GET /v1/credentials/status/:listId` returns
  `buildStatusListCredential(listId)` as plain JSON: a `StatusList2021Credential`
  with no proof and no JWS envelope. Anyone who can answer for that URL (a
  cache, a proxy, a hostile network) can hand a verifier a list with the bit
  cleared, and nothing lets the verifier tell. It also mixes formats: the W3C
  VC 2.0 context with the `StatusList2021` types and the VC 1.1 `issued`
  property. StatusList2021 is superseded by Bitstring Status List v1.0, which
  asks for the status list credential to be secured (§3.2 verifies its
  proofs). Indices are also handed out sequentially, where Bitstring Status
  List §2.1 says they SHOULD be random.
- **Impact:** revocation of AgentGrantCredentials depends on an unauthenticated
  document. A relying party that fetches it over TLS from the issuer is
  exposed only to the issuer's own infrastructure; one that accepts it from
  anywhere else is exposed to anyone on the path.
- **Proposal:** serve the list as a `BitstringStatusListCredential` secured as
  a VC-JWT with the platform signing key, the way
  `lib/registry/acceptance-status.ts` does for the registry's lists, behind a
  flag that defaults off with the old format kept until SDK verifiers move;
  issue new credentials with `BitstringStatusListEntry` and random indices.

## G-91 — `verifyAgentGrantVC` treats a status list it cannot find as "not revoked"

- **Found:** registry attestation-acceptance status lists (Stage 1), 2026-09-28,
  in the same reading of `lib/vc.ts`.
- **What:** the revocation check in `verifyAgentGrantVC` runs only when the
  `statusListCredential` URL matches `/status/<id>` and a `vc_status_lists` row
  with that id exists; otherwise it is skipped and the credential verifies.
  `getBit` returns `false` for an index outside the list. So a credential whose
  list row is missing, or whose status URL or index is malformed, reads as
  valid instead of failing closed. A validly signed credential cannot be
  altered by the holder, so this needs a platform-side fault (a deleted or
  never-written list row), not a forgery.
- **Impact:** a credential that should be checkable against a list is accepted
  without the check whenever that list cannot be read.
- **Proposal:** when `credentialStatus` is present, require the URL to be one
  of this service's list URLs, the list row to exist and the index to be in
  range, and return `valid: false` otherwise; test each of the three cases.
  Behind a flag that defaults off, since it can turn today's `valid: true`
  into a denial.

## G-105 — The public registry search lists unverified, self-asserted organizations

- **Found:** trust registry listing fix (`GET /v1/trust-registry` can be made
  to take the admin key), 2026-09-28, reviewing the other registry reads.
- **What:** `GET /v1/registry/orgs` is public (`skipAuth`) and returns every
  `trust_registry` row, including `basic` records that were registered with a
  developer API key and never proved control of their domain. The name and
  description are whatever the registrant typed, and `verified=false` lists
  exactly those records. With no filter a caller can page through the whole
  registry (up to 100 a page, with a total count). `GET /v1/registry/orgs/:did`
  and the legacy `GET /v1/trust-registry/:orgDID` likewise answer for an
  unverified record. The `GET /v1/registry/orgs/:did` detail also includes
  the security and DPO contacts the registrant supplied; the legacy route
  returns no contact fields. The routes carry only the service-wide per-address
  limit, not a limit of their own.
- **Impact:** a public lookup that should answer with the minimum a relying
  party needs about an organization that has proved something instead
  publishes self-asserted records. Anyone can register `did:web:` for a
  domain they do not control, under any display name, and have it appear in
  search next to verified organizations (`verificationLevel: basic` is the
  only difference), and the whole registry, contacts included, can be
  enumerated. The behaviour is unchanged by the listing fix, which kept these
  routes as they were.
- **Proposal:** behind a flag that defaults off, have the public search and
  detail return only records that completed verification (or return an
  unverified record's DID and `verificationLevel` alone), leave the contacts
  out of the public detail, and give the public reads a per-client rate limit
  of their own; the registrant keeps full access to its own records through
  an authenticated route.

## G-106 — The cross-tenant trust registry listing stays open to developer keys until the flag is turned on

- **Found:** trust registry listing fix, 2026-09-28, when the admin-key check
  on `GET /v1/trust-registry` was put behind a flag that defaults off, as
  `AGENTS.md` ("Feature flags") requires for a behaviour change on an existing
  path.
- **What:** `TRUST_REGISTRY_ADMIN_LISTING_ENFORCED` defaults to off, and only
  the exact value `true` turns the check on. While it is off,
  `GET /v1/trust-registry` still takes any developer API key and returns the
  100 newest registry records of every developer, unverified ones included.
- **Risk:** on a deployment that has not set the flag, one tenant can list
  every other tenant's registry records (DIDs, domains, names, descriptions,
  trust levels and verification state), including organizations that have not
  published themselves as verified. The route is documented as an operator
  route, so a deployment may assume it is already restricted.
- **Fix:** operators set `TRUST_REGISTRY_ADMIN_LISTING_ENFORCED=true` once
  their callers have moved to `GET /v1/registry/orgs` and
  `GET /v1/registry/orgs/:did`, or to `ADMIN_API_KEY`; then, in a release
  recorded in `CHANGELOG.md` as a breaking change, make the check on by
  default with `TRUST_REGISTRY_ADMIN_LISTING_ENFORCED=false` as the explicit
  opt-out. Owner: the auth-service maintainers. Exit criterion: flag default
  flipped with an explicit opt-out once operators have moved.
