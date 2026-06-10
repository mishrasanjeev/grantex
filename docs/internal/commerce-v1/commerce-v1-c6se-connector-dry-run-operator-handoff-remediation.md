# Commerce V1 C6Se - Connector Dry-Run Operator Handoff And Remediation

C6Se extends the C6Sc/C6Sd portal evidence packet with a local operator handoff
summary and a self-serve remediation workflow. It is portal, docs, and test
work only. It remains internal preview, sandbox-only, non-live,
non-publication, non-certifying, and non-enabling.

C6Se does not add backend routes, migrations, workflows, workers, credentials,
outbound sync, production connector setup, public discovery, checkout/payment
behavior, live payment behavior, provider calls, merchant private API calls,
production allowlists, or certification claims.

## Traceability Checklist

| Requirement | Files | Tests | Guardrails | Status |
| --- | --- | --- | --- | --- |
| Local operator sandbox handoff summary | `apps/portal/src/pages/commerce/CommerceOnboarding.tsx` | `CommerceDashboard.test.tsx` | Derived only from C6R dry-run, C6Sa review, and C6Sd packet summaries | Implemented |
| Self-serve remediation workflow | `CommerceOnboarding.tsx` | `CommerceDashboard.test.tsx` | Pending/blocked items do not enable connectors or approve launch | Implemented |
| Redacted JSON/Markdown export content | `CommerceOnboarding.tsx` | `CommerceDashboard.test.tsx` | Export excludes raw rows, product titles, credentials, private URLs, provider metadata, checkout/payment artifacts, production config, allowlists, and customer data | Implemented |
| Merchant/operator guide update | `docs/guides/commerce-v1-merchant-operator-guide.mdx` | Doc review | Handoff and remediation remain local/internal evidence only | Implemented |

## Operator Handoff

The portal derives an `operator_handoff` section when a connector dry-run
evidence packet exists. The handoff has three statuses:

- `ready`: the C6Sd packet is `ready_for_sandbox_followup`.
- `needs_operator_review`: operator review or warning review is still pending.
- `blocked`: dry-run blockers, unsafe packet checks, or a blocked review status
  must be remediated first.

A `ready` handoff only permits an internal sandbox follow-up conversation. It
does not approve production launch, outbound connector sync, merchant private
API execution, public discovery, checkout/payment creation, live providers,
live Plural, production allowlists, public protocol publication, or
certification.

## Self-Serve Remediation Workflow

The portal derives a `remediation_workflow` from:

- C6R dry-run blockers and warnings;
- C6Sd packet checklist items with `pending` or `blocked` status;
- C6Sa review states, including `pending_operator_review`, `needs_changes`,
  and `blocked`.

The workflow status is:

- `complete`: no local remediation items remain before sandbox follow-up.
- `pending_operator_review`: operator review or warning review is still needed.
- `blocked`: dry-run, packet, or review blockers require remediation.

When an operator records `needs_changes` or `blocked`, the portal keeps the
handoff blocked and marks `requires_rerun` so the merchant can adjust the local
manual/CSV snapshot and rerun the sandbox dry-run. This is still a dry-run
workflow; it does not create or update a live catalog.

## Export Contents

C6Se JSON and Markdown exports include:

- operator handoff status, next actor, allowed sandbox follow-up steps, blocked
  next steps, and audit references;
- self-serve remediation workflow status, counts, steps, owners, and evidence
  sources;
- fixed non-enabling controls and non-approval statements.

Exports remain redacted. They exclude raw rows, raw files, raw merchant-system
responses, normalized product titles, credentials, tokens, provider metadata,
private API URLs, checkout URLs, payment identifiers, production config values,
concrete allowlists, customer data, and secret material.

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

C6Se is portal/docs/test only. Roll back by removing:

- the local `operator_handoff` and `remediation_workflow` additions in
  `CommerceOnboarding.tsx`;
- the related `CommerceDashboard.test.tsx` assertions;
- this internal note and the C6Se guide section.

No runtime API, route, migration, worker, production config, public discovery,
checkout/payment, live payment, provider credential, production allowlist,
cloud resource, or deploy workflow action is created by this slice.

## Validation

Focused validation for C6Se:

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
