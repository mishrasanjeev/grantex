# Commerce V1 C6Sib - Connector Remediation Operator Triage Portal

C6Sib adds portal controls for the C6Sia backend operator triage route. The
portal lets an operator view persisted sandbox connector remediation records,
filter by triage status, record public-safe triage metadata, and show
merchant-visible follow-up guidance from the redacted timeline.

C6Sib is portal, docs, and tests only. It remains sandbox-only,
credential-free, non-live, non-publication, non-certifying, and non-enabling.

## Operator Workflow

1. Load the merchant's Commerce Onboarding page.
2. Load the persisted connector remediation queue.
3. Optionally filter by remediation status and C6Sia `triage_status`.
4. Open the redacted remediation timeline for a selected remediation record.
5. Record operator triage with:
   - triage status;
   - public-safe operator assignment reference;
   - public-safe internal triage note;
   - merchant-visible follow-up summary;
   - public-safe next step.
6. Reopen the refreshed redacted timeline and continue the sandbox-only
   corrected dry-run or follow-up review flow when existing C6R/C6Sg/C6Sa
   controls allow it.

Duplicate identical triage submissions are displayed as already-current state.
They must not be treated as a new production approval or new connector
execution authorization.

## Merchant-Visible Guidance

Merchant-visible guidance is limited to remediation status, a short follow-up
summary, and the next sandbox evidence step. It must not expose internal
operator notes, raw connector rows, raw merchant-system payloads, customer data,
credentials, provider metadata, private API URLs, checkout URLs, payment
identifiers, production config values, concrete allowlists, or secrets.

## Non-Enabling Controls

The portal continues to show fixed false/off controls for:

- credential entry;
- outbound sync;
- production connector setup;
- public discovery;
- checkout/payment;
- live provider and live Plural;
- provider calls;
- merchant private API calls;
- production allowlists;
- production approval;
- connector execution approval;
- certification.

## Stop Conditions

Stop and require a new approved work item if any change:

- adds backend routes, migrations, workers, workflows, schedules, or runtime
  connector execution;
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

C6Sib rollback removes:

- the portal API client helper for the C6Sia triage route;
- portal triage status filtering and operator triage controls;
- redacted triage timeline presentation;
- the C6Sib portal tests;
- this internal note.

Rollback does not require cloud action, secret rotation, production config
changes, public discovery changes, checkout/payment changes, live provider
changes, merchant private API changes, production allowlist changes, or
certification work.

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
