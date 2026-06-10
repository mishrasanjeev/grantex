# Commerce V1 C6K UCP-Style Capability Profile Preview

Status: implemented as preview-only foundation.

This slice adds an authenticated Grantex-owned UCP-style capability profile
preview for review before open protocol packaging. It does not publish UCP
capabilities, does not use `dev.ucp.*` as a published namespace, does not claim
UCP certification, does not enable public discovery, does not enable production
Commerce V1, does not create checkout or payment paths, does not enable live
payments, does not enable live Plural, does not call providers, does not write
production configuration, and does not set allowlists.

## Traceability

| Requirement | Implementation | Validation |
| --- | --- | --- |
| Generate gated UCP-style capability profile preview from canonical Grantex state | `readUcpCapabilityProfilePreview` reads tenant-scoped merchant, category, and catalog readiness evidence. | `commerce-merchants.test.ts` success and missing-catalog cases. |
| Use Grantex-owned namespace only | Every service, capability, and transport ID starts with `dev.grantex.commerce.discovery.preview`. | Route test asserts no `dev.ucp` output. |
| Avoid UCP certification or certified `dev.ucp.*` publication | Response pins `ucp_certification_claim: none`, `external_ucp_namespace_used: false`, and `certified_capabilities_published: false`. | Route and OpenAPI tests. |
| Include services, capabilities, and transports as preview metadata only | Response includes `services`, `capabilities`, `transports`, and non-enabling controls. | Route assertions for native REST and MCP metadata. |
| Include controls and blockers | Response includes false enablement flags, blockers, remediation, and evidence summary. | Live merchant and missing-catalog tests. |
| Ensure no public discovery route is enabled | Endpoint is authenticated under `/v1/commerce`; no `.well-known` route or public env assignment is added. | OpenAPI path and guardrail scans. |

## Endpoint

`GET /v1/commerce/merchants/{merchant_id}/ucp-capability-profile-preview`

Allowed callers:

- operator
- owning merchant

Denied callers:

- CommerceAgent
- service caller
- merchant for a different merchant ID

Live merchants return `409 ucp_capability_profile_preview_live_merchant_blocked`.
Sandbox merchants with incomplete catalog evidence receive a blocked preview
with explicit capability blockers.

## Namespace Rules

Allowed namespace:

- `dev.grantex.commerce.discovery.preview`

Blocked namespace behavior:

- Do not publish `dev.ucp.*`.
- Do not mark any capability as certified UCP.
- Do not expose external UCP conformance, compliance, approval, or certification
  status.

## Preview Output Rules

The preview may include:

- read-only merchant profile capability metadata
- read-only catalog search and item-read capability metadata
- read-only availability capability metadata
- blocked cart, checkout, payment, fulfillment, refund, provider, live, and
  production allowlist capability metadata
- native REST and MCP transport templates marked metadata-only
- non-enabling controls and blockers

The preview must not include:

- tenant IDs
- exact merchant IDs
- product IDs
- variant IDs
- SKU values
- provider credentials
- provider metadata
- raw payloads
- secrets, tokens, JWTs, passports, private keys, DB URLs, or Redis URLs
- public discovery allowlist values
- production config assignments
- UCP certification claims

## Stop Conditions

Stop and require separate approval if any change attempts to:

- set `COMMERCE_PUBLIC_DISCOVERY_ENABLED`
- set `COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST`
- add a public `.well-known` UCP route
- publish `dev.ucp.*`
- claim UCP certification or conformance
- enable production Commerce V1
- enable checkout or payment creation in production
- enable live payments or live Plural
- store or print real provider credentials
- call Plural, Stripe, Pine, payment providers, or merchant private APIs
- expose private merchant data, exact internal IDs, raw payloads, provider
  metadata, allowlists, production config, or secrets

## Rollback

Rollback is code-only:

1. Remove the route import and endpoint from `apps/auth-service/src/routes/commerce.ts`.
2. Remove `apps/auth-service/src/lib/commerce/ucp-capability-preview.ts`.
3. Remove the C6K OpenAPI path and `UcpCapabilityProfilePreview` component.
4. Remove C6K tests and guide references.

No migration, secret, production configuration, provider account, public
discovery setting, allowlist, or cloud resource is created by this slice.
