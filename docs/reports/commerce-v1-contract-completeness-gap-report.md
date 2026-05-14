# Commerce V1 Contract Completeness Gap Report

Status: M12 gap analysis plus M12A/M12B/M12C API completion. This pass did not deploy, merge, create cloud resources, change production config, enable production Commerce V1, enable live payments, enable live Plural, touch production secrets, or commit local-only artifacts.

## Classification Key

- `done`: implemented and covered enough for the internal mock-provider sandbox contract.
- `partial`: a meaningful slice exists, but the V1 contract is not complete.
- `blocked`: implementation depends on missing external contract, infrastructure, or safety design.
- `deferred`: intentionally out of this pass or post-V1 scope.
- `not-started`: no concrete API/UI/runtime path exists yet.

## Brutal Summary

| Area | Status | Assessment |
| --- | --- | --- |
| Core consent, passport, mock payment, checkout, webhook, reconciliation, audit path | `done` | Strong internal sandbox core after the M8 mock-provider `authorized` fix. |
| Merchant/agent mutable control-plane APIs | `done` | M12A implements tenant-bound merchant update plus CommerceAgent list/update with allowlisted fields, no secret disclosure, audit, OpenAPI, and focused tests. |
| Product list/update/bulk/CSV | `partial` | M12B implements product list, product patch, bulk dry-run/upsert, and a local CSV dry-run validator. Full dashboard CSV upload/import remains out of scope. |
| Inbound merchant webhook source APIs | `done` | M12C implements webhook-source management, one-time signing secret creation/rotation, signed complete-state `catalog.product.updated` ingestion, replay checks, idempotency, safe metadata persistence, and audit. |
| Portal merchant control plane | `partial` | Payments, audit, passports, settings, playground, and ops views exist; onboarding/catalog/CSV/webhook-source/policy/publish controls do not. |
| Failed provider webhook replay | `blocked` | Failed metadata exists, but safe raw payload storage, redaction, authorization, and replay audit semantics are absent. |
| Emergency re-enable | `blocked` | Emergency disable exists; safe re-enable contract and UI/API do not. |
| Plural sandbox | `blocked` | The adapter fails closed until the real API and webhook signature contract is confirmed. |
| Live payments and live Plural | `blocked` | Correctly unavailable for V1 staging and this pass. |
| Hosted staging E2E evidence | `blocked` | M11 added dry-run planning only; no hosted services exist yet. |

## Grantex API Contract

