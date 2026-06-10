# C6U8 Fulfillment, Delivery, Support, Return, And Refund Handoff

Status: internal implementation note only. This is not a production launch, public discovery approval, checkout approval, payment approval, merchant approval, protocol publication, external submission, certification, compliance, conformance, standardization, public-launch readiness, production readiness, fulfillment enablement, refund enablement, settlement enablement, payout enablement, delivery enablement, or shipping enablement claim.

This is not a production launch, public discovery approval, checkout approval, payment approval, merchant approval, fulfillment approval, refund approval, settlement approval, payout approval, or protocol publication.

## Scope

C6U8 adds a Grantex-owned handoff contract foundation for fulfillment, delivery, support, return, and refund status facts. It is schema/model/docs/test only in this slice. No endpoint or OpenAPI surface is added by C6U8 because no external or buyer-facing handoff API is exposed yet.

The foundation can hold tenant-scoped, buyer-safe source facts tied to a Grantex order. It does not enable public discovery, production Commerce V1, checkout creation, payment creation, live payments, live Plural, provider calls, carrier calls, shipping integration, merchant private API calls, refund execution, fulfillment execution, delivery execution, support workflow execution, settlement, payout, production allowlists, cloud resources, or deploy behavior.

## Handoff Contract Model

Every handoff record is tenant-scoped, order-scoped, and merchant-scoped. The foundation keeps:

- `tenant_id`
- `order_id`
- `merchant_id`
- buyer principal reference
- optional CommerceAgent reference
- optional session reference
- handoff type
- fail-closed handoff status
- immutable handoff snapshot
- source freshness references
- support placeholder
- redacted audit evidence references
- idempotency key hash scoped by tenant, order, handoff type, and handoff endpoint

The handoff snapshot can include only buyer-safe facts returned by Grantex-safe sources. Unknown or absent facts must remain explicit instead of being inferred.

## Handoff Types

| Type | Meaning In C6U8 | Execution Status |
| --- | --- | --- |
| `fulfillment` | Safe facts about future fulfillment handoff state | Execution is blocked |
| `delivery` | Safe facts about future delivery handoff state | Carrier and shipping integration are blocked |
| `support` | Safe facts about future support handoff state | Support workflow execution is blocked |
| `return` | Safe facts about future return handoff state | Return execution is blocked |
| `refund` | Safe facts about future refund handoff state | Refund and provider execution are blocked |

## Status Model

C6U8 handoff status is fail-closed and non-execution-enabling. Supported states are:

- `draft`
- `requested`
- `acknowledged`
- `blocked`
- `rejected`
- `expired`
- `cancelled`
- `manual_review_required`
- `resolved_manually`

No status means live fulfillment, live delivery, carrier booking, shipping label creation, support workflow execution, return execution, refund execution, settlement, payout, checkout creation, or payment-provider action.

## AgenticOrg Consumption Rule

AgenticOrg must refuse fulfillment, delivery, support, return, and refund status when Grantex has not provided buyer-safe source facts. A cached AgenticOrg state cannot create, infer, or override handoff status. AgenticOrg can only display future handoff facts that are explicitly returned by Grantex as buyer-safe and scoped to the same tenant, merchant, order, buyer, and session.

Buyer-safe wording examples:

- "Handoff status is unavailable until Grantex has safe source facts."
- "Support status is not available from Grantex for this order yet."
- "Fulfillment, delivery, return, and refund execution are not enabled by C6U8."
- "Handoff state is unknown. Refresh from Grantex before presenting status."

Unsafe wording examples:

- "Fulfillment is complete."
- "Delivery is booked with the carrier."
- "Refund has been processed."
- "Settlement or payout is complete."
- "Support case is resolved by the merchant system."

Those examples are unsafe unless a later slice adds a Grantex-owned source, buyer-safe evidence contract, and explicit execution controls.

## Audit And Evidence Expectations

Handoff records must reference redacted audit evidence. They must not expose raw passports, JWTs, tokens, raw consent payloads, provider credentials, carrier credentials, raw provider payloads, raw carrier payloads, raw connector payloads, provider payment IDs, private merchant URLs, DB/Redis URLs, webhook secrets, production config values, concrete production allowlists, private incident evidence, settlement references, payout references, or refund execution references.

Source freshness references must identify only safe source labels, source IDs, checked timestamps, and freshness state. Stale or unknown facts must remain visible as stale or unknown and must not be treated as successful execution.

## Migration And Rollback Notes

Migration 058 creates `commerce_order_handoffs` and adds `commerce_orders(tenant_id, id, merchant_id)` uniqueness so handoff rows can enforce tenant-safe order and merchant boundaries at the database layer. The added uniqueness is data-safe because `commerce_orders.id` is already the primary key, but adding the constraint may still take a table lock depending on table size and database behavior.

Rollback requires care because migration 058 adds a composite uniqueness constraint to `commerce_orders` and creates dependent foreign keys from `commerce_order_handoffs`. This migration is forward-only under the V1 migration policy. If old code is restored, it remains compatible because the new table is additive and no existing nullable/runtime field is required by older code.

## Stop Conditions

C6U8 must stop if it adds any of the following:

- endpoint, route, or OpenAPI exposure without a separate review
- checkout or payment creation
- live payment, live Plural, or provider calls
- carrier calls or shipping integration
- direct merchant private API calls
- public discovery enablement
- production Commerce V1 enablement
- production config or production allowlists
- cloud resources or deploy behavior
- workflow changes
- fulfillment, delivery, support, return, refund, settlement, payout, or shipping execution
- protocol publication or external submission
- certification, compliance, conformance, standardization, merchant approval, public-launch readiness, production readiness, checkout approval, payment approval, fulfillment enablement, delivery enablement, shipping enablement, refund enablement, settlement enablement, or payout enablement claims

## Future Slices

- AgenticOrg buyer-facing order/status consumption
- fulfillment execution
- carrier integration
- refund execution
- support workflow
- settlement, payout, and reconciliation
- sandbox checkout E2E
- live provider readiness

Each future slice needs its own source-of-truth, tenant-boundary, authorization, audit, redaction, rollback, and non-enablement review before any external surface is exposed.

## Validation

C6U8 validation should include focused handoff tests, nearby order/cart/payment/refusal tests, typecheck, whitespace diff check, ASCII check for new files, secret/private scan, passport/JWT/raw-token scan, production config/allowlist scan, public discovery enablement scan, checkout/payment/live-provider/live-Plural scan, direct provider/Plural scan, carrier/private API scan, raw connector/private payload scan, and overclaim scan.
