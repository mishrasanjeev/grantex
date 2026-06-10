# Commerce V1 C6Sic - Remediation Triage Workflow Rehearsal

C6Sic hardens the C6Sib portal rehearsal for persisted sandbox connector
remediation triage. It is portal, docs, and test work only. It remains
sandbox-only, credential-free, tenant-scoped, non-live, non-publication,
non-certifying, and non-enabling.

## Scope

C6Sic rehearses the local operator workflow after C6Sia and C6Sib are in place:

1. Load the tenant-scoped remediation queue.
2. Filter by remediation status and operator triage status.
3. Open the redacted remediation timeline.
4. Record operator triage metadata.
5. Confirm duplicate identical triage submissions are shown as already-current
   state.
6. Confirm merchant-visible follow-up guidance contains only public-safe summary
   and next-step fields.
7. Confirm redacted audit timeline continuity remains intact.

The rehearsal does not add backend routes, migrations, workflows, workers,
runtime connector execution, credential entry, outbound sync, production
connector setup, public discovery, checkout/payment, live providers, provider
calls, merchant private API calls, production allowlists, or certification
claims.

## Merchant-Visible Follow-Up

The portal shows a dedicated merchant-visible guidance panel. That panel may
include:

- remediation status;
- merchant follow-up summary;
- next sandbox evidence step;
- redacted audit/timeline continuity indicators.

The panel must not include:

- internal operator triage notes;
- raw connector rows or raw merchant-system payloads;
- private merchant details;
- provider metadata;
- credentials or secrets;
- private API URLs;
- checkout/payment identifiers or URLs;
- production config values or concrete allowlists.

## Duplicate Triage Handling

Duplicate identical triage submissions are treated as existing/current sandbox
state. They must reuse the persisted triage state and audit reference returned
by Grantex. They are not a new production approval, connector execution
authorization, public discovery approval, checkout/payment approval, live
provider approval, or certification.

## Redacted Timeline Continuity

The portal derives the rehearsal status from the redacted timeline response. A
passing rehearsal requires every timeline entry to keep these redaction flags
false:

- raw connector rows included;
- credentials included;
- provider metadata included;
- merchant private API payload included;
- production config values included.

The rehearsal summary may show remediation IDs, triage status, audit reference,
timeline entry count, merchant-visible summary, next step, and fixed
non-enabling controls.

## Stop Conditions

Stop and require a new approved work item if any follow-up:

- adds or changes backend routes, migrations, workers, workflows, schedules, or
  runtime connector execution;
- adds credential entry, provider credentials, merchant private API URLs, or
  outbound sync controls;
- enables Grantex public discovery or AgenticOrg public commerce discovery;
- enables production Commerce V1, checkout/payment creation, fulfillment,
  refunds, live payments, live Plural, or live providers;
- calls Shopify, WooCommerce, Magento, custom API, ERP, OMS, WMS, logistics,
  CRM/support, payment providers, Plural, Stripe, Pine, or merchant private
  APIs;
- lets AgenticOrg call merchant private APIs directly;
- writes production config or production allowlists;
- claims production approval, public discovery approval, checkout/payment
  approval, live provider approval, public protocol publication, provider
  approval, live-payment approval, or certification;
- treats sandbox, demo, synthetic, fixture, dry-run, review, remediation,
  triage, timeline, export, or rehearsal output as real merchant approval.

## Rollback Notes

C6Sic rollback removes the portal rehearsal status panel, the dedicated
merchant-visible guidance hardening, the duplicate-current portal/API tests, and
this internal note. Rollback does not require cloud action, secret rotation,
production config changes, public discovery changes, checkout/payment changes,
live provider changes, merchant private API changes, production allowlist
changes, or certification work.

## Validation

Focused validation:

```bash
npm --prefix apps/portal test -- src/api/__tests__/commerce.test.ts src/pages/__tests__/CommerceDashboard.test.tsx
npm --prefix apps/portal run typecheck
npm --prefix apps/auth-service test -- commerce-connector-remediation-triage-c6sia.test.ts commerce-openapi.test.ts
npm --prefix apps/auth-service run typecheck
node scripts/commerce-c6oe-preview-conformance-gate.mjs --mode pr
git diff --check origin/main...HEAD
```

Focused scans must cover secrets/private details, production config or
allowlist assignments, public discovery enablement, checkout/payment
enablement, live payment/live Plural/provider credential enablement,
certification claims, direct provider calls, direct merchant private API calls,
AgenticOrg direct execution, and outbound sync enablement.
