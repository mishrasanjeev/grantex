# Commerce V1 C6Sia - Connector Remediation Operator Triage

C6Sia adds backend-only operator triage controls for persisted C6Sg/C6Sh
connector dry-run remediation records. Operators can assign a sandbox
remediation, record redacted status notes, and provide merchant-visible
public-safe follow-up guidance without enabling connector execution or approving
production launch.

C6Sia remains internal, sandbox-only, credential-free, non-live,
non-publication, non-certifying, and non-enabling.

## Traceability Checklist

| Requirement | Files | Tests | Guardrails | Status |
| --- | --- | --- | --- | --- |
| Tenant-scoped operator triage state | `commerce-connectors.ts`, migration 056 | `commerce-connector-remediation-triage-c6sia.test.ts` | Operators update only remediation records in the current tenant and merchant | Implemented |
| Assignment and status notes | `commerce-connectors.ts` | route tests | Notes are public-safe and reject secrets, private API values, provider metadata, checkout/payment artifacts, config, and allowlists | Implemented |
| Merchant-visible follow-up guidance | `commerce-connectors.ts`, OpenAPI | route and timeline tests | Guidance is summary-only and does not expose raw connector data | Implemented |
| Redacted triage audit timeline | `commerce-connectors.ts`, `audit.ts` | route and timeline tests | New audit event stores only IDs, status, presence flags, and fixed false/off controls | Implemented |
| Idempotent duplicate behavior | `commerce-connectors.ts` | duplicate request regression | Identical triage does not create duplicate rows or audit evidence | Implemented |
| API/OpenAPI/docs | OpenAPI, guide, this note | OpenAPI/docs drift guards | C6Sia is documented as sandbox-only and non-enabling | Implemented |

## Operator Workflow

1. Open a remediation record from the C6Sh operator queue.
2. Record a triage status such as `triage_in_progress`,
   `waiting_on_merchant`, `ready_for_followup_review`,
   `blocked_for_sandbox_followup`, or `closed_no_action`.
3. Optionally assign a public-safe operator reference.
4. Add public-safe internal notes and merchant-visible follow-up guidance.
5. Continue with corrected sandbox dry-run attachment or C6Sa follow-up review
   only when the existing C6R/C6Sg controls allow it.

The triage record is not production approval. It does not authorize live
connector execution, outbound sync, public discovery, checkout/payment, live
providers, production allowlists, public protocol publication, or certification.

## Merchant-Visible Guidance

The merchant-visible fields are limited to a short follow-up summary and next
step. They must describe only what to fix in sandbox evidence, for example
missing category mappings or warnings from a local dry-run. They must not
include raw rows, raw merchant-system payloads, customer data, credentials,
provider metadata, private API URLs, checkout URLs, payment identifiers,
production config values, concrete allowlists, or secret material.

## API

C6Sia adds:

- `POST /v1/commerce/merchants/{merchant_id}/connectors/remediations/{remediation_id}/triage`
- `triage_status` filtering on `GET /v1/commerce/connectors/remediations`

The triage route is operator-only. Merchant callers can continue to read their
own redacted remediation/timeline status through existing C6Sh routes, but they
cannot record operator triage. AgenticOrg never directly executes merchant
private API calls.

## Audit Evidence

`connector_remediation_triage_recorded` is appended only when triage state
changes. Duplicate identical triage requests return the existing remediation
record and existing audit reference. Audit metadata includes remediation IDs,
original evidence IDs, previous and next triage status, presence flags for
notes and guidance, and fixed non-enabling controls.

Audit evidence excludes raw connector rows, raw files, raw merchant-system
payloads, credentials, tokens, provider metadata, private API URLs, checkout
URLs, payment identifiers, production config values, concrete allowlists,
customer data, and secrets.

## Stop Conditions

Stop and require a new approved work item if any follow-up:

- adds portal credential entry, outbound sync, connector execution, private API
  URLs, schedules, workers, or real merchant-system calls;
- calls Shopify, WooCommerce, Magento, custom API, ERP, OMS, WMS, logistics,
  CRM/support, payment providers, Plural, Stripe, Pine, or merchant private
  APIs;
- allows AgenticOrg to call merchant private APIs directly;
- enables Grantex public discovery or AgenticOrg public commerce discovery;
- enables production Commerce V1, checkout/payment creation, fulfillment,
  refund execution, live payments, live Plural, or live providers;
- writes production config or production allowlists;
- claims production approval, connector execution approval, public discovery
  approval, checkout/payment approval, live provider approval, public protocol
  publication, provider approval, live-payment approval, or certification;
- treats sandbox, demo, synthetic, fixture, dry-run, review, remediation,
  triage, timeline, export, or rehearsal output as real merchant approval.

## Rollback Notes

C6Sia rollback removes:

- migration 056 triage columns and constraints;
- `connector_remediation_triage_recorded` audit event type;
- the operator triage route and queue triage filter;
- OpenAPI C6Sia schemas/path additions;
- `commerce-connector-remediation-triage-c6sia.test.ts`;
- this internal note and the C6Sia guide paragraph.

No deploy, cloud resource, production config, secret, public discovery,
checkout/payment, live provider, provider credential, merchant private API,
production allowlist, or certification action is created by this slice.

## Validation

Focused validation for C6Sia:

```bash
npm --prefix apps/auth-service test -- commerce-connector-dry-run-c6r.test.ts commerce-connector-dry-run-review-c6sa.test.ts commerce-connector-remediation-c6sg.test.ts commerce-connector-remediation-queue-c6sh.test.ts commerce-connector-remediation-triage-c6sia.test.ts commerce-openapi.test.ts
npm --prefix apps/auth-service run typecheck
node scripts/commerce-c6oe-preview-conformance-gate.mjs --mode pr
git diff --check origin/main...HEAD
```

Focused scans must cover secrets/private details, production config or allowlist
assignments, public discovery enablement, checkout/payment enablement, live
payment/live Plural/provider credential enablement, certification claims, direct
provider calls, direct merchant private API calls, AgenticOrg direct execution,
and outbound sync enablement.
