# Commerce V1 C6W4 - OACP Protocol Adapter Preview Foundation

Status: implementation foundation, internal-only, non-enabling.

## Scope

C6W4 adds internal protocol adapter preview helpers over the C6W3 OACP artifact family.

This slice adds:

- Internal adapter descriptors for schema.org JSON-LD style discovery, UCP-style capability profiles, ACP-style commerce capability shapes, AP2-style evidence and intent summaries, A2A-style agent card/task capabilities, MCP-style tool/resource capabilities, and OpenAPI/function buyer-safe bridge schemas.
- Pure helper mapping from signed OACP artifact fixtures to bounded preview payloads.
- Focused tests for source artifact binding, TTL bounding, source authority, unsupported capabilities, and fail-closed private/missing/stale artifact handling.

No endpoint, migration, workflow, provider adapter, public discovery, checkout/payment, live provider, merchant private API, allowlist, cloud, deploy, or external protocol publication behavior is added.

## Adapter Surfaces

| Surface | Preview purpose | Required source artifact families |
| --- | --- | --- |
| schema.org JSON-LD style discovery | Internal read-only discovery shape for public-safe catalog hints. | merchant_capability, seller_agent_capability, catalog_snapshot, policy, protocol_adapter |
| UCP-style capability profile | Internal capability profile preview for non-binding agent routing. | merchant_capability, seller_agent_capability, policy, protocol_adapter |
| ACP-style commerce capability | Internal commerce capability shape with checkout/payment blocked. | merchant_capability, seller_agent_capability, policy, protocol_adapter |
| AP2-style evidence/intent summary | Internal evidence and intent summary without mandate or payment execution. | merchant_capability, seller_agent_capability, policy, commitment_evidence, protocol_adapter |
| A2A-style agent card/task capability | Internal buyer/seller agent card and task capability preview. | merchant_capability, seller_agent_capability, policy, protocol_adapter |
| MCP-style tool/resource capability | Internal read-only tool/resource capability shape. | merchant_capability, seller_agent_capability, policy, protocol_adapter |
| OpenAPI buyer-safe bridge schema | Internal function/API bridge shape for buyer-safe questions. | merchant_capability, seller_agent_capability, policy, protocol_adapter |

## Preview Safety Contract

Every preview includes:

- Source artifact IDs and families.
- Source authority set to Grantex canonical OACP artifact authority.
- generated_at.
- expires_at and max_ttl_seconds bounded by the shortest source artifact TTL.
- Freshness tier.
- Unsupported and blocked capabilities.
- non_authoritative_for_transaction: true.
- no_checkout_payment_enablement: true.
- no_live_provider_enablement: true.
- no_public_discovery_enablement: true.

Adapter previews are not transaction authority. They can display, route, or summarize public-safe facts already present in signed OACP artifacts, but they cannot approve checkout, payment, mandate execution, fulfillment, refund, public discovery, merchant approval, or provider use.

## Source Fact Rules

Adapter previews must remain derived from signed canonical artifacts:

- Merchant facts come from merchant_capability.
- Seller-agent task facts come from seller_agent_capability.
- Catalog hints come from catalog_snapshot.
- Policy summaries come from policy.
- Price and inventory snippets are non-final only and require valid price/inventory artifacts.
- AP2-style evidence summaries can reference commitment_evidence but cannot imply payment capture, refund execution, settlement, payout, fulfillment start, or merchant approval.
- Protocol adapter previews cannot outlive referenced source artifacts.

The helper refuses missing, expired, stale, invalid, private, raw, credential-bearing, or enabling source artifacts.

## Toll Booth Boundary

Grantex does not become a synchronous toll booth for browse, comparison, recommendation, or other non-binding messages. Grantex issues canonical artifacts and adapter descriptors; AgenticOrg can cache and consume valid previews locally, subject to TTL, revocation, freshness, and scope rules.

## What This Does Not Enable

C6W4 does not enable:

- Public discovery.
- Production Commerce V1.
- Checkout/payment creation.
- Payment capture or debit.
- Live payments.
- Live provider use.
- Live Plural use.
- Provider calls.
- Carrier or shipping provider calls.
- Merchant private API calls.
- Connector credential storage in Grantex.
- Production allowlists.
- Public OACP publication.
- External protocol submission.
- Certification, compliance, conformance, standardization, production readiness, public-launch readiness, merchant approval, checkout approval, payment approval, live provider readiness, or OACP public readiness claims.

## Stop Conditions

Stop later implementation if:

- Adapter previews expose raw credentials, tokens, private provider payloads, raw JWTs, raw connector payloads, or merchant private API values.
- Adapter previews become final transaction authority.
- Adapter previews create checkout/payment, public discovery, live provider, live Plural, or production allowlist enablement.
- Adapter previews publish or submit external protocol artifacts.
- Adapter previews outlive source artifact TTL or ignore revocation/freshness posture.
- Grantex becomes a required hop for every non-binding agent interaction.

## Next Slices

Recommended next slices:

- C6W5: AgenticOrg commitment-boundary resolver over cached signed artifacts and adapter previews.
- C6W6: Offline Commitment Mode evidence and reconciliation contract, docs/tests first.
- C6W7: Provider-owned mandate verification boundary with non-production evidence only.
- C6W8: Merchant connector evidence path from dry-run source snapshots to Grantex canonical facts.
