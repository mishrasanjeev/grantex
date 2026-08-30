# Agent Prepaid Wallet and x402 v2 Brutal Review

Date: 2026-08-30

Status: three review rounds complete against the repository working tree. This
is an internal engineering record, not a public compliance or payment-network
certification.

## Reviewed outcome

The implemented `sandbox_ledger` flow lets a human principal:

- create and fund one or more prepaid wallets;
- assign each wallet to an OAuth Agent Grants agent;
- set per-transaction, rolling cumulative, recipient, action-scope, and
  validity policy;
- approve or reject a durable agent reload request and fund an approved request
  separately;
- block or revoke one assignment, block or close one wallet, or stop the agent
  across every wallet associated with that principal; and
- inspect assignments, reloads, reservations, settlements, releases, and an
  append-only financial ledger.

The agent can list its sanitized assignments, request a reload at or below the
principal's threshold, and use an official x402 v2
`PAYMENT-REQUIRED`/`PAYMENT-SIGNATURE`/`PAYMENT-RESPONSE` exchange. Grantex
reserves value before issuing a one-time authorization. The resource server
must settle successfully before irreversible protected work.

## Round 1: financial and authorization safety

| Finding | Severity | Resolution |
| --- | --- | --- |
| Concurrent requests could overrun a balance or rolling limit without one lock order. | Critical | Assignment, wallet, reservation, grant, and principal-control rows are locked in a consistent order. Candidate wallets are processed deterministically. Reservations and settlements use atomic-unit integers in one transaction. |
| A principal stop racing an authorization could leave a usable hold. | Critical | Assignment, wallet, all-wallet, policy-update, expiry, agent-suspension, and grant-revocation paths release affected reservations transactionally. Concurrent Docker tests verify no reserved hold survives a global stop or revocation. |
| A payment token could be replayed or rebound to changed x402 terms. | Critical | JWT and reservation bind developer, principal, agent, grant, wallet, assignment, amount, asset, network, recipient, exact resource URL, action scope, request hash, JTI, and expiry. Verify accepts only `reserved`; settle is one-time and idempotent. |
| Financial history could be altered or erased with an agent deletion. | Critical | Ledger rows are protected by update/delete and truncate triggers plus restricted database grants. Agents with financial history cannot be deleted. Wallet and assignment terminal states cannot be revived. |
| External provider records could be mistaken for funded wallets. | High | External custody requires a unique provider reference and fails closed for funding, authorization, and settlement until a real adapter verifies provider state. |
| Agent wallet listings exposed owner or custody internals. | High | Agent projections omit principal ID, provider IDs, wallet address, and metadata. Every query is partitioned by developer, principal, and agent. |
| Plain HTTP resources could receive a bearer-like payment authorization. | High | Remote resources require HTTPS. HTTP is accepted only for explicit loopback development hosts. Credentials, fragments, unsupported schemes, and relative URLs are rejected. |
| Forgery coverage mutated only unused base64url padding bits. | Medium | The test now changes a significant signature byte and proves the forged JWT is rejected. |

Round 1 verdict: no unresolved repository-side critical or high finding for the
implemented ledger mode.

## Round 2: protocol, API, and recovery behavior

| Finding | Severity | Resolution |
| --- | --- | --- |
| The prior custom payment-proof retry was not official x402 v2. | Critical | The agent adapter now consumes and emits official x402 v2 envelopes and headers using the x402 Foundation packages. The custom `X-Payment-Proof` path is not used. |
| A lost reload response could create another request or change its terms. | High | Agent and direct-principal reload operations require a high-entropy idempotency key. Durable unique indexes and request hashes replay the same result through terminal states and reject changed terms. |
| Wallet idempotency alone cannot recover merchant work after settlement. | High | Documentation and examples distinguish pre-settlement wallet reservation recovery from the merchant's normal `Idempotency-Key` and durable result cache. A settled authorization cannot execute again. |
| Verification could be mistaken for final payment. | High | The contract now states that verification is provisional and settlement must complete before irreversible protected work or return of the paid result. |
| Updating assignment policy could leave a hold authorized under old policy. | High | Policy replacement releases existing reservations before the new assignment policy becomes usable. Revoked assignments remain terminal. |
| API, SDK, and OpenAPI surfaces could drift. | Medium | All 16 principal, agent, and facilitator paths are present once in OpenAPI. The TypeScript clients exercise every path, token rotation, error mapping, and audience validation. |
| The source version could be confused with the npm release. | Medium | SDK 0.4.0 and x402 0.2.0 are labeled unreleased in compatibility, release-status, READMEs, docs, landing pages, and package-specific web pages. |

