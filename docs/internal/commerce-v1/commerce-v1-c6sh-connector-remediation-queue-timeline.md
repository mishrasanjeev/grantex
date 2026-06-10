# Commerce V1 C6Sh - Connector Remediation Queue And Timeline

C6Sh makes persisted C6Sg remediation evidence operational through a
tenant-scoped operator queue, merchant-visible status filters, and a redacted
timeline. It remains internal, sandbox-only, non-live, non-publication,
non-certifying, and non-enabling.

C6Sh does not add credential entry, outbound sync, production connector setup,
public discovery, checkout/payment behavior, live payment behavior, provider
calls, merchant private API calls, production allowlists, production config, or
certification claims.

## Traceability Checklist

| Requirement | Files | Tests | Guardrails | Status |
| --- | --- | --- | --- | --- |
| Tenant-scoped operator queue | `commerce-connectors.ts` | `commerce-connector-remediation-queue-c6sh.test.ts` | Operators can filter tenant evidence; merchant callers are self-scoped | Implemented |
| Status filters | `commerce-connectors.ts`, portal API | route and API client tests | Filters are read-only and fail closed on invalid values | Implemented |
| Redacted remediation timeline | `commerce-connectors.ts`, `CommerceOnboarding.tsx` | route and portal tests | Timeline is synthesized from remediation state and audit references only | Implemented |
| Merchant self-serve status visibility | portal API/UI | `CommerceDashboard.test.tsx` | Shows next step without production approval or connector execution controls | Implemented |
| OpenAPI coverage | `docs/api/grantex-commerce-v1.openapi.yaml` | OpenAPI drift guard | Routes marked C6Sh, sandbox-only, non-enabling | Implemented |
| Docs and stop conditions | this note, operator guide | docs drift guard | Keeps launch, discovery, checkout/payment, live provider, and certification blockers explicit | Implemented |

## What Merchants See

Merchants can load their own persisted remediation queue and timeline after a
C6Sa review returns `needs_changes` or `blocked`. The portal shows the current
sandbox status, the corrected dry-run link if present, follow-up review link if
present, redacted blocker/warning counts, and the next safe step.

The merchant-visible status is not production approval. It does not permit live
connector execution, outbound sync, public discovery, checkout/payment creation,
live providers, production allowlists, or public protocol publication.

## What Operators See

Operators can list tenant-scoped remediation records and filter by:

- merchant ID;
- remediation status;
- original decision;
- whether a corrected dry-run is attached;
- whether a follow-up review is requested;
- result limit.

The queue is a review worklist only. It helps operators find remediation loops
that need corrected evidence or follow-up review. It does not approve real
merchant launch, production Commerce V1, public discovery, checkout/payment, or
live providers.

## Redacted Timeline

The timeline includes:

- remediation request;
- corrected dry-run attachment, when present;
- follow-up review request, when present;
- terminal follow-up status, when present;
- audit references;
- IDs for the remediation, original dry-run, original review, corrected dry-run,
  and follow-up review;
- fixed non-enabling controls.

The timeline excludes raw connector rows, raw files, raw merchant-system
payloads, credentials, tokens, provider metadata, private API URLs, checkout
URLs, payment identifiers, production config values, concrete allowlists,
customer data, and secret material.

## API

C6Sh adds:

- `GET /v1/commerce/connectors/remediations`
- `GET /v1/commerce/merchants/{merchant_id}/connectors/remediations/{remediation_id}/timeline`

Both routes are tenant scoped. Merchant callers can read only their own
merchant remediation evidence. Operator callers can list the tenant queue.
CommerceAgent callers remain denied, and AgenticOrg never directly executes
merchant private API calls.

## Portal Behavior

The portal adds a credential-free remediation queue and redacted timeline panel
inside the existing sandbox connector dry-run review card. The panel provides:

- status filter;
- queue load action;
- current remediation timeline load action;
- per-row timeline action;
- blocker and warning counts;
- corrected/follow-up flags;
- audit references;
- explicit disabled controls for public discovery, checkout/payment, live
  providers, and merchant private API execution.

No credential entry, production connector setup, outbound sync, public discovery
control, checkout/payment control, live provider control, allowlist control, or
certification control is added.

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
  remediation, export, timeline, or rehearsal output as real merchant approval.

## Rollback Notes

C6Sh rollback removes:

- C6Sh read-only route additions in `apps/auth-service/src/routes/commerce-connectors.ts`;
- `apps/auth-service/tests/commerce-connector-remediation-queue-c6sh.test.ts`;
- portal API and UI additions for remediation queue and timeline visibility;
- OpenAPI C6Sh path/schema additions;
- this internal note and the C6Sh guide section.

No migration, runtime connector execution, public discovery, checkout/payment,
live payment, live Plural, provider credential, production config, production
allowlist, cloud resource, or deploy workflow action is created by this slice.

## Validation

Focused validation for C6Sh:

```bash
npm --prefix apps/auth-service test -- commerce-connector-dry-run-c6r.test.ts commerce-connector-dry-run-review-c6sa.test.ts commerce-connector-remediation-c6sg.test.ts commerce-connector-remediation-queue-c6sh.test.ts commerce-openapi.test.ts
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
