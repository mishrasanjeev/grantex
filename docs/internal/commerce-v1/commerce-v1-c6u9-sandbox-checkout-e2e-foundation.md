# C6U9 Sandbox Checkout E2E Foundation

Status: internal implementation note only. This is not a production launch, public discovery approval, checkout approval, payment approval, merchant approval, protocol publication, external submission, certification, compliance, conformance, standardization, public-launch readiness, production readiness, fulfillment enablement, delivery enablement, shipping enablement, refund enablement, settlement enablement, or payout enablement claim.

This is not a production launch, public discovery approval, checkout approval, payment approval, merchant approval, fulfillment approval, refund approval, settlement approval, payout approval, or protocol publication.

## Scope

C6U9 adds a Grantex-owned sandbox checkout E2E contract foundation. It is model/helper, docs, and tests only. No migration, route, endpoint, or OpenAPI surface is added by C6U9 because no external or buyer-facing checkout API is exposed by this slice.

The foundation proves a synthetic, local sequence across cart facts, consent and Commerce Passport authority, order foundation, handoff foundation, sandbox payment intent reference, audit evidence, idempotency, and refusal paths. It does not create checkout links, create production payment records, call payment providers, call Plural, call carriers, call merchant private APIs, expose public discovery, set production allowlists, change production config, execute fulfillment, execute refunds, perform settlement, or perform payout.

## Sandbox-Only Sequence

The C6U9 helper records the intended sequence as a local contract:

1. Resolve tenant, merchant, buyer, CommerceAgent, and buyer session context.
2. Confirm public discovery remains hidden or disabled for this slice.
3. Confirm user consent and checkout-scoped Commerce Passport authority are represented by safe metadata only.
4. Reference a Grantex cart snapshot with buyer-safe product, variant, SKU, price, tax-unknown, final-price-unknown, and freshness facts.
5. Build an order foundation draft from C6U7 using the safe cart snapshot.
6. Build a C6U8 handoff placeholder linked to the order with non-executing fulfillment status.
7. Record a synthetic payment outcome label only.
8. Attach redacted audit evidence references and hashed idempotency evidence.

The result is a proof of shape and safety, not a live or production checkout path.

## Actors And Authority

| Actor | C6U9 Role |
| --- | --- |
| Tenant | Owns every sandbox checkout fact and idempotency scope |
| Merchant | Owns the cart, order, payment-intent reference, and handoff context |
| Buyer | Matches the consent and Commerce Passport authority metadata |
| CommerceAgent | Must match the authority metadata and requested scopes |
| Grantex authority | Remains source of truth for consent, passport status, revocation, policy, and audit evidence |

Agent authentication is not user consent. C6U9 requires both consent and checkout-scoped Commerce Passport authority before the sandbox sequence can be represented.

## Consent And Passport Role

C6U9 treats authority as buyer-safe metadata:

- consent granted
- passport state: valid, missing, expired, revoked, mismatched, or unknown
- passport type
- tenant, merchant, buyer, agent, and session match
- sandbox environment
- checkout and payment-initiation scopes

Missing consent, missing passport, expired passport, revoked passport, mismatched authority, unknown authority, non-checkout passport type, missing scopes, or non-sandbox environment all fail closed.

## Order Foundation Role

C6U9 uses the C6U7 order foundation to represent a safe order draft from cart facts. The order foundation remains fail-closed and non-payment-enabling. It does not imply checkout creation, payment creation, provider action, fulfillment, support, refund, settlement, or payout.

## Handoff Foundation Role

C6U9 uses the C6U8 handoff foundation to represent a non-executing fulfillment placeholder linked to the order. The handoff record is buyer-safe and cannot imply fulfillment execution, delivery execution, carrier booking, support workflow execution, return execution, refund execution, settlement, or payout.

## Synthetic Payment Outcome Model

Allowed C6U9 outcome labels are:

- `not_attempted`
- `synthetic_authorized`
- `synthetic_pending`
- `synthetic_succeeded`
- `synthetic_declined`
- `synthetic_expired`
- `synthetic_cancelled`

These are local contract labels only. They do not create provider payments, Plural payments, checkout links, hosted checkout URLs, webhook payloads, settlement records, payout records, or live payment status.

## Idempotency And Replay Model

C6U9 idempotency is scoped to `sandbox.checkout.e2e.contract` with tenant, merchant, hashed idempotency key, and request-body hash evidence. The helper can classify:

- new request
- replay when the same hashed key and same request body are used
- conflict when the same hashed key is used with a different request body

Raw idempotency keys are not required and must not be exposed.

## Audit Evidence Model