| Contract item | Status | Current evidence | Required next slice |
| --- | --- | --- | --- |
| `PATCH /v1/commerce/merchants/{merchant_id}` | `done` | M12A route is implemented with operator/own-merchant auth, tenant filter, mutable allowlist, field validation, and `merchant.updated` audit. | Hosted staging evidence after infrastructure exists. |
| `GET /v1/commerce/agents` | `done` | M12A route lists tenant-bound CommerceAgents for operators, verifies merchant caller scope, supports status/trust_status/limit/cursor filters, and excludes API key hashes/private/provider credentials. | Hosted staging evidence after infrastructure exists. |
| `PATCH /v1/commerce/agents/{agent_id}` | `done` | M12A route is operator-only, rejects agent self-elevation, validates status/trust_status/display_name, filters by tenant, and writes `agent.updated` audit. | Hosted staging evidence after infrastructure exists. |
| `GET /v1/commerce/catalog/products` | `done` | M12B route lists tenant/merchant-scoped product summaries with status/query/category filters, cursor pagination, and archived products excluded by default. | Hosted staging evidence after infrastructure exists. |
| `PATCH /v1/commerce/catalog/products/{product_id}` | `done` | M12B route supports allowlisted product/variant updates, merchant/operator auth, tenant boundary, variant ownership checks, price validation, immutable snapshot posture, and `product.updated` audit. | Hosted staging evidence and portal controls after infrastructure exists. |
| `POST /v1/commerce/catalog/products/bulk` | `done` | M12B route supports dry-run validation by default, transactional upsert on explicit write, per-row results, tenant/merchant boundary, and `catalog.bulk_ingested` audit on writes. | Hosted staging evidence and dashboard import UX remain later. |
| CSV import path | `partial` | M12B adds `scripts/commerce-catalog-csv-validate.mjs` plus a safe sample CSV for local dry-run validation only. No DB/API/network importer or portal upload exists. | M12D dashboard CSV dry-run/upload UX and a later controlled import path. |
| `POST /v1/commerce/webhook-sources` | `done` | M12C route creates tenant/merchant-bound sources for operator or owning merchant callers, generates a one-time signing secret, stores encrypted secret material plus a hash, rejects duplicates, and writes `webhook_source.created` audit. | Hosted staging evidence and portal source manager remain later. |
| `GET /v1/commerce/webhook-sources` | `done` | M12C route lists safe source metadata for operator-selected or owning merchant scope without returning signing secrets, secret hashes, encrypted material, raw payloads, or signatures. | Hosted staging evidence and portal source manager remain later. |
| `PATCH /v1/commerce/webhook-sources/{source_key}` | `done` | M12C route updates only `display_name` and `status`, rejects immutable/sensitive fields, filters by tenant/merchant/source, and writes `webhook_source.updated` audit. | Hosted staging evidence and portal source manager remain later. |
| `POST /v1/commerce/webhook-sources/{source_key}/rotate-secret` | `done` | M12C route replaces encrypted signing material/hash, returns the new one-time signing secret exactly once, and writes `webhook_source.secret_rotated` audit. Old secrets stop validating immediately. | Hosted staging evidence and portal source manager remain later. |
| `POST /v1/webhooks/merchant/{merchant_id}/{source_key}` | `done` | M12C route accepts only signed complete-state `catalog.product.updated` events, requires timestamp/signature headers, enforces a five-minute replay window, rejects disabled sources, accepts duplicate event IDs without double update, stores payload hashes only, upserts product/variants atomically, and writes `merchant_webhook.received` plus `catalog.product.updated` audit. | Hosted staging evidence and failed-event replay remain later. |
| Failed provider webhook replay | `blocked` | Provider webhook metadata and failed-event listing exist; replay is intentionally blocked. | M14 raw payload storage/redaction/replay authorization design. |
| Emergency re-enable | `blocked` | `POST /merchants/{merchant_id}/disable-agentic-commerce` exists; no safe re-enable contract. | M14 re-enable API with operator role, reason, policy evidence, incident acknowledgement, audit. |
| Policy simulator/UI | `partial` | Policy create/list/read/activate/evaluate API exists; portal simulator/control UI is not complete. | M12D policy console and simulator UI backed by existing evaluate API. |
| Portal onboarding/catalog/CSV/webhook-source/policy/publish controls | `partial` | Portal has payments, audit, passports, settings, playground, ops. Missing full onboarding, catalog manager, CSV import, webhook-source manager, policy console, publish controls. | M12D merchant control-plane UI over completed APIs. |

## Current OpenAPI `x-implemented: false` Route Inventory

The validator pins this current set so the gap report cannot silently drift:

- None. The remaining gaps in this report are portal controls, failed provider
  webhook replay, emergency re-enable, hosted staging evidence, and Plural
  sandbox/live integrations; they are not represented as current
  `x-implemented: false` OpenAPI paths.

## Grantex MCP Contract

| Contract item | Status | Current evidence | Gap |
| --- | --- | --- | --- |
| `merchant.get_profile` | `done` | Implemented in `commerce-mcp.ts` and profile docs. | Hosted staging evidence still absent. |
| `catalog.search` | `done` | MCP tool maps to implemented catalog search. | Product list API remains separate and missing. |
| `catalog.get_item` | `done` | MCP tool maps to implemented get item. | No bulk/catalog manager parity yet. |
| `inventory.check` | `done` | MCP tool computes variant availability/freshness buckets. | Hosted staging evidence still absent. |
| `cart.create` | `done` | MCP tool maps to implemented cart create and idempotency. | Hosted staging evidence still absent. |
| `checkout.create` | `done` | MCP tool maps to checkout creation; M8 state fix aligns `authorized -> checkout_created -> payment_pending`. | Hosted staging evidence still absent. |
| `payment.create_intent` | `done` | MCP tool maps to provider-neutral payment intent. | Plural sandbox remains blocked. |
| `payment.get_status` | `done` | MCP tool maps to payment status read. | Hosted staging evidence still absent. |
| JSON-RPC over HTTP caveat | `partial` | `/mcp` handles `initialize`, `tools/list`, and `tools/call` over HTTP JSON-RPC. | This is a minimal streamable HTTP-compatible slice, not a broad conformance claim. |
| No UCP/ACP/AP2/MPP certification claims | `done` | Commerce docs and profile avoid external certification claims. | Keep static scans in readiness reports before publishing. |

## Payments Contract

