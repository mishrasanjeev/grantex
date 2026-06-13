# Commerce V1 C6W7 - Response Reconciliation

Status: implementation foundation, internal-only, non-enabling.

## Scope

C6W7 defines internal prepared commitment response intake and evidence reconciliation over C6W6 prepared envelopes. Reconciliation is a local evidence result, not an execution instruction and not transaction authority.

This slice adds helper logic, tests, and internal documentation only. It does not add endpoints, routes, OpenAPI, migrations, workflows, config, secrets, provider adapters, external calls, public discovery, checkout/payment, live provider rail behavior, merchant private API behavior, shipping behavior, or cloud behavior.

Grantex remains the trust, protocol, policy, and canonical-artifact authority. AgenticOrg remains the buyer/seller agent runtime. Merchant systems remain operational sources of record. Provider and fintech rails own payment and mandate execution.

## Response Evidence Kinds

C6W7 supports five internal response evidence kinds:

- buyer_confirmation_response: buyer accepts for preparation, rejects, asks for clarification, or requests refresh.
- seller_source_refresh_response: seller agent reports refreshed, unchanged, missing, stale, or ambiguous source facts.
- merchant_confirmation_response: merchant or source owner confirms, rejects, expires, or asks for manual review.
- mandate_capability_evidence_response: cached provider-owned mandate capability evidence is present, missing, expired, rejected, or needs human review.
- support_escalation_response: support preparation is acknowledged, rejected, or routed for review without promising outcomes.

## Reconciliation Output

Every reconciliation includes reconciliation_id, envelope_id, envelope_kind, response_kind, response_status, created_at, expires_at, max_ttl_seconds, action_class, requested_action, risk_tier, source artifact IDs and families, source authority, response evidence refs, freshness summary, decision summary, unsupported capabilities, blocked capabilities, required next artifact families, buyer-safe message, seller-safe message, next_human_step, next_system_step_label, and non-authoritative/non-enablement flags.

allowed_to_execute remains false. prepared_only remains true. reconciled_only remains true. next_system_step_label is a label only, never an endpoint URL.

## Status Enum

C6W7 uses a small fail-closed status enum:

- accepted_for_preparation
- rejected
- needs_source_refresh
- needs_human_review
- expired
- stale
- mismatched
- blocked

accepted_for_preparation means local evidence can continue as preparation only. It does not mean checkout, payment, order, hold, refund, return, shipment, provider rail use, or merchant private API execution.

## Fail-Closed Rules

C6W7 refuses or emits a blocked result when:

- the C6W6 envelope is missing.
- the envelope allows execution.
- the envelope is not prepared_only.
- source artifact IDs, families, freshness, or TTL metadata is missing, stale, expired, or ambiguous.
- response kind does not match envelope kind.
- response status or flags try to execute or approve live action.
- response evidence refs are missing.
- response evidence contains private credentials, raw JWTs, private URLs, provider payloads, private customer data, DB/Redis URLs, private keys, or allowlist values.
- response evidence indicates checkout, payment, order, hold, refund, return, shipping, provider call, carrier call, merchant private API use, public discovery enablement, protocol publication/submission, certification, or production readiness.
- commitment-bound amount, currency, or quantity context is ambiguous.
- mandate capability evidence is older than the mandate TTL at the commitment boundary.
- merchant or source responses conflict with the C6W5 decision or C6W6 envelope metadata.

## Human And Source Responses

Buyer responses are recorded as local confirmation evidence only. Seller refresh responses can reference new artifact IDs only as evidence references. Merchant responses confirm or reject source facts without creating orders, holds, payments, refunds, returns, or shipments. Mandate evidence responses use cached evidence only and do not call provider rails. Support responses do not promise SLA, refund, return, replacement, settlement, or payout without source authority.

## Toll Booth Boundary

Grantex does not become a synchronous toll booth for non-binding agent interactions. Grantex defines and validates the canonical artifact and reconciliation policy. AgenticOrg can reconcile cached response evidence locally while preserving source authority and remaining fail-closed.

## What This Does Not Enable

C6W7 does not enable:

- Public discovery.
- Production Commerce V1.
- Checkout/payment creation.
- Order creation.
- Inventory holds.
- Payment capture or debit.
- Mandate creation.
- Refund or return execution.
- Shipping or carrier calls.
- Live provider rail use.
- Provider calls.
- Merchant private API calls.
- Connector credential export.
- Production allowlists.
- Public OACP publication.
- External protocol submission.
- Certification, compliance, conformance, standardization, production readiness, public-launch readiness, merchant approval, checkout approval, payment approval, live provider readiness, or OACP public readiness claims.

## Future Slices

Future implementation must still add separate controls before any execution handoff:

- Human confirmation audit storage.
- Merchant-system evidence ingestion from source-owned channels.
- Provider-owned mandate verification outside C6W7.
- Explicit controlled execution handoff outside Grantex policy helpers and AgenticOrg preview surfaces.
