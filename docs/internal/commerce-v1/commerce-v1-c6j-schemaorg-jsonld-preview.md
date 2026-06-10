# Commerce V1 C6J Schema.org JSON-LD Preview

Status: implemented as preview-only foundation.

This slice adds a Grantex-owned schema.org JSON-LD preview adapter for review
before open protocol packaging. It does not publish schema.org data, enable
public discovery, enable production Commerce V1, create checkout or payment
paths, enable live payments, enable live Plural, call providers, write
production configuration, set allowlists, or claim schema.org certification.

## Traceability

| Requirement | Implementation | Validation |
| --- | --- | --- |
| Generate public-safe schema.org JSON-LD from canonical state | `readSchemaOrgJsonLdPreview` reads tenant-scoped merchant and catalog variant state and builds a `https://schema.org` graph. | `commerce-merchants.test.ts` success and missing-catalog cases. |
| Include only safe Product, Offer, MerchantReturnPolicy, and OfferShippingDetails fields where evidence exists | Product, Offer, and MerchantReturnPolicy fields are emitted only after safe text, URL, currency, amount, country, and availability checks. Shipping details remain omitted until evidence exists. | Unsafe-field redaction test and omitted type assertions. |
| Avoid private merchant data, internal IDs, secrets, provider metadata, raw payloads, allowlists, and production config | Public response does not contain tenant, merchant, product, variant, SKU, provider refs, raw payloads, config keys, or credential fields. | Redaction assertions and guardrail scans. |
| Keep output preview-only | Endpoint returns explicit false enablement flags, `publication_status: not_published`, and `certification_claims: []`. | Route tests and OpenAPI drift test. |
| API and docs | `GET /v1/commerce/merchants/{merchant_id}/schemaorg-jsonld-preview` plus OpenAPI and guide updates. | `commerce-openapi.test.ts` and docs review. |

## Endpoint

`GET /v1/commerce/merchants/{merchant_id}/schemaorg-jsonld-preview`

Allowed callers:

- operator
- owning merchant

Denied callers:

- CommerceAgent
- service caller
- merchant for a different merchant ID

Live merchants return `409 schemaorg_jsonld_preview_live_merchant_blocked`.
Missing safe catalog evidence returns a blocked preview with empty `@graph`.

## Public Output Rules

The JSON-LD graph may include:

- `Product.name`
- `Product.description`
- `Product.image`
- `Product.category`
- `Product.brand.name`
- `Offer.price`
- `Offer.priceCurrency`
- `Offer.availability`
- `Offer.hasMerchantReturnPolicy.description`
- `Offer.hasMerchantReturnPolicy.applicableCountry`

The preview does not include:

- tenant IDs
- merchant IDs
- product IDs
- variant IDs
- SKU values
- provider account references
- provider metadata
- raw payloads
- secrets, tokens, JWTs, passports, private keys, DB URLs, or Redis URLs
- production allowlist values
- production config assignments
- checkout, payment, launch, approval, or certification claims

`OfferShippingDetails` is intentionally omitted until public-safe shipping
evidence exists in canonical state.

## Stop Conditions

Stop and require separate approval if any change attempts to:

- set `COMMERCE_PUBLIC_DISCOVERY_ENABLED`
- set `COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST`
- enable production Commerce V1
- enable checkout or payment creation in production
- enable live payments or live Plural
- store or print real provider credentials
- call Plural, Stripe, Pine, payment providers, or merchant private APIs
- expose private merchant data, exact internal IDs, raw payloads, provider
  metadata, allowlists, production config, or secrets
- claim UCP, ACP, AP2, schema.org, MPP, A2A, provider, or live-provider
  certification

## Rollback

Rollback is code-only:

1. Remove the route import and endpoint from `apps/auth-service/src/routes/commerce.ts`.
2. Remove `apps/auth-service/src/lib/commerce/schemaorg-preview.ts`.
3. Remove the C6J OpenAPI path and `SchemaOrgJsonLdPreview` component.
4. Remove C6J tests and guide references.

No migration, secret, production configuration, provider account, public
discovery setting, allowlist, or cloud resource is created by this slice.