| Contract item | Status | Current evidence | Gap |
| --- | --- | --- | --- |
| Mock provider | `done` | Provider-neutral mock path creates authorized intents and checkout links. | Hosted staging smoke still needed. |
| Plural sandbox adapter status | `blocked` | `PluralPaymentProvider` returns explicit blocked validation errors until API/signature details are confirmed. | M13 external contract required. |
| Plural live status | `blocked` | Live mode remains gated and not enabled. | Legal, provider, production, and readiness approvals required later. |
| Checkout state machine | `done` | State transitions enforce `authorized -> checkout_created -> payment_pending` and reject invalid transitions. | Hosted staging evidence still needed. |
| Webhook idempotency | `done` | Provider webhook processing records provider events and duplicate handling for mock provider; M12C adds merchant webhook event idempotency for `catalog.product.updated`. | Failed replay is still blocked. |
| Reconciliation | `done` | Manual reconciliation endpoint and worker support exist for payment intents. | Hosted staging evidence still needed. |
| Audit evidence | `done` | Commerce audit events are appended for critical protected actions. | Database-level append-only hardening should be separately verified before external pilot. |
| No live payment exposure | `done` | Docs, flags, and harnesses keep live payments and live Plural off. | Continue refusing live flags in staging tooling. |

## Safe Fixes Made In M12

- Added this gap report.
- Added validator coverage that reads the report, extracts current OpenAPI `x-implemented: false` routes, and fails if the report or pinned inventory drifts.
- Did not implement broad API families, portal redesign, Plural integration, or hosted run mode.

## Safe Fixes Made In M12A

- Implemented `PATCH /v1/commerce/merchants/{merchant_id}` with mutable-field allowlist, tenant-bound update, non-enumerating 404 for missing/cross-tenant merchants, and `merchant.updated` audit metadata containing changed field names only.
- Implemented `GET /v1/commerce/agents` with tenant-bound listing, operator/merchant/agent caller scoping, status/trust filters, cursor pagination, and no API key hash, private key, provider credential, bearer token, or secret output.
- Implemented `PATCH /v1/commerce/agents/{agent_id}` as operator-only with mutable-field allowlist, trust/status validation, self-elevation denial by caller matrix, tenant-bound update, and `agent.updated` audit metadata containing changed field names only.
- Updated OpenAPI to mark the three M12A operations `x-implemented: true`; product, CSV, webhook-source, inbound webhook, portal, failed replay, emergency re-enable, and Plural work remain out of scope.

## Safe Fixes Made In M12B

- Implemented `GET /v1/commerce/catalog/products` for tenant/merchant-scoped product summaries with active-by-default status filtering, query/category filters, and cursor pagination.
- Implemented `PATCH /v1/commerce/catalog/products/{product_id}` with product and variant mutable-field allowlists, merchant/operator write scoping, variant ownership validation, currency/price validation, and `product.updated` audit metadata containing changed field names only.
- Preserved the existing immutable cart and payment intent snapshot posture: catalog price patches update product variant rows only and do not update `commerce_carts` or `commerce_payment_intents` snapshots.
- Implemented `POST /v1/commerce/catalog/products/bulk` with dry-run validation by default, explicit transactional upsert mode, per-row result reporting, tenant/merchant boundary checks, and `catalog.bulk_ingested` audit on writes.
- Added local-only CSV dry-run validation via `scripts/commerce-catalog-csv-validate.mjs` and `docs/examples/commerce-catalog-import.sample.csv`; no DB/API/network importer, portal upload, webhook-source, failed replay, emergency re-enable, or Plural integration was added.
- Updated OpenAPI to mark the three M12B operations `x-implemented: true`; webhook-source and inbound merchant webhook implementation remained for M12C.

## Safe Fixes Made In M12C

- Added `commerce_webhook_sources` and `commerce_merchant_webhook_events` persistence with encrypted signing material, secret hashes, metadata-only event rows, payload hashes, idempotency, and no raw payload/signature/secret storage.
- Implemented `POST /v1/commerce/webhook-sources`, `GET /v1/commerce/webhook-sources`, `PATCH /v1/commerce/webhook-sources/{source_key}`, and `POST /v1/commerce/webhook-sources/{source_key}/rotate-secret` with operator/owning-merchant auth, agent denial, tenant/merchant boundary checks, immutable/sensitive field rejection, one-time signing secret behavior, and audit.
- Implemented `POST /v1/webhooks/merchant/{merchant_id}/{source_key}` for signed complete-state `catalog.product.updated` only. It uses `X-Grantex-Merchant-Timestamp` and `X-Grantex-Merchant-Signature`, rejects unsigned/invalid/stale/disabled/malformed/unsupported events, accepts duplicate event IDs idempotently, and upserts product/variant catalog state without mutating active cart or payment intent snapshots.
- Updated OpenAPI to mark all M12C routes `x-implemented: true` and document the signature contract, replay behavior, one-time secret behavior, and no-secret/no-raw-payload storage posture.
- Did not implement portal controls, failed provider webhook replay, emergency re-enable, Plural sandbox/live integration, cloud deployment, production config changes, or live payment enablement.