Round 2 verdict: protocol and recovery semantics are internally consistent; no
unresolved repository-side critical or high finding.

## Round 3: release, regression, documentation, and visual QA

| Finding | Severity | Resolution |
| --- | --- | --- |
| Public pages showed an npm install command for unreleased APIs. | High | The command was replaced by a source checkout, and public pages prominently state that current registry packages do not include managed wallets. The npm link is labeled as the published legacy package. |
| The five-step wallet diagram clipped and scrolled horizontally on mobile. | Medium | The diagram now uses a responsive row/column layout. At 390 px, panel client and scroll widths match; at 1280 px it remains a single row. |
| Documentation could imply external-chain or regulated stored-value settlement. | High | Public and internal docs identify `sandbox_ledger` as local/off-chain accounting and external custody as unavailable/fail-closed. |
| New routes or docs could break existing OAuth and principal sessions. | High | Full package regressions, Docker wallet E2E, OAuth agent-profile E2E, and principal-session E2E pass against the rebuilt local container. |
| Docs, workflows, or API YAML could be syntactically valid but internally broken. | Medium | Documentation integrity, Mintlify navigation, local links, public routes, JSON, workflow YAML, OpenAPI YAML, lock versions, and source-preview claims are checked. |

Round 3 verdict: release claims match the implemented and published state. The
local Docker reference path is green.

## Verification evidence

- Auth service: 166 files passed, 1 skipped; 2,124 tests passed, 2 skipped;
  typecheck and production build passed; production dependency audit found zero
  vulnerabilities.
- TypeScript SDK: 31 files and 450 tests passed; typecheck and build passed;
  production dependency audit found zero vulnerabilities.
- x402 package: 14 files and 188 tests passed; typecheck and build passed;
  production dependency audit found zero vulnerabilities.
- Docker: image rebuilt from the reviewed tree; health reported database and
  Redis healthy; 91 migrations applied.
- Wallet Docker E2E: multi-wallet selection, exact policy, official x402 retry,
  verify/settle, replay, reload, stop controls, expiry, concurrency, revocation,
  isolation, activity, and external fail-closed scenarios passed.
- Existing Docker regressions: OAuth agent profile passed; principal sessions
  passed 5 tests.
- Database probe: both reload idempotency indexes and both append-only ledger
  triggers exist. A direct ledger update failed with
  `wallet_ledger_entries is append-only`, with row count unchanged.
- Documentation integrity, workflow/OpenAPI YAML parsing, docs JSON parsing,
  root audit, weather example typecheck, and whitespace checks passed.
- Browser QA: landing-page wallet section has no document or panel overflow at
  390 x 844 or 1280 px desktop viewports; the public x402 preview disclosure is
  visible and unclipped.

## Honest residual boundaries

These are deliberate boundaries, not hidden claims:

1. `sandbox_ledger` is Grantex-managed local/off-chain accounting. It is not a
   bank account, prepaid card, on-chain transfer, regulated stored-value
   product, or proof of external funds.
2. `external` custody records are unusable until a provider-specific adapter
   verifies funding, reserves or settles value, reconciles state, and defines
   failure recovery. No such provider adapter is claimed here.
3. `grantex:prepaid` is the repository's managed network identifier carried in
   an official x402 v2 transport. It is not a claim of universal payment-rail
   certification or interoperability with every facilitator.
4. A side-effecting merchant must atomically cache its own business result by
   the caller's HTTP `Idempotency-Key`. Grantex settlement idempotency cannot
   recreate merchant work after a lost response.
5. SDK 0.4.0 and x402 0.2.0 must be published before npm consumers can use these
   APIs. Until then, the feature is a tested repository-source preview.
6. Reload requests are durable and emit Grantex events. Delivery through a
   principal's chosen email, messaging, or external notification channel still
   depends on that channel's configured webhook/consumer.
7. Independent interoperability, penetration, payment-provider, and regulatory
   certification were not performed by this repository review.
