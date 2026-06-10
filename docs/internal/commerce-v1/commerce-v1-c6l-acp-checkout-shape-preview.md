# Commerce V1 C6L ACP-Style Checkout Shape Preview

Status: implemented as preview-only foundation.

This slice adds an authenticated ACP-style cart and checkout shape preview for
review before open protocol packaging. It does not publish ACP capabilities,
does not claim ACP certification, does not enable public checkout, does not
enable production Commerce V1, does not create checkout or payment paths, does
not enable live payments, does not enable live Plural, does not call providers,
does not expose provider credentials or provider metadata, does not write
production configuration, and does not set allowlists.

## Traceability

| Requirement | Implementation | Validation |
| --- | --- | --- |
| Add ACP-style cart and checkout preview mappings | `readAcpCheckoutShapePreview` reads tenant-scoped merchant, cart, payment intent, consent, passport, and active policy evidence. | `commerce-merchants.test.ts` preview success case. |
| Sandbox/non-live only | Live merchants return `409 acp_checkout_shape_preview_live_merchant_blocked`. | Live merchant route test. |
| Do not create checkout/payment | Endpoint is `GET`, does not call runtime creation handlers, and all creation controls are `false`. | Route assertions and guardrail scans. |
| Do not call providers or expose provider data | Service imports no provider adapter and exposes only safe summaries; checkout URL, provider IDs, raw status, and metadata are never emitted. | Route test asserts private provider fields do not appear. |
| Refuse missing consent/passport/policy evidence | Missing granted checkout consent, unrevoked checkout passport, or active policy produces blocked preview fields. | Missing-evidence route test. |
| Unsupported ACP fields are explicit blockers | Public checkout URL, provider references, live execution, fulfillment, and refund/return execution are listed as unsupported fields. | Route assertions and OpenAPI contract. |

## Endpoint

`GET /v1/commerce/merchants/{merchant_id}/acp-checkout-shape-preview`

Allowed callers:

- operator
- owning merchant

Denied callers:

- CommerceAgent
- service caller
- merchant for a different merchant ID

Live merchants return `409 acp_checkout_shape_preview_live_merchant_blocked`.
Sandbox merchants with missing evidence receive a blocked preview with explicit
capability blockers and remediation.

## Preview Rules

The preview may include:

- cart object mapping metadata
- checkout object mapping metadata
- safe amount/currency/status summaries from sandbox cart and payment-intent
  foundations
- consent, passport, and policy evidence counts
- unsupported ACP fields with blockers
- non-enabling controls and remediation

The preview must not include:

- tenant IDs
- exact merchant IDs
- cart IDs
- payment intent IDs
- passport JTIs
- consent record IDs
- provider payment IDs
- provider order IDs
- checkout URLs
- provider raw status
- provider metadata
- provider credentials
- raw payloads
- secrets, tokens, JWTs, private keys, DB URLs, or Redis URLs
- public discovery allowlist values
- production config assignments
- ACP certification claims

## Stop Conditions

Stop and require separate approval if any change attempts to:

- publish ACP capabilities
- claim ACP certification or conformance
- create a public checkout route
- set `COMMERCE_PUBLIC_DISCOVERY_ENABLED`
- set `COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST`
- enable production Commerce V1
- enable checkout or payment creation in production
- enable live payments or live Plural
- call Plural, Stripe, Pine, payment providers, or merchant private APIs
- store or print real provider credentials
- expose private merchant data, exact internal IDs, raw payloads, provider
  metadata, allowlists, production config, or secrets

## Rollback

Rollback is code-only:

1. Remove the route import and endpoint from `apps/auth-service/src/routes/commerce.ts`.
2. Remove `apps/auth-service/src/lib/commerce/acp-checkout-preview.ts`.
3. Remove the C6L OpenAPI path and `AcpCheckoutShapePreview` component.
4. Remove C6L tests and guide references.

No migration, secret, production configuration, provider account, public
discovery setting, allowlist, checkout/payment route enablement, or cloud
resource is created by this slice.
