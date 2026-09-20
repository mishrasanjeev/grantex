# Findings

Defects found while doing other work and deliberately left out of that change.
Each entry says where it was found, what is wrong and what fixing it involves.
Remove an entry in the pull request that fixes it.

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

## G-17 — The decision-grant migration test sees another test's tables

- **Found:** event bridge cascade revocation work (PRD G-6), 2026-09-20.
- **What:** `tests/decision-grants-postgres.integration.test.ts` asserts the
  `decision_%` tables by querying `information_schema.tables` without a schema
  predicate. `tests/evidence-postgres.integration.test.ts` creates its own
  schema containing `decision_requests` and `decision_grants`, so when the two
  files run at the same time against one database the assertion sees duplicate
  names and fails. Both files are in `main`; the failure is timing-dependent
  and unrelated to what either test is checking.
- **Fix:** add `AND table_schema = 'public'` (or `current_schema()`) to the
  query in the decision-grant test.

## G-18 — Every startup re-runs `ALTER TABLE grants` against live traffic

- **Found:** event bridge cascade revocation work (PRD G-6), 2026-09-20.
- **What:** `runMigrations` re-applies every file on every start, including
  `ALTER TABLE grants ADD COLUMN IF NOT EXISTS …` in migrations 002, 018, 061,
  089, 090, 095 and 098. Even when the column exists, the statement takes a
  brief `ACCESS EXCLUSIVE` lock on `grants`: during a rolling deploy it queues
  behind in-flight transactions, blocks every reader and writer of `grants`
  behind it, and can deadlock against a transaction that goes on to lock more
  rows (reproduced in this repository's test suite when a migration run
  overlapped a cascade-revocation transaction: `deadlock detected`).
- **Fix:** guard each `ALTER TABLE` with a catalogue check (`IF NOT EXISTS
  (SELECT 1 FROM information_schema.columns …) THEN … END IF`) so a no-op start
  takes no lock at all, and set a short `lock_timeout` around the real change
  (migration 100 already uses this pattern for its trigger).
- **Mitigated, not fixed:** revocation transactions retry on
  `deadlock_detected` (`apps/auth-service/src/lib/revocation/retry.ts`) so a
  revocation is not lost to this, and the Postgres integration fixtures retry
  too (`apps/auth-service/tests/deadlock-retry.ts`). The migrations themselves
  are unchanged. Seen in the Postgres log as: migration 095's `ALTER TABLE …
  ADD COLUMN IF NOT EXISTS` waiting for `AccessExclusiveLock` on
  `audit_entries` while a cascade transaction waited for `AccessShareLock` on
  `grants`.