## Exact Future Implementation Prompts

### M12A Merchant/Agent Mutable/List API Completion

`Task: M12A only - implement Grantex Commerce V1 merchant update and CommerceAgent list/update APIs. Do not deploy or enable production/live payments/live Plural. Start from the M12 gap report. Implement PATCH /v1/commerce/merchants/{merchant_id}, GET /v1/commerce/agents, and PATCH /v1/commerce/agents/{agent_id} using existing auth, tenant-boundary, validation, and audit patterns. Mutable fields must be allowlisted and must not allow tenant_id, ownership IDs, provider references, public key material outside explicit rotation semantics, or audit fields. Update OpenAPI x-implemented markers and add focused auth-service tests for success, validation, tenant mismatch, unauthorized caller, immutable field rejection, trust/status changes, and audit events.`

### M12B Product List/Patch/Bulk/CSV Completion

`Task: M12B only - implement Grantex Commerce V1 product list, product patch, bulk product ingest, and CSV import planning/validation. Do not deploy or enable production/live payments/live Plural. Start from the M12 gap report. Implement GET /v1/commerce/catalog/products, PATCH /v1/commerce/catalog/products/{product_id}, and POST /v1/commerce/catalog/products/bulk with existing catalog patterns, tenant/merchant scoping, per-row validation, audit, and stale price safeguards. Add a CSV dry-run validator or documented importer plan before any network/cloud path. Update OpenAPI and focused tests, including price changes not mutating active payment intents.`

### M12C Inbound Merchant Webhook Source APIs And `catalog.product.updated`

`Task: M12C only - implement Grantex Commerce V1 inbound merchant webhook source management and signed catalog.product.updated ingestion. Do not deploy or enable production/live payments/live Plural. Start from the M12 gap report. Implement POST/GET/PATCH /v1/commerce/webhook-sources, POST /v1/commerce/webhook-sources/{source_key}/rotate-secret, and POST /v1/webhooks/merchant/{merchant_id}/{source_key}. Accept only signed complete-state catalog.product.updated events, reject unsigned/replayed/malformed events, redact secrets, store safe metadata, update catalog atomically, and append audit. Update OpenAPI and tests for signature, replay, tenant mismatch, disabled source, schema errors, and audit.`

### M12D Portal Onboarding/Catalog/Webhook-Source/Policy/Publish Controls

`Task: M12D only - implement Grantex portal merchant control-plane UI slices backed by completed M12A-M12C APIs. Do not deploy or enable production/live payments/live Plural. Add onboarding, catalog manager, CSV import dry-run, webhook-source manager, policy simulator/control, and publish/unpublish controls using existing portal design patterns. No broad redesign. Add focused portal tests for loading, empty, error, success, no-secret rendering, and API parity.`

### M14 Failed Webhook Replay And Emergency Re-enable

`Task: M14 only - design and implement safe failed provider webhook replay plus merchant emergency re-enable recovery. Do not deploy or enable production/live payments/live Plural. Start from the M12 gap report. Add raw-payload storage only with explicit redaction/encryption/retention design, replay authorization, idempotency preservation, replay audit semantics, and operator-only controls. Add emergency re-enable API with reason, policy evidence, active policy check, recent incident acknowledgement, tenant ownership, and audit. Add tests for unauthorized, tenant mismatch, missing reason, replay duplication, unsafe payload, and audit.`

### M13 Plural Sandbox Integration After External Contract

`Task: M13 only - integrate Plural sandbox after the exact API, credential, checkout, status, and webhook signature contracts are confirmed. Do not enable live payments or live Plural. Keep provider-neutral interfaces. Implement sandbox-only credential validation, payment intent, checkout link, status polling, webhook verification, normalized errors, and E2E sandbox tests. Keep live mode blocked by flags and update docs/OpenAPI without exposing secret values.`
