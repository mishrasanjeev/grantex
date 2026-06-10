# Commerce V1 C6Sid - Remediation Triage Evidence Reconciliation

C6Sid reconciles the operator and merchant views of persisted sandbox connector
remediation triage. It is portal, docs, and test work only. It remains
sandbox-only, credential-free, tenant-scoped, non-live, non-publication,
non-certifying, and non-enabling.

## Scope

C6Sid adds a portal reconciliation summary across existing C6S surfaces:

- persisted remediation queue item;
- redacted remediation timeline;
- backend remediation evidence already loaded by the portal;
- C6Sic triage workflow rehearsal status.

The reconciliation summary checks whether the queue triage status, timeline
merchant status, backend triage status, rehearsal status, merchant-visible
summary, next step, and redacted audit references agree.

No backend route, migration, worker, workflow, connector execution path,
credential entry, outbound sync, production connector setup, public discovery,
checkout/payment, live provider, provider call, merchant private API call,
production allowlist, or certification path is added.

## Reconciliation Checks

The portal summary includes:

- queue and timeline triage status;
- backend and timeline triage status;
- rehearsal and timeline triage status;
- merchant-visible guidance consistency;
- requested, corrected, follow-up, and triage audit references;
- redacted audit timeline continuity;
- stale/conflict follow-up handling;
- fixed non-enabling controls.

`aligned` means the loaded sandbox views agree. `warning` means the views are
loaded but not fully aligned. `blocked` means the loaded evidence contains a
sandbox blocker such as stale or conflicting follow-up guidance. None of these
states are production approval.

## Merchant-Visible Guidance

Merchant-visible guidance remains limited to public-safe summary and next-step
fields. It must not expose:

- internal operator notes;
- raw connector rows or raw merchant-system payloads;
- private merchant details;
- provider metadata;
- credentials or secrets;
- private API URLs;
- checkout/payment identifiers or URLs;
- production config values or concrete allowlists.

## Stale Or Conflicting Evidence

If stale or conflicting follow-up guidance appears in the loaded remediation
evidence, the portal marks it as `sandbox_blocker_only`. This means:

- the merchant should refresh or correct sandbox evidence;
- the operator should not treat the state as follow-up ready;
- the state does not authorize connector execution;
- the state does not approve public discovery, checkout/payment, live provider
  use, production allowlists, or production launch.

## Audit Reference Continuity

The portal validates redacted audit reference continuity for:

- remediation requested audit;
- corrected dry-run attachment audit, when a corrected dry-run exists;
- follow-up review request audit, when a follow-up review exists;
- triage audit, when triage is recorded.

The summary displays audit references only. It does not display raw connector
files, raw payloads, provider metadata, private merchant artifacts, credentials,
or secrets.

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
  triage, timeline, export, reconciliation, or rehearsal output as real
  merchant approval.

## Rollback Notes

C6Sid rollback removes the portal reconciliation summary, the stale/conflict
reconciliation tests, and this internal note. Rollback does not require cloud
action, secret rotation, production config changes, public discovery changes,
checkout/payment changes, live provider changes, merchant private API changes,
production allowlist changes, or certification work.

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
