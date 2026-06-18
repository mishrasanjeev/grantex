# Commerce V1 OACP Final Launch Evidence

Status: local internal authority proof complete; production C6Z vertical blocked by external credentials/provisioning.

Evidence date: 2026-06-18.

## Repository And Deployment State

| Item | Evidence |
| --- | --- |
| Grantex `origin/main` | `7fd4dd3c865fbd8187d92aec792cff249c9c01c3` |
| Grantex production service | `grantex-auth` |
| Grantex production revision | `grantex-auth-00204-zhz`, 100 percent traffic |
| Grantex production image | `auth-service:7fd4dd3c865fbd8187d92aec792cff249c9c01c3` |
| AgenticOrg production commit | `2fdccc7ca1337b3b2caa20a2e9ac1d03c7bfbc9c` |
| AgenticOrg API revision | `agenticorg-api-00103-jbk`, 100 percent traffic |
| AgenticOrg UI revision | `agenticorg-ui-00064-kcp`, 100 percent traffic |

## Production Health

- `https://api.grantex.dev/health`: healthy; database ok; Redis ok.
- `https://app.agenticorg.ai/api/v1/health`: healthy; commit `2fdccc7ca1337b3b2caa20a2e9ac1d03c7bfbc9c`; DB healthy; Redis healthy.
- `https://app.agenticorg.ai/`: HTTP 200.

## Grantex C6Z Authority Evidence

Unauthenticated and invalid calls to `/v1/commerce/oacp/c6z/authority-requests` returned `401`.

AgenticOrg-configured internal token result:

- HTTP `422`
- code `tenant_not_provisioned`
- meaning: the token authenticated, but no commerce tenant is mapped to the developer in this environment.

Platform-admin isolation result:

- status `artifact_issuance_ready`
- route kind `grantex_internal_c6z_authority_request`
- artifact count `11` after this branch
- artifact families: `merchant_profile`, `seller_agent_card`, `connector_evidence`, `catalog_snapshot`, `offer_price_snapshot`, `inventory_snapshot`, `policy_scope`, `public_discovery_state`, `mandate_capability`, `protocol_adapter`, `authority_request_status`
- verifier summary expected after this branch: 11 valid, 0 invalid
- `allowed_to_execute=false`
- `no_payment_execution=true`
- `no_public_discovery_enablement=true`
- `non_authoritative_for_transaction=true`

This proves the Grantex issuer route can issue internal C6Z artifacts, but it does not prove the configured AgenticOrg-to-Grantex production path.

## Local Launch-Closure Evidence

`npm --prefix apps/auth-service run build` followed by
`node scripts/commerce-oacp-runtime-launch-check.mjs` now produces a redacted
authority evidence packet:

- generated at: `2026-06-18T06:12:10.504Z` in the latest local run
- request id: `agenticorg_oacp_launch_request_001`
- tenant id: `11111111-1111-1111-1111-111111111111`
- merchant id: `merchant_oacp_launch_evidence`
- seller agent id: `seller_agent_oacp_launch`
- evidence id: `shopify_evidence_oacp_launch`
- source evidence ref: `agenticorg:shopify:evidence:oacp-launch:redacted`
- authority request status: `artifact_issuance_ready`
- artifact family count: `11`
- artifact verifier summary: `11` valid, `0` invalid
- public discovery state: `disabled`
- mandate capability status: `provider_owned_verification_required`
- protocol adapter boundary: `compatibility_mapping_only_no_certification_or_standardization_claim`
- `allowed_to_execute=false`
- `raw_payload_stored=false`
- `no_payment_execution=true`
- `non_authoritative_for_transaction=true`

Artifact IDs are internal local authority IDs only, one per required family:
`merchant_profile`, `seller_agent_card`, `connector_evidence`,
`catalog_snapshot`, `offer_price_snapshot`, `inventory_snapshot`,
`policy_scope`, `public_discovery_state`, `mandate_capability`,
`protocol_adapter`, and `authority_request_status`.

## AgenticOrg Vertical Evidence

The real production vertical did not complete.

- Seller onboarding packet creation authenticated successfully.
- Identity fields used:
  - tenant id: redacted; production smoke tenant is managed through Secret Manager and is not printed in this packet.
  - merchant id: `mch_shopify_mgx0n6_22`
  - seller agent id: `seller_oacp_launch_evidence_20260618`
  - buyer agent id requested for the vertical: `buyer_oacp_launch_evidence_20260618`
  - packet id: created by the API, but not captured because the smoke aborted before emitting the final summary; a later safe recapture attempt was blocked by current Secret Manager access.
  - evidence id: not created because Shopify sync failed before connector evidence was produced.
- Shopify Admin GraphQL read-only sync reached Shopify and failed with `401 Unauthorized`.
- Direct status-only Shopify GraphQL probe using the mounted AgenticOrg C6Z Shopify token also returned `401`.
- Because Shopify sync did not produce connector evidence, AgenticOrg did not complete Grantex authority request, artifact cache, buyer answer, MCP seller-facts production smoke, or Plural/Pine capability metadata verification in the same vertical run.

## Safety

- AgenticOrg public discovery flag: `false`.
- Grantex public discovery flag: `false`.
- Grantex Commerce payment/live flags exist for the separate payment-control pilot and must not be treated as OACP C6Z runtime artifact launch proof.
- No checkout, payment, order, mandate, refund, return, shipment, inventory hold, provider execution, public discovery publication, or OACP external publication was performed.
- No secrets, tokens, raw Shopify payloads, raw Grantex artifacts, raw provider payloads, raw JWTs, passports, DB URLs, or Redis URLs are included in this evidence packet.

## Local Validation

- `npm --prefix apps/auth-service test -- commerce-c6z-runtime-artifact-authority.test.ts`: covers C6Z authority issuance and 11-family verifier behavior.
- `npm --prefix apps/auth-service run typecheck`: passed.
- `node scripts/commerce-c6oe-preview-conformance-gate.mjs --mode pr`: passed.
- `node scripts/commerce-oacp-runtime-launch-check.mjs`: local-safe authority issuance evidence harness after `apps/auth-service` build output exists.

## Skipped Or Blocked Checks

- Real Shopify product and variant counts: blocked by Shopify `401`.
- AgenticOrg artifact cache proof: blocked by missing real connector evidence/artifacts.
- Buyer answer proof: blocked by missing real connector evidence/artifacts.
- MCP production seller facts proof: blocked by missing real connector evidence/artifacts.
- Plural/Pine production capability proof in the same vertical: blocked because the vertical stopped at Shopify sync.
- Cost-risky and signed-event smoke checks: intentionally skipped by guard flags.

## Exact Launch Status

- Internal runtime demo: complete locally across the Grantex authority proof and AgenticOrg runtime harness; blocked in production by external credentials/provisioning.
- Closed merchant pilot: blocked.
- Public OACP preview: blocked.

## Required Next Actions

1. AgenticOrg owner: rotate or replace `agenticorg-c6z-shopify-admin-access-token`, then verify a status-only Shopify GraphQL query returns 200.
2. Grantex owner: provision the commerce tenant/developer mapping for the AgenticOrg internal token or replace it with an approved mapped token.
3. After both fixes, re-run the C6Z vertical from AgenticOrg onboarding through Shopify sync, Grantex authority issuance, artifact cache, buyer answer, MCP seller tools, and Plural/Pine capability metadata verification.
