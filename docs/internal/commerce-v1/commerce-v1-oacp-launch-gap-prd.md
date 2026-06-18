# Commerce V1 OACP Launch Gap PRD

Status: current closure record, internal only.

Last updated: 2026-06-18.

## Canonical Architecture

- AgenticOrg is the buyer and seller AI-agent runtime.
- Grantex is the trust, protocol, policy, and canonical OACP artifact authority.
- Merchant systems such as Shopify remain operational systems of record.
- Provider and fintech rails such as Plural/Pine own mandate and payment execution.
- Grantex is not a toll booth for every non-binding buyer/seller interaction.

## Current Launch Result

The production OACP C6Z runtime vertical is blocked, not launched.

Blocking evidence captured on 2026-06-18:

- AgenticOrg production health is healthy at commit `2fdccc7ca1337b3b2caa20a2e9ac1d03c7bfbc9c`.
- Grantex production health is healthy at commit `7fd4dd3c865fbd8187d92aec792cff249c9c01c3`.
- AgenticOrg authenticated Shopify Admin GraphQL read-only sync reached Shopify but Shopify returned `401 Unauthorized`.
- A direct status-only Shopify GraphQL probe using the mounted AgenticOrg C6Z Shopify token also returned `401`.
- Grantex C6Z authority called with the AgenticOrg-configured internal token returned `422 tenant_not_provisioned`.
- Grantex C6Z authority called with a platform-admin operator token issued 8 internal artifacts, all verifier-valid, with `allowed_to_execute=false`.

## Gaps To Close

1. Rotate or replace the AgenticOrg C6Z Shopify Admin token and verify read-only GraphQL access to `mgx0n6-22.myshopify.com`.
2. Provision the Grantex commerce tenant/developer mapping for the AgenticOrg internal token, or replace the token with an approved operator/developer credential that is already mapped.
3. Re-run the AgenticOrg production C6Z vertical from onboarding packet to Shopify sync, Grantex authority request, artifact cache, buyer answer, MCP seller facts, and Plural/Pine capability metadata verification.
4. Keep `AGENTICORG_COMMERCE_PUBLIC_DISCOVERY_ENABLED=false` and `COMMERCE_PUBLIC_DISCOVERY_ENABLED=false` until a separate public discovery rollout is approved.

## Non-Goals

This PRD does not approve checkout, payment, order, mandate, refund, return, shipment, inventory hold, live-provider execution, public discovery publication, production allowlist changes, OACP publication, certification, standardization, or conformance claims.
