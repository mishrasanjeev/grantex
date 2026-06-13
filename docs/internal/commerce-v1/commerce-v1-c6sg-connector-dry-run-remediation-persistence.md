# Commerce V1 C6Sg - Connector Dry-Run Remediation Persistence

C6Sg adds a tenant-scoped sandbox remediation and follow-up evidence foundation
for connector dry-runs. It closes the gap left by C6Sf, where the remediation
loop existed only as local portal state. The persisted state remains internal,
sandbox-only, non-live, non-publication, non-certifying, and non-enabling.

C6Sg does not add credential entry, outbound sync, production connector setup,
public discovery, checkout/payment behavior, live payment behavior, provider
calls, merchant private API calls, production allowlists, production config, or
certification claims.

## Traceability Checklist

| Requirement | Files | Tests | Guardrails | Status |
| --- | --- | --- | --- | --- |
| Tenant-scoped sandbox remediation model | `055_commerce_connector_dry_run_remediations.sql`, `commerce-connectors.ts` | `commerce-connector-remediation-c6sg.test.ts` | Stores redacted summary fields only | Implemented |
| Link original dry-run/review to corrected dry-run and follow-up review | `commerce-connectors.ts` | create, attach, and follow-up route tests | Original review must be `needs_changes` or `blocked` | Implemented |
| Idempotent requests | `commerce-connectors.ts` | duplicate remediation, duplicate attachment, duplicate follow-up tests | Reuses existing rows and audit references | Implemented |
| Audit evidence | `audit.ts`, `commerce-connectors.ts` | audit event assertions | Audit metadata excludes raw files, credentials, providers, production config, allowlists, and checkout/payment artifacts | Implemented |
| OpenAPI coverage | `docs/api/grantex-commerce-v1.openapi.yaml` | OpenAPI drift guard | Routes marked C6Sg, sandbox-only, non-enabling | Implemented |
| Portal backing | `CommerceOnboarding.tsx`, portal API client | portal tests | Shows backend remediation status without credential or live execution controls | Implemented |

## Merchant Flow

1. Run a C6R manual/CSV sandbox connector dry-run.
2. Request C6Sa review.
3. If the operator records `needs_changes` or `blocked`, create C6Sg
   remediation evidence.
4. Correct the local sandbox rows and run another C6R dry-run.
5. Attach the corrected passed dry-run to the remediation record.
6. Request follow-up review through Grantex.
7. Operators review the corrected sandbox evidence before any later self-serve
   connector onboarding work.

No step approves production launch, connector execution, outbound sync, public
discovery, checkout/payment, live providers, public protocol publication, or
certification.

## Persisted Evidence

The remediation row stores:

- remediation ID;
- tenant ID and merchant ID;
- original dry-run ID and original review ID;
- original decision, limited to `needs_changes` or `blocked`;
- remediation status;
- public-safe note;
- blocker and warning summaries;
- corrected dry-run ID when attached;
- follow-up review ID when requested;
- requested, corrected, follow-up, and blocked audit references;
- fixed non-enabling controls.

It does not store raw connector rows, raw files, raw merchant-system responses,
credentials, tokens, provider metadata, private API URLs, checkout URLs, payment
identifiers, production config values, concrete allowlists, customer data, or
secret material.

## Statuses

- `remediation_requested`: the original operator issue has persisted evidence.
- `waiting_for_corrected_dry_run`: reserved for a future explicit waiting
  transition.
- `corrected_dry_run_attached`: a corrected passed sandbox dry-run is linked.
- `followup_review_requested`: a follow-up C6Sa review exists for the corrected
  dry-run.
- `followup_ready`: the corrected dry-run follow-up review is accepted for
  sandbox follow-up.
- `blocked_again`: corrected evidence or follow-up review remains blocked.
- `closed_no_action`: reserved for a future explicit close action.

`followup_ready` means sandbox follow-up only. It is not production approval,
connector execution approval, outbound sync approval, public discovery approval,
checkout/payment approval, live provider approval, public protocol publication,
or certification.

