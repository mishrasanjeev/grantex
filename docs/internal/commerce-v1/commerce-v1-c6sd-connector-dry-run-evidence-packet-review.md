# Commerce V1 C6Sd - Connector Dry-Run Evidence Packet Review

C6Sd hardens the self-serve connector dry-run evidence packet that was added in
C6Sc. It is portal, docs, and test work only. It remains internal preview,
sandbox-only, non-live, non-publication, non-certifying, and non-enabling.

C6Sd does not add backend routes, migrations, workflows, workers, credentials,
outbound sync, production connector setup, public discovery, checkout/payment
behavior, live payment behavior, provider calls, merchant private API calls,
production allowlists, or certification claims.

## Traceability Checklist

| Requirement | Files | Tests | Guardrails | Status |
| --- | --- | --- | --- | --- |
| Evidence packet schema/version | `apps/portal/src/pages/commerce/CommerceOnboarding.tsx` | `CommerceDashboard.test.tsx` | Local packet schema only; no API contract or runtime route added | Implemented |
| Operator packet review checklist | `CommerceOnboarding.tsx` | `CommerceDashboard.test.tsx` | Checklist is sandbox evidence review only | Implemented |
| Sandbox follow-up readiness summary | `CommerceOnboarding.tsx` | `CommerceDashboard.test.tsx` | Ready means sandbox follow-up only, not launch or connector execution | Implemented |
| Hardened JSON/Markdown export | `CommerceOnboarding.tsx` | `CommerceDashboard.test.tsx` | Excludes raw rows, normalized product titles, credentials, private URLs, provider metadata, checkout/payment artifacts, production config, allowlists, and customer data | Implemented |
| Operator docs | This doc and merchant/operator guide | Doc review | Stop conditions, rollback, and retention remain explicit | Implemented |

## Packet Schema

Every C6Sd export carries the local schema version:

`grantex.commerce.connector_dry_run.evidence_packet.v1`

This schema is a Grantex portal evidence packet shape. It is not a public
protocol schema, public publication artifact, provider approval, live-payment
approval, or certification claim.

## Packet Review Checklist

The portal generates a local review checklist from already-returned C6R and
C6Sa response summaries. The checklist covers:

- schema version declaration;
- dry-run passed status;
- clear dry-run blockers;
- dry-run warning review state;
- C6Sa review request presence;
- accepted sandbox-follow-up decision;
- confirmation that the review is not production approval;
- disabled public discovery, checkout/payment, live provider, live Plural,
  production allowlist, outbound sync, production connector setup, and merchant
  private API execution controls;
- redaction summary presence.

The checklist has three statuses: `pass`, `pending`, and `blocked`.

## Sandbox Follow-Up Readiness

The packet readiness summary has three values:

- `ready_for_sandbox_followup`: dry-run passed, no blockers/warnings, C6Sa
  review accepted for sandbox follow-up, and all non-enabling controls remain
  disabled.
- `needs_operator_review`: no blockers are present, but operator review or
  warning review remains pending.
- `blocked`: dry-run blockers, unsafe review status, or enabling controls are
  present.

`ready_for_sandbox_followup` does not mean production approval, production
connector setup, outbound sync approval, public discovery approval,
checkout/payment approval, live provider approval, public protocol publication,
or certification.

## Evidence Export Contents

C6Sd JSON and Markdown exports include:

- schema version;
- packet status and summary;
- operator packet review checklist;
- packet blocker and pending summaries;
- dry-run status and safe summary counts;
- review status and safe review summary when present;
- fixed non-enabling controls;
- redaction summary;
- requested/completed/review audit references.

Exports exclude raw rows, raw files, raw merchant-system responses, normalized
product titles, credentials, tokens, provider metadata, private API URLs,
checkout URLs, payment identifiers, production config values, concrete
allowlists, customer data, and secret material.

## Evidence Retention

Keep C6Sd exports in a local internal review directory only when a reviewer
needs a packet. Delete temporary exports after review unless retention is
explicitly required by an internal evidence process.

Do not commit timestamped or merchant-specific exports unless a later approved
work item says so.

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
- treats sandbox, demo, synthetic, fixture, dry-run, review, packet, export, or
  rehearsal output as real merchant approval.

## Rollback Notes

C6Sd is portal/docs/test only. Roll back by removing:

- the local packet schema, checklist, readiness summary, redaction summary, and
  export additions in `CommerceOnboarding.tsx`;
- the related `CommerceDashboard.test.tsx` assertions;
- this internal note and the C6Sd guide section.

No runtime API, route, migration, worker, production config, public discovery,
checkout/payment, live payment, provider credential, production allowlist,
cloud resource, or deploy workflow action is created by this slice.

## Validation

Focused validation for C6Sd:

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
