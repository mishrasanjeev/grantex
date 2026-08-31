# Agent Wallet Governance Gap Review

Date: 2026-08-31

## Scope

This review separates the Grantex authorization/governance layer from the
external issuer, custodian, payment network, merchant, and agent-runtime layers.
It records implemented controls, test evidence, and residual gaps without
claiming that Grantex is a bank, card issuer, custodian, or settlement network.

## Closed Grantex gaps

1. Assignment defaults are deny-by-default for recipient, action scope, and
   resource origin unless the principal explicitly enables an allow-any flag.
2. Policies compose at assignment, wallet, agent, budget-group, principal, and
   developer scopes.
3. Amount and count limits support per-authorization, rolling, day, week, month,
   and lifetime windows and include active reservations.
4. Cross-agent group and principal limits serialize under a shared database
   policy lock, preventing concurrent overspend.
5. Policy filters bind asset, network, recipient, resource origin, action scope,
   merchant ID, purpose, project ID, cost center, and merchant verification.
6. Principal approval is exact-bound, expires, is single-use, and preserves the
   original wallet and idempotency key.
7. Wallet authorization JWTs bind the semantic context used by policy. x402
   verify and settle reject any changed context.
8. Reload controls cap balance, one reload, cumulative amount, and count and are
   rechecked at funding time.
9. Principal, developer, and agent routes retain distinct authentication
   boundaries. An agent cannot approve or fund a reload or payment.
10. Policy decisions and ledger evidence are durable and append-only. Policy and
    stop changes release active reservations in the affected boundary.
11. The principal dashboard exposes payment approvals, layered policy status,
    wallet/reload activity, and emergency stop controls.
12. TypeScript, x402, Python, and Go clients expose the new control plane. Agent
    clients produce real ES256 DPoP proofs in Python and Go.

## Residual Grantex product gaps

1. No policy-simulation endpoint exists. The safe workflow is disabled policy,
   sandbox test, decision inspection, activation.
2. No multi-currency conversion/aggregation exists. Atomic assets are evaluated
   independently.
3. Developer API keys remain tenant-administrator credentials rather than
   fine-grained policy-operator roles.
4. Approval expiry is a server-defined short window rather than configurable per
   policy.
5. Event publication is best effort after the durable decision transaction; an
   operator-grade outbox is still needed for guaranteed external notification.
6. Trust Registry merchant verification proves the configured domain state; it
   is not KYC, sanctions screening, or payment-provider onboarding.
7. Purpose, project, and cost-center labels are caller-supplied. Grantex binds
   them to policy decisions and proofs but does not independently attest their
   business meaning.

## External gaps

1. External custody/provider adapter and real-time provider authorization.
2. KYC/KYB, AML, sanctions, fraud, MCC, geography, card state, and safeguarding.
3. Clearing, settlement, FX, refunds, disputes, chargebacks, and reconciliation.
4. Durable principal email/SMS/chat delivery and escalation.
5. Merchant-side server-trusted pricing, order idempotency, settlement gating,
   and durable delivery-result recovery.
6. Independent legal, regulatory, security, and provider review.

## Review rounds

### Round 1: concurrency and database integrity

- Found and fixed PostgreSQL polymorphic array inference in policy filters by
  casting all policy arrays to `text[]`.
- Added a developer-wide advisory policy lock shared by evaluation/reservation
  and policy-change reservation release.
- Verified cross-agent group limits and policy mutation release in Docker.
- Found and fixed resource-origin historical accounting: matching policies now
  count only reservations for the matching normalized origin, including a
  migration backfill for existing reservation rows. Added a Docker regression
  covering two origins under one assignment.

### Round 2: protocol and SDK parity

- Found and fixed x402 upstream error wrapping that erased structured approval
  details.
- Verified exact retry pinning and semantic context propagation.
- Found and fixed approval-policy drift: when the effective approval-policy set
  changes, the prior request is retained as expired evidence and a new exact
  request carries the complete current policy set instead of reusing a stale or
  partial approval.
- Found and fixed policy-change/settlement ordering: policy mutation and active
  reservation release now share one transaction and advisory lock, and
  settlement acquires the same lock before moving value.
- Added equivalent principal, developer, and DPoP agent surfaces in TypeScript,
  Python, and Go.

### Round 3: deployment and claim integrity

- Public documentation assigns custody/network responsibilities to the issuer
  and merchant rather than Grantex.
- Corrected a README heading that described release candidates as
  registry-verified and documented the caller-supplied semantic-label boundary.
- Hardened SDK publication so npm/PyPI jobs consume the single verified build
  artifact, use OIDC trusted publishing, require a protected environment, and
  do not rebuild source during publication.
- Release and production checks must validate migrations, route ingress,
  registry contents, external dependency fail-closed behavior, and production
  x402 approval/settlement before claiming availability.

## Required test evidence before merge

- Auth-service full typecheck and full Vitest suite.
- TypeScript SDK typecheck, build, and full tests.
- x402 typecheck, build, and full tests.
- Python Ruff, strict Mypy, build, and full Pytest suite from repository source.
- Go `go test ./...`.
- Docker migration from a clean database plus existing prepaid-wallet and new
  layered-governance E2E suites.
- Documentation navigation and link checks.
- Post-merge CI, production deploy, production E2E, and registry smoke tests.
