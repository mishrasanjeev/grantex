# Commerce V1 C6Sc - Connector Dry-Run Portal Hardening And Evidence Handoff

C6Sc hardens the credential-free C6Sb portal experience for C6R connector
dry-runs and C6Sa operator review evidence. It is portal, docs, and test work
only. It remains internal preview, sandbox-only, non-live, non-publication,
non-certifying, and non-enabling.

C6Sc does not add backend routes, migrations, workflows, workers, production
configuration, credentials, outbound sync, production connector setup, public
discovery, checkout/payment behavior, live payment behavior, provider calls,
merchant private API calls, production allowlists, or certification claims.

## Traceability Checklist

| Requirement | Files | Tests | Guardrails | Status |
| --- | --- | --- | --- | --- |
| Manual/CSV row UX hardening | `apps/portal/src/pages/commerce/CommerceOnboarding.tsx` | `CommerceDashboard.test.tsx` | Client-side validation only; backend dry-run remains source of truth | Implemented |
| Sample reset and clear rows | `CommerceOnboarding.tsx` | `CommerceDashboard.test.tsx` | Resets local input and clears stale dry-run/review state only | Implemented |
| Parsed row count and JSON parse errors | `CommerceOnboarding.tsx` | `CommerceDashboard.test.tsx` | Invalid JSON blocks submission before API call | Implemented |
| Disabled-state explanations | `CommerceOnboarding.tsx` | `CommerceDashboard.test.tsx` | Review and decision paths stay sandbox evidence only | Implemented |
| Redacted evidence handoff | `CommerceOnboarding.tsx` | `CommerceDashboard.test.tsx` | Summary fields, controls, blockers/warnings, and audit references only | Implemented |
| Operator docs | This doc and merchant/operator guide | Doc review | Stop conditions and retention guidance explicit | Implemented |

## Portal Behavior

The connector dry-run panel now supports:

- validating local sandbox rows before the dry-run request;
- showing parsed row, product, and variant estimates;
- displaying JSON parse errors inline;
- resetting the sample fixture;
- clearing all local rows;
- explaining why dry-run, review request, and decision actions are disabled;
- showing a redacted evidence handoff after a dry-run exists.

Validation is a convenience preflight. It does not replace C6R backend
validation and it does not write catalog data.

## Evidence Handoff

The C6Sc evidence handoff is generated client-side from already-returned C6R
dry-run and C6Sa review response summaries. It includes only:

- merchant ID;
- dry-run ID, connector type, source label, status, generated timestamp, and
  summary counts;
- blocker and warning codes with remediation or message text;
- review ID, review status, decision, requester kind, and review summary when a
  review exists;
- requested/completed/decision audit references;
- fixed non-enabling controls.

The evidence handoff excludes raw rows, raw merchant-system payloads,
credentials, tokens, provider metadata, private API URLs, checkout URLs,
payment identifiers, production config values, concrete allowlists, customer
data, and normalized product titles.

Operators can copy JSON or Markdown evidence and can download local JSON or
Markdown files. These are local/internal review artifacts only. Do not commit
timestamped or merchant-specific exports unless a later approved work item says
so.

## Fixed Controls

Every C6Sc handoff preserves these controls:

- `sandbox_only: true`
- `not_live: true`
- `not_approved: true`
- `public_discovery_enabled: false`
- `checkout_payment_enabled: false`
- `live_provider_enabled: false`
- `live_plural_enabled: false`
- `credential_entry_enabled: false`
- `outbound_sync_enabled: false`
- `production_connector_setup: false`
- `merchant_private_api_calls: false`
- `production_allowlist_written: false`
- `certification_claimed: false`

## Evidence Retention

Keep C6Sc exports in a local internal review directory when a reviewer needs a
handoff packet. Delete temporary exports after review unless retention is
explicitly required by an internal evidence process.

Do not paste secrets, private merchant artifacts, provider credentials, raw
payloads, tokens, JWTs, DB/Redis URLs, private keys, production config values,
concrete allowlist values, checkout URLs, payment identifiers, customer data,
live-provider claims, launch claims, or certification claims into portal notes
or evidence exports.

## Stop Conditions

Stop and require a new approved work item if any follow-up:

- adds credential entry, credential upload, secret storage, token storage, or
  provider credential paths;
- adds outbound sync, connector execution, worker schedules, background jobs, or
  merchant private API calls;
- connects to Shopify, WooCommerce, Magento, custom APIs, ERP, OMS, WMS,
  logistics, CRM/support, payment providers, Plural, Stripe, Pine, or merchant
  private APIs;
- allows AgenticOrg to call merchant private APIs directly;
- enables Grantex public discovery or AgenticOrg public commerce discovery;
- enables production Commerce V1, checkout/payment creation, fulfillment,
  refund execution, live payments, live Plural, or live providers;
- writes production config or production allowlists;
- claims production approval, public protocol publication, provider approval,
  live-payment approval, or certification;
- treats sandbox, demo, synthetic, fixture, dry-run, review, export, or
  rehearsal output as real merchant approval.

## Rollback Notes

C6Sc is portal/docs/test only. Roll back by removing:

- the row validation, reset, clear, disabled-state explanation, and evidence
  handoff additions in `CommerceOnboarding.tsx`;
- the related `CommerceDashboard.test.tsx` assertions;
- this internal note and the C6Sc guide section.

No runtime API, route, migration, worker, production config, public discovery,
checkout/payment, live payment, provider credential, production allowlist,
cloud resource, or deploy workflow action is created by this slice.

## Validation

Focused validation for C6Sc:

```bash
npm --prefix apps/portal test -- src/api/__tests__/commerce.test.ts src/pages/__tests__/CommerceDashboard.test.tsx
npm --prefix apps/portal run typecheck
npm --prefix apps/auth-service test -- commerce-connector-dry-run-c6r.test.ts commerce-connector-dry-run-review-c6sa.test.ts commerce-openapi.test.ts
npm --prefix apps/auth-service run typecheck
node scripts/commerce-c6oe-preview-conformance-gate.mjs --mode pr
git diff --check origin/main...HEAD
```

Focused scans must cover secrets/private details, production config or allowlist
assignments, public discovery enablement, checkout/payment enablement, live
payment/live Plural/provider credential enablement, certification claims, direct
provider calls, direct merchant private API calls, AgenticOrg direct execution,
and outbound sync enablement.

Expected scan hits should be limited to stop-condition text, denylist regex
literals, negative assertions, or explicit disabled-control examples.
