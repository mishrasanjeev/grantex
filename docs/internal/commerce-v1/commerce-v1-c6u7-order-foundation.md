# C6U7 Order Foundation

Status: internal implementation note only. This is not a production launch, public discovery approval, checkout approval, payment approval, merchant approval, protocol publication, external submission, certification, compliance, conformance, standardization, public-launch readiness, or production readiness claim.

This is not a production launch, public discovery approval, checkout approval, payment approval, merchant approval, or protocol publication.

## Boundary

C6U7 adds a Grantex-owned order foundation that can hold tenant-scoped order facts after Grantex has safe source data. It does not enable public discovery, production Commerce V1, checkout creation, payment creation, live payments, live Plural, provider calls, merchant private API calls, production allowlists, fulfillment execution, refund execution, settlement, payout, shipping integration, or support execution.

The order foundation sits between cart/payment records and future post-purchase flows. It is schema/model only in this slice. No new endpoint is added by C6U7.

## Required Order Facts

Every order record is tenant-scoped and merchant-scoped. The foundation keeps:

- `tenant_id`
- `merchant_id`
- buyer principal reference
- optional CommerceAgent reference
- optional Grantex cart reference
- optional Grantex payment-intent reference
- immutable line-item snapshot
- commercial fact snapshot
- source freshness references
- support reference placeholder
- redacted audit evidence references
- idempotency key hash scoped by tenant, merchant, and order foundation endpoint

Line-item snapshots include product ID, variant ID, title, SKU, quantity, price and currency when known, tax markers when tax is unknown, final-price markers when final price is unknown, and source/freshness references.

## Status Model

C6U7 order status is fail-closed and non-payment-enabling. Supported states are:

- `pending_source_facts`
- `recorded`
- `merchant_acknowledged`
- `closed`
- `cancelled`
- `expired`
- `blocked`
- `unknown`

The model intentionally has no `paid` status and no provider payment status. Payment state remains owned by `commerce_payment_intents`. An order status must not imply checkout, payment creation, fulfillment, refund, or support execution.

## AgenticOrg Consumption Rule

AgenticOrg must refuse order or support status when Grantex has not provided buyer-safe source facts. A cached AgenticOrg state cannot create or override order status. AgenticOrg can only display future order/support facts that are explicitly returned by Grantex as buyer-safe and scoped to the same tenant, merchant, buyer, and session.

Public-safe refusal examples:

- "Order status is unavailable until Grantex has safe source facts."
- "Support status is not available from Grantex for this order yet."
- "checkout/payment creation remains blocked by C6U7."

Do not expose raw passports, JWTs, tokens, raw consent payloads, provider credentials, raw provider payloads, provider payment IDs, merchant private URLs, DB/Redis URLs, webhook secrets, production config values, concrete production allowlists, raw connector payloads, or private incident evidence.

## Explicit Non-Goals

C6U7 must stop if it adds any of the following:

- checkout or payment creation
- live payment, live Plural, or provider calls
- direct merchant private API calls
- public discovery enablement
- production Commerce V1 enablement
- production config or production allowlists
- cloud resources or deploy behavior
- workflow changes
- fulfillment, refund, settlement, payout, shipping, or support execution
- protocol publication or external submission
- certification, compliance, conformance, standardization, merchant approval, public-launch readiness, or production readiness claims

## Validation

C6U7 validation should include focused order-foundation tests, nearby cart/payment/idempotency tests when touched, typecheck, whitespace diff check, ASCII check for new files, secret/private scan, passport/JWT/raw-token scan, production config/allowlist scan, public discovery enablement scan, checkout/payment/live-provider/live-Plural scan, direct provider/Plural scan, merchant private API scan, raw connector/private payload scan, and overclaim scan.
