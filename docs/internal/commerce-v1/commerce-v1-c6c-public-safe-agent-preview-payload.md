# Commerce V1 C6C Public-Safe Agent Preview Payload

## Scope

C6C adds a tenant-scoped, read-only `agent_facing_preview` payload to the seller
sandbox onboarding response. The preview shows the public-safe profile,
category readiness, catalog readiness, and a capped product sample that an AI
buyer agent could later see only after a separate reviewed discovery launch.

This slice does not approve a merchant, publish discovery, enable production
Commerce V1, create checkout/payment paths, enable live payments, enable live
Plural, capture provider credentials, or add external catalog connectors.

## Data Source

The preview is computed at request time from existing tenant-scoped Grantex
data:

- `commerce_merchants` sandbox onboarding profile fields;
- C6A computed category readiness;
- C6B computed catalog readiness;
- existing `commerce_products` and `commerce_product_variants` rows for capped
  public-safe sample products.

No migration is required because C6C stores no new state. The payload is derived
from existing tenant-owned sandbox rows and fail-closed readiness logic.

## Included Public-Safe Fields

The preview may include:

- merchant sandbox reference;
- display name;
- `electronics_appliances` category preset;
- country and currency;
- public discovery description draft after public-safety validation;
- repo-safe/test-safe support email or support URL;
- category readiness summary;
- catalog readiness summary;
- up to three public-safe sample products, each with up to two variants;
- allowed preview capability labels:
  - `read_only_profile_preview`
  - `read_only_catalog_preview`
  - `readiness_review_preview`
- blocked capability labels:
  - `public_discovery`
  - `checkout_payment_creation`
  - `live_payment`
  - `live_plural`
  - `provider_credentials`
  - `order_fulfillment`
  - `refunds_returns_execution`
  - `production_allowlist`
- generated timestamp.

## Excluded Fields

The preview must not expose private legal names, private contracts, private
contacts, signed approvals, pricing terms, customer data, provider credentials,
tokens, JWTs, raw payloads, DB/Redis URLs, private keys, production allowlist
values, production config values, live provider claims, checkout/payment claims,
or live Plural claims.

## Safety Posture

Every preview response explicitly reports:

- `sandbox_only: true`
- `live_mode_status: not_live`
- `production_approval_status: not_approved`
- `rollout_status: rollout_not_requested`
- `public_discovery_enabled: false`
- `checkout_payment_enabled: false`
- `live_provider_enabled: false`
- `live_plural_enabled: false`

Preview generation fails closed to `preview_status: blocked` when required
public-safe fields are missing or unsafe, when the merchant is not sandbox, when
readiness is not passing, or when catalog rows exist but no public-safe sample
can be built.

## Route And UI

The existing sandbox onboarding GET, PUT, and transition responses include the
computed preview. The portal onboarding page renders a read-only
Agent-facing preview section with sandbox/not-live/not-approved badges,
allowed/blocked capability labels, product samples, and a copyable JSON view.

All state-changing sandbox onboarding routes keep the existing
operator-or-owning-merchant boundary and append audit evidence. CommerceAgent
callers are not given merchant administration access.

## Validation Focus

C6C validation should cover:

- preview includes only safe merchant/category/readiness/catalog fields;
- preview includes allowed and blocked capability labels;
- preview excludes private/provider/payment/live/config fields;
- unsafe public description blocks or sanitizes preview;
- product samples are capped and public-safe;
- live merchants cannot use sandbox preview;
- cross-tenant preview access fails through the existing tenant-scoped lookup;
- no public discovery, checkout/payment, live provider, live payment, or live
  Plural enablement is introduced.