C6U9 requires redacted audit evidence references. The helper and docs must not expose raw passports, JWTs, raw tokens, raw consent payloads, provider credentials, carrier credentials, raw provider payloads, raw carrier payloads, raw connector payloads, provider payment IDs, checkout URLs, merchant private URLs, DB/Redis URLs, webhook secrets, production config values, concrete production allowlists, settlement references, payout references, or refund execution references.

## Fail-Closed Refusals

| Condition | Public-Safe Refusal |
| --- | --- |
| Missing tenant | Sandbox checkout requires a tenant-bound Grantex context. |
| Missing merchant | Sandbox checkout requires a merchant-bound Grantex context. |
| Missing buyer/session principal | Sandbox checkout requires a buyer or session principal. |
| Missing CommerceAgent | Sandbox checkout requires a registered CommerceAgent context. |
| Missing consent | Sandbox checkout requires user consent before protected sequencing can continue. |
| Missing passport | Sandbox checkout requires Commerce Passport authority before protected sequencing can continue. |
| Expired passport | Sandbox checkout authority has expired. Refresh consent before continuing. |
| Revoked passport | Sandbox checkout authority has been revoked. |
| Mismatched authority | Sandbox checkout authority does not match this tenant, merchant, buyer, session, or agent. |
| Unknown authority | Sandbox checkout authority is unknown. Refresh from Grantex before continuing. |
| Missing scopes | Sandbox checkout requires checkout and payment initiation scopes. |
| Live or unknown environment | Sandbox checkout E2E refuses live or unknown payment environments. |
| Public discovery not hidden | Buyer-facing checkout remains unavailable while public discovery is not enabled for this slice. |
| Missing audit evidence | Sandbox checkout requires redacted audit evidence references. |

## Buyer-Safe Wording Examples

- "Sandbox checkout requires user consent before protected sequencing can continue."
- "Sandbox checkout authority has been revoked."
- "Sandbox checkout E2E refuses live or unknown payment environments."
- "Synthetic payment outcome was recorded locally without checkout, provider, Plural, carrier, or merchant private API execution."

## Unsafe Wording Examples

- "Checkout is approved."
- "Payment is approved."
- "Live payment is ready."
- "Fulfillment is enabled."
- "Refunds are enabled."
- "Settlement or payout is complete."
- "Provider payment ID is available."
- "Merchant private API returned order status."

Those phrases are unsafe unless a later slice adds explicit Grantex-owned source facts, execution controls, buyer-safe evidence, and review.

## AgenticOrg Future-Consumption Note

AgenticOrg must continue refusing checkout, order, payment, support, fulfillment, delivery, return, or refund status unless Grantex supplies buyer-safe source facts scoped to the same tenant, merchant, buyer, session, and CommerceAgent. AgenticOrg must not infer status from cached state and must not create or expose checkout/payment status from this C6U9 helper alone.

## API And OpenAPI Note

No migration, route, endpoint, or OpenAPI surface is added by C6U9. The helper exists only to validate local sandbox sequencing and refusal behavior in tests. A future external or buyer-facing surface requires a separate API, OpenAPI, auth, tenant-boundary, rate-limit, audit, and non-enablement review.

## Stop Conditions

Sandbox checkout E2E must stop if a future change requires provider, Plural, carrier, merchant-private API, or public discovery behavior. It must also stop if it requires:

- production checkout or payment creation
- live payment or live Plural
- raw provider, carrier, connector, or merchant private payloads
- production config or production allowlists
- workflow changes
- cloud resources or deploy behavior
- fulfillment, delivery, support, return, refund, settlement, payout, or shipping execution
- protocol publication or external submission
- certification, compliance, conformance, standardization, merchant approval, public-launch readiness, production readiness, checkout approval, payment approval, fulfillment enablement, delivery enablement, shipping enablement, refund enablement, settlement enablement, or payout enablement claims

## Future Slices

- AgenticOrg buyer-facing sandbox checkout consumption
- payment provider sandbox adapter readiness
- webhook and reconciliation hardening
- support and fulfillment execution contracts
- refund execution
- settlement, payout, and reconciliation
- live provider readiness

Each future slice needs its own source-of-truth, tenant-boundary, authorization, audit, redaction, rollback, and non-enablement review before any external surface is exposed.

## Validation

C6U9 validation should include focused sandbox checkout E2E tests, nearby cart/payment/order/handoff/refusal tests, typecheck, whitespace diff check, ASCII check for new files, secret/private scan, passport/JWT/raw-token scan, production config/allowlist scan, public discovery enablement scan, production checkout/payment enablement scan, live-provider/live-Plural scan, direct provider/Plural scan, carrier/private API scan, raw connector/private payload scan, protocol publication/submission scan, and overclaim scan.
