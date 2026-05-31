# Commerce V1 C5I Synthetic Merchant Dataset

Status: implementation-only documentation and validation for internal smoke/dev flows. This does not deploy, create cloud resources, merge, change production config, enable production Commerce V1, enable checkout/payment creation, enable live payments, enable live Plural, touch secrets, or approve any real merchant.

## Dataset

The synthetic Grantex dataset lives at `docs/examples/commerce-c5i-synthetic-internal-merchant.dataset.json`.

Use it only as a clearly fake, internal input for local smoke/dev validation where the flow needs stable merchant, agent, catalog, and provider-shape identifiers without using a real merchant. All IDs and display names contain synthetic/internal/smoke markers. Currency `ZZZ` and country `ZZ` are intentionally non-real production values.

Pinned synthetic IDs:

- Tenant: `cten_synth_internal_smoke_0001`
- Merchant: `mch_synth_internal_smoke_0001`
- Agent: `cag_synth_internal_smoke_sales_0001`
- Provider: `mock`
- Dataset version: `c5i-synth-v1`

## Explicit Non-Approval

This dataset does not approve or authorize:

- Production discovery.
- `COMMERCE_PUBLIC_DISCOVERY_ENABLED`.
- `COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST`.
- Any production config value.
- Checkout creation.
- Payment intent creation.
- Live payments.
- Live Plural.
- AgenticOrg commerce public discovery.
- A real production merchant.

The synthetic merchant ID must not be copied into a production allowlist or used as evidence that a merchant is ready for public discovery. Certification and readiness claims remain `none`.

## Smoke Scope

Allowed internal smoke/dev cases are read-only and synthetic:

- Merchant profile read.
- Catalog search read.
- Catalog item read.
- Inventory read.

Blocked cases remain blocked:

- Checkout creation.
- Payment creation.
- Provider credential handling.
- Live payment rails.
- Public discovery enablement.

## Validation

Run the focused validator after changing the dataset or this guide:

```powershell
node scripts/commerce-c5i-synthetic-dataset-validate.mjs
```

The validator rejects production-looking merchant IDs, realistic merchant names, secret-like values, provider credential material, live-payment claims, and certification/readiness overclaims.

## Gate Posture

Grantex read-only public discovery remains fail-closed for production. This dataset does not change `COMMERCE_PUBLIC_DISCOVERY_ENABLED`, does not set `COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST`, and does not alter checkout, payment, live payment, or live Plural gates.
