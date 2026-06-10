# C6U10 Live Provider Readiness Packet

This packet is a review checklist only. It does not approve live provider use, live Plural, payment approval, checkout approval, production readiness, certification, conformance, compliance, public launch, merchant approval, fulfillment enablement, refund enablement, settlement enablement, or payout enablement.

C6U10 does not change runtime code, routes, OpenAPI, workflows, migrations, production config, secrets, allowlists, public discovery, checkout/payment production behavior, provider adapters, carrier integrations, merchant-private API access, or protocol publication. Live mode remains blocked by the existing Commerce guard.

## Current Blocker Context

Post-C6U9 MPP E2E failed in the client-side verification step because the production JWKS endpoint returned HTTP 500. C6U9 changed only sandbox checkout helper, test, and documentation files, and did not change JWKS, passport verification, workflow, deployment, or config paths.

Before any later live-mode review, operators must resolve the JWKS runtime/config/service issue through approved production diagnostics. This packet does not request or perform those diagnostics.

## Scope

C6U10 defines evidence needed before a future live provider review can even be considered. It is intentionally non-enabling:

- No live payment calls.
- No live Plural calls.
- No provider credential handling.
- No provider or carrier network calls.
- No merchant private API calls.
- No public discovery enablement.
- No production checkout/payment creation.
- No workflow or deployment changes.
- No production allowlist updates.

## Live Provider Prerequisites

Required evidence for a later review:

- The post-C6U9 JWKS blocker has a documented root cause and resolution path.
- The provider adapter contract is reviewed in sandbox/local test conditions only.
- All checkout/payment creation paths remain guarded by `ensureCommerceLiveMode`.
- Provider-specific live behavior remains behind explicit guard checks.
- Webhook processing cannot advance payment state unless the same live-mode guard permits the provider path.
- Idempotency, replay, audit, and redaction behavior have focused tests.
- Public discovery remains hidden unless a later separately approved slice changes that.

## Legal, Partner, Security, And Operator Checklist

Checklist items for a future review record:

- Legal review identifies permitted payment geography, data use, retention, dispute handling, and required notices.
- Partner review confirms the provider account, sandbox-to-live transition procedure, webhook configuration procedure, and support escalation path.
- Security review confirms credential storage, rotation, least privilege, webhook signature validation, replay prevention, audit evidence, and incident response.
- Operator review confirms runbooks, rollback stop conditions, monitoring, alerting, and manual kill switches.
- Product review confirms buyer-facing wording is public-safe and does not imply launch approval.

No checklist item is satisfied by this document. Each item requires separate evidence.

## Feature Flag And Config Checklist

The following remain unchanged by C6U10:

- `COMMERCE_LIVE_MODE_ENABLED` stays off.
- `PLURAL_LIVE_ENABLED` stays off.
- `PLURAL_SANDBOX_ENABLED` is not changed by this slice.
- `COMMERCE_PUBLIC_DISCOVERY_ENABLED` is not changed by this slice.
- Production merchant allowlists are not changed by this slice.
- Production Commerce V1 enablement is not changed by this slice.

A later review must include a config diff, operator approval record, rollback owner, and test evidence before any flag change is considered.

## Credential Handling Checklist

Provider credential evidence must be stored outside source control and outside docs/tests. The future review packet must show:

- Secret owner and rotation owner.
- Storage location class without revealing secret values.
- Access review evidence.
- Rotation procedure and emergency revoke procedure.
- Webhook secret validation evidence without pasting secret material.
- Audit evidence references that are identifiers only.

Forbidden in source, tests, docs, logs, and PR text:

- Private keys.
- API keys.
- Bearer tokens.
- JWTs or raw passports.
- Webhook secrets.
- DB or Redis URLs.
- Provider dashboard URLs that expose private account state.
- Raw webhook or connector payloads.

## Provider Adapter Contract Checklist

A future provider adapter review must prove:

- Adapter calls are behind the central live-mode guard.
- Sandbox/local test behavior cannot be promoted to live by request payload alone.
- Provider key selection is validated against an allowlisted enum.
- Provider errors are normalized into buyer-safe messages.
- Raw provider payloads are stored only through approved references or hashes.
- Provider metadata is redacted before any buyer-safe response.
- No direct Plural call path bypasses the provider abstraction.
- No merchant private API path is introduced.

## Webhook Signature Checklist

A future webhook review must prove:

- Signature verification is provider-specific and mandatory before state changes.
- Timestamp tolerance is bounded.
- Replay identifiers are tenant-scoped.
- Failed signature events are audited with safe references.
- Raw payload storage uses approved references and retention rules.
- Live provider webhooks remain blocked unless the live-mode guard permits the provider path.

