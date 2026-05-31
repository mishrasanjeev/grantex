# Commerce V1 C6B Catalog Readiness Preview

Date: 2026-05-31

## Scope

C6B extends seller self-serve sandbox onboarding with a computed catalog
readiness preview for `electronics_appliances`. The preview is sandbox-only and
tenant-scoped. It does not approve a merchant, enable production Commerce V1,
enable public discovery, create checkout/payment paths, collect provider
credentials, enable live payments, or enable live Plural.

## Data Source

No migration is required. Readiness is computed from existing
`commerce_products` and `commerce_product_variants` rows owned by the same
tenant and merchant. Existing catalog APIs already support manual product entry
and the CSV/bulk dry-run path; C6B only surfaces readiness from that data.

The slice intentionally does not add external connector credentials, async
import jobs, Shopify/WooCommerce/Magento connectors, orders, fulfillment,
refunds, settlement, checkout enablement, payment enablement, public discovery,
or AgenticOrg channel launch.

## Catalog Checklist

Required items:

- catalog products present;
- catalog variants present;
- public-safe product title coverage;
- public-safe product description coverage;
- product category mapping to `electronics_appliances`;
- variant SKU coverage;
- variant price and currency coverage.

Recommended items:

- product image/media coverage;
- availability freshness without exposing exact inventory quantity;
- warranty summary coverage;
- return-policy summary coverage;
- tax/GST metadata coverage when applicable.

Blocked item:

- unsafe catalog text in public/runtime catalog fields, including private
  artifacts, secrets, provider/payment claims, production/live claims, approval
  claims, readiness claims, or certification claims.

## Scoring And State Integration

The sandbox onboarding response now includes `readiness.catalog_readiness` with:

- `status`;
- `score_percent`;
- `required_passed`;
- `recommended_completion_percent`;
- `blocker_count`;
- `product_count`;
- `variant_count`;
- checklist `items` with key, label, description, severity, status,
  count/total where applicable, and remediation;
- intake capability flags for manual entry, CSV dry-run, bulk API dry-run,
  async import job support, and external connector support.

`sandbox_ready` and `submitted_for_review` require baseline readiness,
category readiness, and required catalog readiness to pass. Recommended catalog
gaps lower the score and show remediation but do not block a save. Passing
catalog readiness means only that the sandbox catalog has the minimum public
fields needed for read-only discovery review. It does not mean merchant
approval, production readiness, public discovery approval, checkout/payment
readiness, live payment readiness, or live Plural readiness.

## Security Controls

- Tenant and merchant boundaries use the existing commerce route helpers and
  merchant-scoped SQL filters.
- CommerceAgent callers are not granted merchant admin access.
- The preview does not store or return private contracts, private contacts,
  customer data, secrets, provider credentials, tokens, JWTs, raw payloads,
  DB/Redis URLs, private keys, production config values, or allowlist values.
- Live merchants remain blocked from sandbox onboarding.
- State-changing onboarding actions continue to write audit evidence through
  the C5Z audit path.
