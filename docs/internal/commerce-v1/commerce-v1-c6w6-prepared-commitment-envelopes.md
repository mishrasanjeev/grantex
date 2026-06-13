# Commerce V1 C6W6 - Prepared Commitment Envelopes

Status: implementation foundation, internal-only, non-enabling.

## Scope

C6W6 defines prepared commitment request envelopes over C6W5 commitment-boundary decisions. Envelopes are local handoff artifacts for confirmation and source refresh. They are not execution instructions.

This slice adds helper logic, tests, and internal documentation only. It does not add endpoints, routes, OpenAPI, migrations, workflows, config, secrets, provider adapters, external calls, public discovery, checkout/payment, live provider rail behavior, merchant private API behavior, or cloud behavior.

Grantex remains the trust, protocol, policy, and canonical-artifact authority. AgenticOrg remains the buyer/seller agent runtime. Merchant systems remain operational sources of record. Provider and fintech rails own payment and mandate execution.

## Envelope Kinds

C6W6 supports five internal envelope kinds:

- buyer_confirmation_request: asks a buyer or operator to confirm whether a non-executing request should be sent.
- seller_source_refresh_request: asks a seller agent or source owner to refresh missing, stale, expired, revoked, or ambiguous facts.
- merchant_confirmation_request: prepares an evidence-only merchant-side confirmation request for price, inventory, reservation, or order preparation facts.
- mandate_capability_evidence_request: prepares a request for cached provider-owned mandate capability evidence.
- support_escalation_preparation: prepares a non-binding support escalation note without promising SLA, refund, return, replacement, settlement, or payout.

## Required Fields

Every prepared envelope includes envelope_id, envelope_kind, created_at, expires_at, max_ttl_seconds, source_resolver_decision_id, action_class, requested_action, risk_tier, offline_mode_status, allowed_to_preview, allowed_to_prepare, allowed_to_execute, prepared_only, source artifact IDs and families, source authority, required fresh artifact families, freshness summary, blocked capabilities, unsupported capabilities, buyer-safe message, seller-safe message, next_human_step, next_system_step_label, redacted evidence refs, and non-authoritative/non-enablement flags.

allowed_to_execute remains false. prepared_only remains true. next_system_step_label is a label only, never an endpoint URL.

## Fail-Closed Rules

C6W6 refuses or emits a blocked result when:

- the C6W5 resolver decision is missing.
- the resolver decision allows execution.
- source artifact IDs or families are absent.
- freshness or TTL metadata is missing, stale, expired, or ambiguous.
- the action is always blocked.
- the envelope kind does not match the requested action.
- commitment-bound amount, currency, or quantity context is ambiguous.
- the request implies live provider rails, payment, checkout, public discovery, merchant private API, shipping/carrier API, protocol publication, or certification-style claims.
- evidence refs or envelope fields contain private credentials, raw JWTs, private URLs, provider payloads, DB/Redis URLs, private keys, or allowlist values.

## Confirmation Handoff

Buyer confirmation envelopes describe what the buyer is being asked to confirm and preserve source/freshness labels. Seller refresh envelopes carry missing or stale source-family context and redacted evidence refs. Merchant confirmation envelopes are evidence-only and do not create orders, holds, payments, refunds, returns, or shipments. Mandate capability envelopes request cached evidence only and do not call provider rails. Support preparation envelopes do not promise outcomes.

## Toll Booth Boundary

Grantex does not become a synchronous toll booth for non-binding agent interactions. Grantex defines and validates canonical artifact and envelope policy. AgenticOrg can prepare local handoff envelopes from valid cached authority and C6W5 decisions while staying fail-closed.

## What This Does Not Enable

C6W6 does not enable:

- Public discovery.
- Production Commerce V1.
- Checkout/payment creation.
- Payment capture or debit.
- Live payments.
- Live provider rail use.
- Provider calls.
- Carrier or shipping provider calls.
- Merchant private API calls.
- Connector credential export.
- Production allowlists.
- Public OACP publication.
- External protocol submission.
- Certification, compliance, conformance, standardization, production readiness, public-launch readiness, merchant approval, checkout approval, payment approval, live provider readiness, or OACP public readiness claims.

## Future Slices

Future implementation must still add separate controls before any execution handoff:

- Human confirmation audit records.
- Merchant-system evidence reconciliation from source-owned systems.
- Provider-owned mandate verification outside C6W6.
- Explicit execution rails outside Grantex and AgenticOrg preview surfaces.
