# Commerce V1 C6Sf - Connector Dry-Run Remediation Loop Rehearsal

C6Sf hardens the local portal rehearsal loop after C6Se. It lets a reviewer
see how a `needs_changes` or `blocked` connector dry-run evidence decision
moves through corrected sandbox rows, a refreshed dry-run packet, and an
operator follow-up status. It is portal, docs, and test work only. It remains
internal preview, sandbox-only, non-live, non-publication, non-certifying, and
non-enabling.

C6Sf does not add backend routes, migrations, workflows, workers, credentials,
outbound sync, production connector setup, public discovery, checkout/payment
behavior, live payment behavior, provider calls, merchant private API calls,
production allowlists, or certification claims.

## Traceability Checklist

| Requirement | Files | Tests | Guardrails | Status |
| --- | --- | --- | --- | --- |
| Capture prior operator issue | `apps/portal/src/pages/commerce/CommerceOnboarding.tsx` | `CommerceDashboard.test.tsx` | Local state only; no persistence or backend route | Implemented |
| Corrected sandbox dry-run status | `CommerceOnboarding.tsx` | `CommerceDashboard.test.tsx` | Uses existing C6R dry-run response shape only | Implemented |
| Refreshed packet handoff status | `CommerceOnboarding.tsx` | `CommerceDashboard.test.tsx` | Derived from C6Sd/C6Se packet helpers; no publication or enablement | Implemented |
| Operator follow-up status | `CommerceOnboarding.tsx` | `CommerceDashboard.test.tsx` | Accepted means sandbox follow-up only | Implemented |
| Redacted JSON/Markdown export | `CommerceOnboarding.tsx` | `CommerceDashboard.test.tsx` | Excludes raw rows, product titles, credentials, private URLs, provider metadata, checkout/payment artifacts, production config, allowlists, and customer data | Implemented |
| Merchant/operator guide update | `docs/guides/commerce-v1-merchant-operator-guide.mdx` | Doc review | Loop rehearsal remains local/internal evidence only | Implemented |

## Local Remediation Loop

The portal maintains a local `remediation_loop` section after an operator
records `needs_changes` or `blocked` for a connector dry-run review. The loop
captures only safe summary evidence:

- previous dry-run ID and review ID;
- previous review status and packet status;
- previous blocked and pending counts;
- corrected dry-run ID, status, counts, and audit references;
- refreshed packet status, handoff status, and remediation workflow status;
- operator follow-up review ID, status, decision, and audit references;
- fixed non-enabling posture.

The loop statuses are:

- `issue_captured`: a `needs_changes` or `blocked` operator decision has been
  captured locally.
- `corrected_dry_run_ready`: a later sandbox dry-run passed and refreshed the
  packet locally.
- `operator_followup_requested`: a C6Sa follow-up review request exists for the
  corrected dry-run.
- `followup_ready`: the corrected dry-run has an accepted sandbox follow-up
  decision.
- `blocked_again`: the corrected dry-run or follow-up decision is blocked.

`followup_ready` is not production approval, connector execution approval,
outbound sync approval, public discovery approval, checkout/payment approval,
live provider approval, public protocol publication, or certification.

## Evidence Export

C6Sf extends the existing C6Se JSON and Markdown export with a
`remediation_loop` section. The section is local/internal review evidence only.
It is intended to help reviewers compare the previous issue with the refreshed
packet and operator follow-up state.

The export excludes raw rows, raw files, raw merchant-system responses,
normalized product titles, credentials, tokens, provider metadata, private API
URLs, checkout URLs, payment identifiers, production config values, concrete
allowlists, customer data, and secret material.

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
- treats sandbox, demo, synthetic, fixture, dry-run, review, packet, handoff,
  remediation, export, or rehearsal output as real merchant approval.

## Rollback Notes

C6Sf is portal/docs/test only. Roll back by removing:

- the local `remediation_loop` state and export additions in
  `CommerceOnboarding.tsx`;
- the related `CommerceDashboard.test.tsx` assertions;
- this internal note and the C6Sf guide section.

No runtime API, route, migration, worker, production config, public discovery,
checkout/payment, live payment, provider credential, production allowlist,
cloud resource, or deploy workflow action is created by this slice.

## Validation

Focused validation for C6Sf:

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
