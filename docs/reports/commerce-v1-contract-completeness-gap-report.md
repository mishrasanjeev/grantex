# Commerce V1 Contract Completeness Gap Report

Status: M12 gap analysis and safe static guards only. This pass did not deploy, merge, create cloud resources, change production config, enable production Commerce V1, enable live payments, enable live Plural, touch production secrets, or commit local-only artifacts.

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
| Merchant/agent mutable control-plane APIs | `not-started` | OpenAPI still marks list/update gaps as `x-implemented: false`; routes are absent. |
| Product list/update/bulk/CSV | `not-started` | Product create/get/archive/search exist, but list/update/bulk and CSV ingestion are missing. |
| Inbound merchant webhook source APIs | `not-started` | All source management and inbound merchant webhook endpoints remain `x-implemented: false`. |
| Portal merchant control plane | `partial` | Payments, audit, passports, settings, playground, and ops views exist; onboarding/catalog/CSV/webhook-source/policy/publish controls do not. |
| Failed provider webhook replay | `blocked` | Failed metadata exists, but safe raw payload storage, redaction, authorization, and replay audit semantics are absent. |
| Emergency re-enable | `blocked` | Emergency disable exists; safe re-enable contract and UI/API do not. |
| Plural sandbox | `blocked` | The adapter fails closed until the real API and webhook signature contract is confirmed. |
| Live payments and live Plural | `blocked` | Correctly unavailable for V1 staging and this pass. |
| Hosted staging E2E evidence | `blocked` | M11 added dry-run planning only; no hosted services exist yet. |

## Grantex API Contract

| Contract item | Status | Current evidence | Required next slice |
| --- | --- | --- | --- |
| `PATCH /v1/commerce/merchants/{merchant_id}` | `not-started` | OpenAPI `x-implemented: false`; `commerce.ts` has create/get only. | M12A mutable merchant allowlist with audit and tenant boundary tests. |
| `GET /v1/commerce/agents` | `not-started` | OpenAPI `x-implemented: false`; `commerce.ts` has create/get by id only. | M12A scoped list endpoint with operator filters and no secret fields. |
| `PATCH /v1/commerce/agents/{agent_id}` | `not-started` | OpenAPI `x-implemented: false`; trust/status update path absent. | M12A mutable agent allowlist, trust/status controls, audit. |
| `GET /v1/commerce/catalog/products` | `not-started` | OpenAPI `x-implemented: false`; only get-by-id and search exist. | M12B paginated list with merchant/agent/operator scoping. |
| `PATCH /v1/commerce/catalog/products/{product_id}` | `not-started` | OpenAPI `x-implemented: false`; only create/get/archive exist. | M12B mutable product/variant allowlist with price-change safety. |
| `POST /v1/commerce/catalog/products/bulk` | `not-started` | OpenAPI `x-implemented: false`; no route. | M12B bulk ingest with per-row validation and audit. |
| CSV import path | `not-started` | PRD/workplan require CSV; no route or portal import path is present. | M12B define CSV spec, dry-run validation, then import endpoint/UI. |
| `POST /v1/commerce/webhook-sources` | `not-started` | OpenAPI `x-implemented: false`; no route. | M12C source registration, signing key generation, redacted responses. |
| `GET /v1/commerce/webhook-sources` | `not-started` | OpenAPI `x-implemented: false`; no route. | M12C source metadata list with no secret disclosure. |
| `PATCH /v1/commerce/webhook-sources/{source_key}` | `not-started` | OpenAPI `x-implemented: false`; no route. | M12C enable/disable and schema controls with audit. |
| `POST /v1/commerce/webhook-sources/{source_key}/rotate-secret` | `not-started` | OpenAPI `x-implemented: false`; no route. | M12C staged secret rotation with old/new validation window. |
| `POST /v1/webhooks/merchant/{merchant_id}/{source_key}` | `not-started` | OpenAPI `x-implemented: false`; no route; unsigned inbound merchant webhooks are not accepted. | M12C implement `catalog.product.updated` complete-state ingestion with signature and replay checks. |
| Failed provider webhook replay | `blocked` | Provider webhook metadata and failed-event listing exist; replay is intentionally blocked. | M14 raw payload storage/redaction/replay authorization design. |
| Emergency re-enable | `blocked` | `POST /merchants/{merchant_id}/disable-agentic-commerce` exists; no safe re-enable contract. | M14 re-enable API with operator role, reason, policy evidence, incident acknowledgement, audit. |
| Policy simulator/UI | `partial` | Policy create/list/read/activate/evaluate API exists; portal simulator/control UI is not complete. | M12D policy console and simulator UI backed by existing evaluate API. |
| Portal onboarding/catalog/CSV/webhook-source/policy/publish controls | `partial` | Portal has payments, audit, passports, settings, playground, ops. Missing full onboarding, catalog manager, CSV import, webhook-source manager, policy console, publish controls. | M12D merchant control-plane UI over completed APIs. |

## Current OpenAPI `x-implemented: false` Route Inventory

The validator pins this current set so the gap report cannot silently drift:

- `PATCH /v1/commerce/merchants/{merchant_id}`
- `GET /v1/commerce/agents`
- `PATCH /v1/commerce/agents/{agent_id}`
- `GET /v1/commerce/catalog/products`
- `POST /v1/commerce/catalog/products/bulk`
- `PATCH /v1/commerce/catalog/products/{product_id}`
- `POST /v1/webhooks/merchant/{merchant_id}/{source_key}`
- `POST /v1/commerce/webhook-sources`
- `GET /v1/commerce/webhook-sources`
- `PATCH /v1/commerce/webhook-sources/{source_key}`
- `POST /v1/commerce/webhook-sources/{source_key}/rotate-secret`

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
| Webhook idempotency | `done` | Provider webhook processing records provider events and duplicate handling for mock provider. | Failed replay is still blocked. |
| Reconciliation | `done` | Manual reconciliation endpoint and worker support exist for payment intents. | Hosted staging evidence still needed. |
| Audit evidence | `done` | Commerce audit events are appended for critical protected actions. | Database-level append-only hardening should be separately verified before external pilot. |
| No live payment exposure | `done` | Docs, flags, and harnesses keep live payments and live Plural off. | Continue refusing live flags in staging tooling. |

## Safe Fixes Made In M12

- Added this gap report.
- Added validator coverage that reads the report, extracts current OpenAPI `x-implemented: false` routes, and fails if the report or pinned inventory drifts.
- Did not implement broad API families, portal redesign, Plural integration, or hosted run mode.

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
