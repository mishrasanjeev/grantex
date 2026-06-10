# Commerce V1 C6R Sandbox Connector Dry-Run Foundation

Status: implemented as a sandbox-only, dry-run-only Grantex connector sync
foundation.

Base:

- Grantex main after C6Q:
  `2fc839c70ab708799b7b337715f9092cab87aa7b`
- C6P planning packet:
  `docs/internal/commerce-v1/commerce-v1-c6p-first-connector-sync-adapter-planning.md`
- C6Q sandbox E2E packet:
  `docs/internal/commerce-v1/commerce-v1-c6q-sandbox-e2e-test-merchant.md`

C6R lets a tenant-owned sandbox merchant run a local connector sync dry-run
against manual or CSV-style catalog rows. It normalizes safe catalog rows into a
Grantex product and variant preview shape, records redacted dry-run evidence,
and keeps all controls non-enabling. It does not write live catalog changes,
does not call merchant systems, does not collect credentials, does not call
providers, does not enable public discovery, does not enable checkout or
payment creation, and does not approve production launch.

## Traceability Checklist

| Requirement | Owning file or module | Tests | Guardrails | Status |
| --- | --- | --- | --- | --- |
| Tenant-scoped connector dry-run service | `apps/auth-service/src/lib/commerce/connector-dry-run.ts` | `commerce-connector-dry-run-c6r.test.ts` | Tenant and merchant IDs must match authenticated commerce caller | Implemented |
| Manual/CSV local adapter only | `connector-dry-run.ts`, `commerce-connectors.ts` | Successful C6Q fake fixture dry-run test | No outbound sync, no external connector execution | Implemented |
| Normalize to product/variant preview | `connector-dry-run.ts` | Normalized preview and cap tests | Preview contains public-safe fields only | Implemented |
| Fail-closed validation and blockers | `connector-dry-run.ts` | Unsupported connector, live merchant, credential/private field, enablement, stale/conflict tests | Credentials, private URLs, production config, allowlists, provider calls, public discovery, checkout/payment, live provider fields are rejected or blocked | Implemented |
| Redacted persistence and audit | `053_commerce_connector_dry_runs.sql`, `commerce-connectors.ts`, `audit.ts` | Audit requested/completed/blocked tests | Store counts, blockers, warnings, capped preview only; no raw payloads or credentials | Implemented |
| Tenant-scoped API | `commerce-connectors.ts` | Route success, tenant boundary, GET dry-run tests | Operator or owning merchant only; CommerceAgent denied | Implemented |
| OpenAPI coverage | `docs/api/grantex-commerce-v1.openapi.yaml` | `commerce-openapi.test.ts`, C6R OpenAPI test | C6R routes marked sandbox/dry-run/non-enabling | Implemented |
| Merchant/operator docs | `docs/guides/commerce-v1-merchant-operator-guide.mdx` | C6R doc tests | Layman-readable, internal/sandbox posture explicit | Implemented |
| Portal UI | Not changed | Not applicable | Existing UI would require credential-free UX design; deferred to a later approved UI slice | Deferred |
| AgenticOrg boundary | This doc and guide | C6R doc tests | AgenticOrg consumes Grantex previews only and never calls merchant private APIs directly | Implemented |

## Merchant Flow

1. The merchant or operator registers a sandbox merchant and declares connector
   metadata through the C6N connector registry.
2. The merchant prepares a local CSV/manual catalog snapshot or uses a
   test-only fixture such as the C6Q DummyJSON-style snapshot.
3. The merchant calls the C6R dry-run endpoint with catalog rows. No credential
   field, private API URL, provider metadata, or raw merchant-system payload is
   accepted.
4. Grantex validates the tenant and merchant boundary, confirms the merchant is
   sandbox-only, checks the connector type, rejects enablement flags, and scans
   the rows for private or production-looking values.
5. Grantex normalizes valid rows into a capped public-safe preview and returns
   counts, blockers, warnings, and redacted audit references.
6. Operators review the dry-run evidence before any later self-serve onboarding,
   connector execution, public discovery, production checkout, or live provider
   work can be considered.

## Existing Merchant Systems

C6R is the first runtime step toward connecting merchant systems, but it does
not connect to them yet. Shopify, WooCommerce, Magento, custom API, ERP, OMS,
WMS, logistics, CRM/support, payment provider, Plural, Stripe, Pine, and
merchant private API integrations remain non-live and not called.

The first approved adapter is local/manual catalog dry-run only:

- `manual` connector type;
- `csv` connector type;
- JSON rows shaped like a CSV/manual snapshot;
- optional C6Q DummyJSON-style fake fixture rows in tests;
- no network access;
- no credentials;
- no outbound sync;
- no live merchant system execution.

