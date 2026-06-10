# C6U4 Source/Freshness and Buyer-Safe Commercial Fact Projection

Status: internal implementation note only. This document does not approve production launch, real merchants, public discovery, checkout/payment, live providers, live Plural, production config, production allowlists, cloud resources, provider calls, merchant private API calls, protocol publication, external submission, certification, compliance, conformance, standardization, public-launch readiness, merchant approval, or production readiness.

## Purpose

C6U4 closes the C6U2/C6U3 mismatch where Grantex has richer source and freshness controls than AgenticOrg buyer-facing projection. The goal is to keep buyer agents from overstating price, inventory, tax, warranty, return, delivery, support, fulfillment, refund, settlement, payout, discount, coupon, or EMI facts.

Grantex remains the source of truth for merchant profile, catalog, inventory, connector source, readiness, review, and audit facts. AgenticOrg may show only buyer-safe facts returned by Grantex and must qualify or refuse missing, stale, private, unapproved, or ambiguous facts.

## Projection Model

| Fact area | Grantex-owned source | Buyer-safe projection rule |
| --- | --- | --- |
| Merchant identity | Sandbox merchant profile and review/handoff state | Show only public display name, category, country, currency, and public-safe description. |
| Product identity | Agent-facing preview sample products | Show public-safe title, brand/category when available, and capped sample references only. |
| Preview price | Variant `price_amount` and `currency` | May be described only as preview price. It is not a final payable amount. |
| Tax/GST | Catalog readiness and later tax fields | If missing, AgenticOrg must say tax is not confirmed. |
| Warranty | Variant warranty summary | If missing, AgenticOrg must not invent warranty terms. |
| Return/refund | Variant return summary and future refund contracts | If missing, AgenticOrg must not invent return, refund, replacement, or chargeback handling. |
| Inventory | Availability bucket plus freshness checks | Unknown or stale inventory stays unknown/stale; no quantity or reservation is exposed. |
| Delivery/support/fulfillment | Future order/support/fulfillment contracts | Refuse execution or promises until Grantex exposes source facts. |
| Settlement/payout/reconciliation | Future payment/order operations contracts | Refuse buyer-facing claims; these are not buyer discovery facts. |
| Source/freshness | Connector/source governance and readiness checks | Show only buyer-safe source labels and freshness status. Do not expose private system names, URLs, raw payloads, credentials, or internal IDs. |

## Current Grantex Contract

Grantex already enforces the following non-enabling controls:

- Sandbox onboarding readiness requires public-safe profile, category, catalog, and non-enabling checks.
- Catalog readiness tracks price/currency, warranty summary, return-policy summary, tax/GST metadata, availability freshness, known availability, and unsafe catalog text.
- Agent-facing preview is capped and sanitized.
- Preview flags stay false for public discovery, checkout/payment, live provider, live Plural, and production approval.
- Preview variants expose only SKU, variant title, preview price amount, currency, availability bucket, warranty summary, and return-policy summary.
- Preview variants do not expose source system names, raw connector payloads, private URLs, provider credentials, exact inventory quantity, final price, tax amount, delivery promises, settlement, payout, or refund execution.

The C6U4 Grantex test pins that contract without adding runtime behavior.

## AgenticOrg Projection Requirements

AgenticOrg must:

- Treat Grantex preview price as preview-only and not a final payable price.
- Mark tax/GST, delivery, support, fulfillment, refund, settlement, payout, discount, coupon, and EMI as unknown or unsupported unless Grantex provides explicit buyer-safe facts.
- Treat stale or unknown inventory as caution/refusal and never as an in-stock promise.
- Redact private source labels, private URLs, raw connector payload markers, credentials, passport/JWT values, DB/Redis URLs, webhook secrets, and merchant-private identifiers.
- Keep public discovery hidden unless both Grantex and AgenticOrg gates are explicitly approved in a later slice.
- Refuse checkout/payment, live provider, live Plural, provider calls, and merchant private API calls.

## Safe Wording

Safe examples:

- "Grantex shows a preview price for this sample, but final tax, fees, discounts, and checkout totals are not confirmed."
- "Availability is unknown or stale, so I cannot confirm stock."
- "Warranty terms are not confirmed by Grantex for this preview item."
- "Delivery and refund handling are not enabled in this buyer discovery slice."

Unsafe wording that must be refused or rewritten:

- "This is the final price including all taxes."
- "Guaranteed delivery tomorrow."
- "Guaranteed refund is available."
- "Guaranteed in stock with 25 units."
- "I checked the merchant private system."
- "The payment provider approved this checkout."

## Stop Conditions

Stop and do not merge a future C6U4 follow-up if any change:

- Adds runtime routes, migrations, workflow changes, production config, secrets, cloud resources, provider calls, merchant private API calls, production allowlists, public discovery enablement, checkout/payment enablement, live provider enablement, or live Plural enablement.
- Exposes private source labels, raw connector payloads, private URLs, credentials, internal tenant/merchant IDs, DB/Redis URLs, webhook secrets, or passport/JWT values.
- Claims production launch, public launch, certification, compliance, conformance, standardization, merchant approval, or external standards approval.

## Remaining Gaps

- Shared public discovery state contract.
- Consent/session/passport revocation propagation.
- Channel-specific refusal packs.
- Order, fulfillment, refund, support, settlement, and payout contracts.
- Sandbox checkout E2E.
- Live provider readiness.
- AgenticOrg CI/CD cloud-build guard follow-up.

## Validation

C6U4 validation should include focused source/freshness projection tests, Commerce Preview Conformance gate, diff whitespace check, ASCII check, secret/private scan, production config/allowlist scan, public discovery/payment/live-provider enablement scan, direct provider/Plural scan, merchant private API scan, raw connector/private payload scan, and overclaim scan.
