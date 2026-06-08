# Commerce V1 C6Sa - Connector Dry-Run Review Foundation

This document is an internal implementation note for operator review of C6R dry-run evidence.
C6Sa is sandbox-only, non-live, non-publication,
non-certifying, and non-enabling.

It does not approve production launch, enable public discovery, enable
AgenticOrg public commerce discovery, enable production Commerce V1, create
checkout/payment objects, enable live payments, enable live Plural, call
payment providers, call merchant private APIs, set production allowlists, or
claim protocol certification.

## Traceability Checklist

| Requirement | Files | Tests | Guardrails | Status |
| --- | --- | --- | --- | --- |
| Tenant-scoped review request/decision model | `054_commerce_connector_dry_run_reviews.sql`, `commerce-connectors.ts` | `commerce-connector-dry-run-review-c6sa.test.ts` | Review stores summary evidence only; no raw payloads, credentials, or production fields | Implemented |
| Review requested, decision recorded, and blocked review audit events | `audit.ts`, `commerce-connectors.ts` | Route audit assertions | Audit metadata is redacted and fixed to non-enabling controls | Implemented |
| Operator-only decision route | `commerce-connectors.ts` | Merchant decision denial test | Merchant/agent callers cannot record decisions | Implemented |
| Merchant/operator read routes | `commerce-connectors.ts` | Merchant read and operator request tests | Tenant and merchant boundary enforced | Implemented |
| Sandbox evidence only posture | Migration checks, OpenAPI, guide | Migration/OpenAPI/doc tests | Not approval, not launch, not certification, no public discovery, no checkout/payment | Implemented |

## What Merchants Do One Time

1. Run the C6R local manual/CSV connector dry-run for a sandbox merchant.
2. Confirm the dry-run evidence is redacted and contains only safe summary
   counts, blockers, warnings, and capped preview rows.
3. Request C6Sa operator review for that dry-run.
4. Fix any `needs_changes` or `blocked` feedback before another sandbox review.

No credential, private API URL, live connector configuration, production
allowlist, checkout URL, payment identifier, provider metadata, raw file, or raw
merchant-system response is accepted.

## Operator Review Outcomes

C6Sa supports three decision values:

- `accepted_for_sandbox_followup`: the evidence can continue into later
  sandbox-only work. This is not production approval.
- `needs_changes`: the evidence requires public-safe remediation before another
  review.
- `blocked`: the evidence is unsafe, incomplete, stale, conflicting, or outside
  the sandbox scope.

An operator cannot accept a blocked dry-run as sandbox follow-up. The route
records a `connector_dry_run_review_blocked` audit event instead.

## Evidence Stored

The review table stores:

- tenant ID, merchant ID, and dry-run ID;
- review status and optional public-safe decision note;
- requester kind and ID;
- operator decision actor when a decision is recorded;
- redacted summary counts from the C6R dry-run;
- requested and decision audit event IDs;
- fixed non-enabling controls.

It does not store raw connector rows, raw files, private merchant payloads,
secrets, credentials, provider metadata, private API URLs, checkout/payment
artifacts, production config values, concrete allowlists, or customer data.

## Existing-System Boundary

C6Sa reviews evidence produced by Grantex. It does not connect to Shopify,
WooCommerce, Magento, custom APIs, ERP, OMS, WMS, logistics, CRM/support,
payment providers, Plural, Stripe, Pine, or merchant private APIs.

AgenticOrg never directly executes merchant private API calls. AgenticOrg
continues to consume only Grantex-owned preview and buyer discovery surfaces
after Grantex records the required sandbox evidence.

## Stop Conditions

Stop and do not proceed if any review evidence or note contains:

- secrets, tokens, JWTs, private keys, DB/Redis URLs, credentials, provider
  metadata, raw payloads, or private merchant artifacts;
- production config values, concrete allowlist values, checkout URLs, payment
  identifiers, public discovery enablement, live provider enablement, live
  Plural enablement, or checkout/payment enablement;
- claims of production approval, launch approval, public protocol publication,
  provider approval, live-payment approval, or certification;
- real merchant private API execution semantics or AgenticOrg direct execution.

## Rollback Notes

C6Sa is metadata and audit evidence only. Roll back by disabling the review
routes or reverting the migration and route changes before production use. Do
not delete audit rows in environments where audit immutability applies; write a
compensating audit event in a later reviewed slice instead.

## Validation

Focused validation for C6Sa:

```bash
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
