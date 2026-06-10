# Commerce V1 C6N Merchant Existing-System Connector Foundation

Status: implemented as metadata-only foundation.

This slice adds an authenticated connector registry for existing merchant
systems. It does not store real credentials, does not call merchant systems,
does not call payment providers, does not enable AgenticOrg direct execution,
does not enable public discovery, does not enable production Commerce V1, does
not create checkout or payment paths, does not enable fulfillment or refund
execution, does not enable live payments, does not enable live Plural, does not
write production configuration, and does not set allowlists.

## Traceability

| Requirement | Implementation | Validation |
| --- | --- | --- |
| Define registry for existing systems | `commerce_connectors` supports manual, CSV, custom API, Shopify, WooCommerce, Magento, ERP, billing, OMS, WMS, logistics, CRM/support, and payment provider metadata. | C6N schema test. |
| Safe connector metadata only | Registry stores type, key, display name, source domains, priority, sync status, health state, timestamps, stale threshold, webhook source reference, and blockers. | Route tests and migration checks. |
| No credentials or direct execution | DB check keeps `stores_credentials`, `provider_call_enabled`, and `agenticorg_direct_execution_enabled` false; route rejects credential-like fields and values. | Private-field rejection test and guardrail scans. |
| Source precedence model | List responses derive precedence for catalog, price, inventory, order, fulfillment, refund, settlement, and support. | Source precedence route test. |
| Stale/conflict blocker model | Responses compute stale, conflict, sync failure, missing source, unsupported runtime, and execution-domain blockers. | Stale/conflict route tests. |
| Tenant boundary and AgenticOrg posture | Operator or owning merchant required; CommerceAgent callers are denied. Docs state AgenticOrg never calls merchant systems directly. | Caller-boundary route test and docs. |

## Endpoints

`POST /v1/commerce/connectors`

Creates one connector registry row for a tenant-scoped merchant.

`GET /v1/commerce/connectors`

Lists connector metadata and returns source precedence for:

- catalog
- price
- inventory
- order
- fulfillment
- refund
- settlement
- support

`PATCH /v1/commerce/connectors/{connector_key}`

Updates safe metadata, source domains, priority, sync status, health state, last
sync evidence, stale threshold, webhook source reference, and conflict blockers.

Allowed callers:

- operator
- owning merchant

Denied callers:

- CommerceAgent
- service caller
- merchant for a different merchant ID

## Safe Runtime Scope

Manual and CSV connectors can point to existing Grantex catalog maintenance
paths. Custom API is declaration-only in this slice. Shopify, WooCommerce,
Magento, ERP, billing, OMS, WMS, logistics, CRM/support, and payment provider
connectors are metadata-only until a separate approved connector implementation
exists.

The registry must not include:

- API keys
- access tokens
- refresh tokens
- passwords
- client secrets
- private keys
- provider credentials
- raw payloads
- raw merchant system responses
- private URLs
- production config
- allowlists
- customer data

## Stop Conditions

Stop and require separate approval if any change attempts to:

- store or print real connector credentials
- call Shopify, WooCommerce, Magento, custom APIs, ERP, billing, OMS, WMS,
  logistics, CRM/support, payment providers, Plural, Stripe, Pine, or merchant
  private APIs
- let AgenticOrg call merchant private systems directly
- enable checkout/payment creation, fulfillment execution, refund execution,
  live payments, live Plural, public discovery, production Commerce V1, or
  protocol certification
- expose private merchant data, raw payloads, provider metadata, production
  config, allowlists, or secrets

## Rollback

Rollback is code-only plus the C6N migration:

1. Remove `apps/auth-service/src/routes/commerce-connectors.ts`.
2. Remove the connector route registration from `apps/auth-service/src/routes/commerce.ts`.
3. Remove `apps/auth-service/src/db/migrations/052_commerce_connectors.sql` before migration rollout, or write a reviewed down-migration if it has already run.
4. Remove C6N OpenAPI schemas, paths, tests, and guide references.

No secret, provider account, external connector job, public discovery setting,
allowlist, checkout/payment route enablement, live payment path, live Plural
path, AgenticOrg execution path, or cloud resource is created by this slice.
