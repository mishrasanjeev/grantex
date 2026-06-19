# Commerce V1 OACP Runtime Launch Runbook

Status: internal runbook for the C6Z OACP runtime artifact vertical.

Last updated: 2026-06-19.

## Safe Preconditions

- Use production AgenticOrg and production Grantex only with approved smoke credentials.
- Do not print tokens, raw Shopify payloads, raw Grantex artifacts, raw provider payloads, JWTs, passports, DB URLs, Redis URLs, or Secret Manager values.
- Keep public discovery disabled.
- Do not create checkout, payment, order, mandate, refund, return, shipment, inventory hold, live-provider execution, production allowlist entries, or public OACP publication.

## Required Production Checks

1. Confirm AgenticOrg health reports the deployed commit and healthy DB/Redis.
2. Confirm Grantex health reports healthy DB/Redis and the deployed commit/revision.
3. Confirm Grantex C6Z route refuses unauthenticated or invalid calls with `401` or `403`.
4. Create or reuse an AgenticOrg Seller Commerce Agent onboarding packet for the approved Shopify pilot merchant.
5. Run AgenticOrg Shopify Admin GraphQL read-only sync.
6. Send AgenticOrg authority request to Grantex.
7. Confirm Grantex issues 11 internal artifact families: `merchant_profile`, `seller_agent_card`, `connector_evidence`, `catalog_snapshot`, `offer_price_snapshot`, `inventory_snapshot`, `policy_scope`, `public_discovery_state`, `mandate_capability`, `protocol_adapter`, and `authority_request_status`.
8. Cache returned Grantex artifacts in AgenticOrg.
9. Ask a buyer product question from cache and record source/freshness labels.
10. Smoke the web, MCP, OpenAPI/function, and A2A bridge contracts against the cached data.
11. Confirm WhatsApp and Telegram bridge adapters either answer through the same contract or return `blocked_missing_credentials` without outbound sends.
12. Run Plural/Pine capability metadata verification only; do not execute mandates or payments.
13. Confirm AgenticOrg can generate Schema.org/UCP-style/ACP-style/AP2-style/A2A/MCP/OpenAPI adapter payloads from cached artifacts.
14. Attempt purchase preparation and confirm it returns a prepared provider-owned handoff or an exact blocker without faking payment success.

## Current Runtime Boundary

The 2026-06-18 production attempt was blocked because Shopify returned
`401 Unauthorized` for the then-mounted AgenticOrg C6Z Shopify token and
Grantex returned `422 tenant_not_provisioned` for the AgenticOrg-configured
internal token. AgenticOrg now has a merchant-scoped encrypted Shopify
credential path, artifact-derived adapter payloads, and purchase-preparation
safe blockers. A real production merchant vertical still requires valid
merchant Shopify access and Grantex tenant-token allowlisting.

Do not proceed to closed merchant pilot or public preview until the full
vertical is re-run with those external dependencies resolved.

## Launch Status Labels

- Internal runtime demo: implemented locally with deterministic Shopify fixture, Grantex-compatible artifact fixtures, adapter generation, buyer Q&A, Plural/Pine capability verification, and purchase-preparation blocker.
- Closed merchant pilot: blocked until Shopify sync and AgenticOrg-to-Grantex authority issuance pass with the configured production credentials.
- Public OACP preview: blocked. Public discovery remains disabled and OACP is not externally published.
