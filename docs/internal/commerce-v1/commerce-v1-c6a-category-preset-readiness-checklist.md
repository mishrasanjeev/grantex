# Commerce V1 C6A Category Preset Readiness Checklist

Status: implementation slice
Date: 2026-05-31
Scope: Grantex seller sandbox onboarding category readiness scoring
Production changes made by this slice: none
Public discovery changed by this slice: no
Checkout or payment creation changed by this slice: no
Live payment path changed by this slice: no
Live Plural path changed by this slice: no
Provider credential collection changed by this slice: no
Named merchant approved by this slice: no
Secrets inspected or changed: no

## Boundary

C6A extends the C5Z sandbox onboarding response with computed category
readiness. It does not add persistence, production flags, allowlists, provider
credentials, checkout/payment state, live-provider paths, real merchant
approval, or AgenticOrg public discovery.

No migration is required. The score is derived from existing tenant-owned
merchant and catalog tables:

- `commerce_merchants`
- `commerce_products`
- `commerce_product_variants`

## Electronics/Appliances Checklist

Required items:

- recognized `electronics_appliances` preset;
- public display name;
- country and currency;
- public-safe discovery description draft;
- repo-safe/test-safe support email or support URL.

Recommended scoring items:

- at least one active sandbox product and purchasable variant;
- warranty summary on active variants;
- return-policy summary on active variants;
- GST, tax-rate, or HSN metadata for India sandbox variants;
- known availability bucket and 24-hour inventory freshness.

Blocked items:

- private artifacts in public/runtime fields;
- production public discovery or allowlist config values;
- live provider path or provider account references;
- checkout/payment enablement.

## Readiness Semantics

`sandbox_ready` and `submitted_for_review` require baseline readiness and all
required category items to pass. Recommended product/catalog items affect the
score and remediation copy but do not force catalog connector implementation in
this slice.

Passing C6A readiness means only that the sandbox profile can be reviewed. It is
not merchant approval, production readiness, public discovery enablement,
checkout/payment readiness, live payment readiness, live Plural readiness, or
provider readiness evidence.