## API

C6Sg adds:

- `POST /v1/commerce/merchants/{merchant_id}/connectors/dry-runs/{dry_run_id}/remediation`
- `GET /v1/commerce/merchants/{merchant_id}/connectors/remediations/{remediation_id}`
- `POST /v1/commerce/merchants/{merchant_id}/connectors/remediations/{remediation_id}/corrected-dry-run`
- `POST /v1/commerce/merchants/{merchant_id}/connectors/remediations/{remediation_id}/follow-up-review`

All routes are tenant scoped. Merchant callers can operate only on their own
merchant. Operator callers remain tenant scoped. CommerceAgent direct execution
is denied by the existing connector caller boundary.

## Audit Events

C6Sg audit events:

- `connector_remediation_requested`
- `connector_remediation_corrected_dry_run_attached`
- `connector_remediation_followup_review_requested`
- `connector_remediation_closed_or_blocked`

Duplicate requests return existing rows and audit references instead of writing
duplicate audit events.

## Existing-System Boundary

C6Sg does not connect to Shopify, WooCommerce, Magento, custom APIs, ERP, OMS,
WMS, logistics, CRM/support, payment providers, Plural, Stripe, Pine, or
merchant private APIs. AgenticOrg never directly executes merchant private API
calls. It continues to consume only Grantex-owned preview and buyer discovery
surfaces after Grantex records the required sandbox evidence.

AgenticOrg never directly executes merchant private API calls in this flow.

## Stop Conditions

Stop and require a new approved work item if any follow-up:

- accepts or stores real connector credentials;
- adds outbound sync workers, connector execution, private API URLs, schedules,
  background jobs, or real merchant-system calls;
- calls Shopify, WooCommerce, Magento, custom API, ERP, OMS, WMS, logistics,
  CRM/support, payment providers, Plural, Stripe, Pine, or merchant private
  APIs;
- allows AgenticOrg to call merchant private APIs directly;
- enables Grantex public discovery or AgenticOrg public commerce discovery;
- enables production Commerce V1, checkout/payment creation, fulfillment,
  refund execution, live payments, live Plural, or live providers;
- writes production config or production allowlists;
- claims production approval, public protocol publication, provider approval,
  live-payment approval, or certification;
- treats sandbox, demo, synthetic, fixture, dry-run, review, packet, handoff,
  remediation, export, or rehearsal output as real merchant approval.

## Rollback Notes

C6Sg rollback removes:

- `apps/auth-service/src/db/migrations/055_commerce_connector_dry_run_remediations.sql`
- C6Sg route additions in `apps/auth-service/src/routes/commerce-connectors.ts`
- C6Sg audit event types in `apps/auth-service/src/lib/commerce/audit.ts`
- C6Sg ID helper in `apps/auth-service/src/lib/commerce/ids.ts`
- portal API and UI additions for persisted remediation status
- this internal note and the C6Sg guide section

No public discovery, production checkout/payment, live payment, live Plural,
provider credential, production config, production allowlist, cloud resource, or
deploy workflow action is created by this slice.

## Validation

Focused validation for C6Sg:

```bash
npm --prefix apps/auth-service test -- commerce-connector-dry-run-c6r.test.ts commerce-connector-dry-run-review-c6sa.test.ts commerce-openapi.test.ts
npm --prefix apps/auth-service test -- commerce-connector-remediation-c6sg.test.ts
npm --prefix apps/auth-service run typecheck
npm --prefix apps/portal test -- src/api/__tests__/commerce.test.ts src/pages/__tests__/CommerceDashboard.test.tsx
npm --prefix apps/portal run typecheck
node scripts/commerce-c6oe-preview-conformance-gate.mjs --mode pr
git diff --check origin/main...HEAD
```

Focused scans must cover secrets/private details, production config or allowlist
assignments, public discovery enablement, checkout/payment enablement, live
payment/live Plural/provider credential enablement, certification claims, direct
provider calls, direct merchant private API calls, AgenticOrg direct execution,
and outbound sync enablement.