## Webhook Replay Checklist

A future replay review must prove:

- Replay is tenant-scoped and idempotent.
- Replay does not accept edited raw payloads.
- Replay cannot cross provider, merchant, payment intent, or tenant boundaries.
- Replay records attempt count, reason, actor, and audit reference.
- Replay is blocked for unresolved signature failures.

## Idempotency Checklist

A future review must prove:

- Idempotency keys are hashed before storage.
- Scope includes tenant, merchant, provider, operation, and stable resource reference.
- Same key and same body returns the same safe result.
- Same key and changed body returns a conflict.
- Idempotency conflicts are audited with public-safe references.

## Reconciliation Checklist

A future reconciliation review must prove:

- Reconciliation is read-only until explicitly authorized by a separate slice.
- Provider facts are normalized before comparison.
- Differences do not auto-settle, auto-refund, auto-payout, or auto-fulfill.
- Reconciliation output is public-safe and contains no raw provider payloads.
- Operator review is required before any state correction.

## Settlement And Payout Non-Enablement

C6U10 does not add settlement or payout fields, jobs, routes, providers, credentials, or runbooks that execute movement of funds. Settlement and payout remain future slices.

## Refund Non-Enablement

C6U10 does not execute refunds, create refund provider objects, call provider refund APIs, expose refund routes, or change refund state. Refund execution remains a future slice.

## Support, Incident, And Rollback Stop Conditions

Stop immediately if any of the following is true:

- JWKS, passport verification, or signature validation has an unresolved runtime error.
- A required secret or credential is missing, malformed, leaked, or stored in source control.
- Any production flag, allowlist, route, or workflow change is required.
- Any provider, Plural, carrier, or merchant-private API call is required.
- Buyer-facing text would imply launch approval or payment approval.
- Audit evidence cannot be produced with safe references.
- A rollback owner or operator contact is missing.

Rollback evidence for a later live-mode review must identify the config key, owner, expected effect, and verification command. This C6U10 slice does not run those commands.

## Data Retention, Privacy, And Audit Evidence

Required future evidence:

- Retention period for provider references, webhook references, audit events, and redacted payload references.
- Data minimization review for buyer, merchant, session, passport, and payment facts.
- Audit event taxonomy for provider call request, provider call result, webhook received, signature failed, replay rejected, idempotency conflict, manual review, and rollback.
- Redaction rules for buyer-safe responses.
- Evidence references must be identifiers, hashes, timestamps, and actor references only.

## Evidence Required Before Later Live-Mode Review

A later review packet must include:

- Resolved JWKS blocker evidence.
- Passing focused live-mode guard tests.
- Passing no-Plural-leak and provider-neutrality scans.
- Passing checkout/payment refusal tests with live flags off.
- Provider adapter contract review notes.
- Webhook signature and replay test evidence.
- Idempotency and reconciliation test evidence.
- Secret handling review record without secret values.
- Operator stop-condition and rollback record.
- Guardrail scan report for secrets, tokens, raw payloads, production config, allowlists, public discovery, provider calls, private API calls, protocol publication, and overclaim wording.

## Buyer-Safe Wording Examples

Safe examples:

- "Checkout is not available for this merchant in this environment."
- "Payment status cannot be shown because live provider facts are unavailable."
- "This request requires operator review before any provider action."

Unsafe examples:

- "Payment approved by provider."
- "Checkout approved for production."
- "Merchant approved for public launch."
- "Refunds enabled."
- "Settlement enabled."
- "Live order processing enabled."

## AgenticOrg Future-Consumption Note

AgenticOrg must continue refusing checkout, order, payment, fulfillment, delivery, support, return, refund, settlement, and payout status unless Grantex supplies buyer-safe source facts. AgenticOrg must not infer provider state from sandbox fixtures, local helper output, missing facts, stale facts, cached state, or merchant-private systems.

## API, OpenAPI, Migration, And Workflow Note

C6U10 adds no endpoint, route, OpenAPI schema, migration, workflow, deployment behavior, config key, secret, or runtime provider adapter. OpenAPI is unchanged because this packet exposes no API surface.

## Future Slices

Future work remains separate:

- AgenticOrg buyer-facing sandbox checkout consumption.
- Provider sandbox adapter review.
- Webhook and reconciliation hardening.
- Fulfillment/support execution contracts.
- Refund execution.
- Settlement, payout, and reconciliation execution.
- Live provider review with live mode still blocked until explicitly authorized.