AgenticOrg never directly executes merchant private API calls. It may consume
only Grantex-owned buyer discovery and preview surfaces after Grantex records
the required sandbox evidence.

## Dry-Run Controls

Every C6R result carries these controls:

- `sandbox_only: true`
- `not_live: true`
- `not_approved: true`
- `public_discovery_enabled: false`
- `checkout_payment_enabled: false`
- `live_provider_enabled: false`
- `live_plural_enabled: false`

The API also rejects request fields that try to enable:

- public discovery;
- AgenticOrg public discovery;
- checkout or payment creation;
- live payment, live Plural, or live provider paths;
- provider calls;
- merchant private API calls;
- outbound sync;
- production allowlists;
- production config writes.

## Evidence Operators Review

The persisted dry-run row stores redacted metadata only:

- dry-run ID;
- tenant and merchant ID;
- connector type and source label;
- status;
- safe posture booleans;
- row, product, variant, would-create, would-update, would-archive, blocked,
  and warning counts;
- capped normalized preview;
- blocker and warning codes;
- requested/completed/blocked audit references;
- generated timestamp.

It does not store raw files, raw merchant-system responses, credentials,
private URLs, provider metadata, customer data, exact provider payment IDs,
checkout URLs, production config values, or concrete allowlist values.

Audit events:

- `connector_dry_run_requested`
- `connector_dry_run_completed`
- `connector_dry_run_blocked`

## Self-Serve Onboarding Path

C6R supports future self-serve onboarding by giving merchants a safe way to see
how their existing catalog would map into Grantex before any live connector is
approved. A later self-serve flow can build on this evidence by adding a
credential intake review, source-of-truth approval, outbound sync approval,
rollback approval, and public-discovery or checkout approvals as separate
gates.

C6R itself remains dry-run-only and non-enabling.

## Stop Conditions

Stop and require a new approved work item if any follow-up:

- adds outbound sync workers, schedules, background connector execution, or
  real merchant-system calls;
- accepts or stores real connector credentials;
- calls Shopify, WooCommerce, Magento, custom API, ERP, OMS, WMS, logistics,
  CRM/support, payment providers, Plural, Stripe, Pine, or merchant private
  APIs;
- allows AgenticOrg to call merchant private APIs directly;
- writes production config or production allowlists;
- enables Grantex public discovery or AgenticOrg public commerce discovery;
- enables production Commerce V1;
- enables checkout/payment creation, fulfillment execution, refund execution,
  live payments, live Plural, or live providers;
- exposes secrets, provider metadata, raw payloads, private URLs, customer
  data, production config values, concrete allowlist values, or checkout URLs;
- claims UCP, ACP, AP2, schema.org, MPP, A2A, provider, Open Agentic Commerce,
  protocol-publication, or live-payment certification;
- treats sandbox, demo, synthetic, fixture, dry-run, or rehearsal output as
  production approval;
- requires cloud commands, cloud resources, manual deploys, or manual deploy
  workflow triggers.

## Rollback

C6R rollback removes:

- `apps/auth-service/src/lib/commerce/connector-dry-run.ts`
- C6R route additions in `apps/auth-service/src/routes/commerce-connectors.ts`
- `apps/auth-service/src/db/migrations/053_commerce_connector_dry_runs.sql`
- C6R audit event types in `apps/auth-service/src/lib/commerce/audit.ts`
- C6R ID helper in `apps/auth-service/src/lib/commerce/ids.ts`
- `apps/auth-service/tests/commerce-connector-dry-run-c6r.test.ts`
- C6R OpenAPI and guide sections

No public discovery, production checkout/payment, live payment, live Plural,
provider credential, production config, production allowlist, cloud resource,
or deploy workflow action is created by this slice.

## Validation

C6R validation should include:

- `npm --prefix apps/auth-service test -- commerce-connectors-c6n.test.ts commerce-c6p-connector-sync-planning.test.ts commerce-c6q-sandbox-e2e-test-merchant.test.ts`
- `npm --prefix apps/auth-service test -- commerce-connector-dry-run-c6r.test.ts`
- `npm --prefix apps/auth-service run typecheck`
- `node scripts/commerce-c6oe-preview-conformance-gate.mjs --mode pr`
- `git diff --check origin/main...HEAD`
- focused guardrail scans for secrets/private details, production config and
  allowlists, public discovery, checkout/payment enablement, live payment and
  live Plural/provider credentials, certification claims, direct provider
  calls, direct merchant private API calls, and real merchant identity/catalog
  treated as approval

Expected scan hits should be limited to stop-condition text, denylist regex
literals, negative assertions, or explicit disabled-control examples.
