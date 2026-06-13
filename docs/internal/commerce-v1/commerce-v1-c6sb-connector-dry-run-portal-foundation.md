# Commerce V1 C6Sb - Credential-Free Connector Dry-Run Portal Foundation

This document is an internal implementation note for the portal UX that sits on
top of the C6R connector dry-run and C6Sa operator review APIs. C6Sb is
sandbox-only, non-live, non-publication, non-certifying, and non-enabling.

It does not collect credentials, run outbound sync, create production connector
setup, call merchant systems, call providers, enable public discovery, enable
AgenticOrg public commerce discovery, enable production Commerce V1, create
checkout/payment objects, enable live payments, enable live Plural, set
production allowlists, or approve launch.

## Traceability Checklist

| Requirement | Files | Tests | Guardrails | Status |
| --- | --- | --- | --- | --- |
| Portal API client for C6R/C6Sa routes | `apps/portal/src/api/commerce.ts` | `apps/portal/src/api/__tests__/commerce.test.ts` | Request bodies omit credential, provider, discovery, checkout, payment, and live-enable fields | Implemented |
| Credential-free portal panel | `apps/portal/src/pages/commerce/CommerceOnboarding.tsx` | `CommerceDashboard.test.tsx` | No credential entry UI, no outbound sync control, no production connector setup | Implemented |
| Dry-run evidence display | `CommerceOnboarding.tsx` | UI dry-run test | Shows counts, blockers, warnings, capped normalized preview, and non-enabling controls | Implemented |
| Operator review evidence display | `CommerceOnboarding.tsx` | UI review request/decision test | Review remains sandbox evidence only, not production approval | Implemented |
| Layman/operator docs | `docs/guides/commerce-v1-merchant-operator-guide.mdx` | Doc review | AgenticOrg boundary and stop conditions remain explicit | Implemented |

## Portal Flow

1. The merchant or operator loads a tenant-scoped sandbox merchant in the
   Commerce onboarding portal.
2. The user selects `csv` or `manual` connector type and enters a source label.
3. The user pastes local sandbox catalog rows as JSON. This is a manual snapshot
   flow; it is not a live connector and it does not call a merchant system.
4. The portal calls the C6R dry-run route and displays safe summary counts,
   fixed controls, blockers, warnings, and capped normalized preview rows.
5. The user can request C6Sa operator review for the dry-run evidence.
6. An operator can record a sandbox-only review decision:
   `accepted_for_sandbox_followup`, `needs_changes`, or `blocked`.

The portal labels the surface as credential-free sandbox evidence. It shows
explicit controls for:

- `credential_entry_enabled: false`
- `outbound_sync_enabled: false`
- `production_connector_setup: false`
- `merchant_private_api_calls: false`

## API Client Scope

The portal client calls only the existing tenant-scoped C6R/C6Sa APIs:

- `POST /v1/commerce/merchants/{merchantId}/connectors/dry-run`
- `GET /v1/commerce/merchants/{merchantId}/connectors/dry-runs/{dryRunId}`
- `POST /v1/commerce/merchants/{merchantId}/connectors/dry-runs/{dryRunId}/review-request`
- `GET /v1/commerce/merchants/{merchantId}/connectors/dry-runs/{dryRunId}/review`
- `POST /v1/commerce/merchants/{merchantId}/connectors/dry-runs/{dryRunId}/review/decision`

The dry-run request body includes only:

- connector type;
- source label;
- optional source snapshot timestamp;
- optional preview limit;
- local rows.

It does not send credentials, secrets, provider metadata, private API URLs,
public discovery flags, checkout/payment flags, live provider flags, live
Plural flags, production config values, or allowlists.

## Evidence Display

C6Sb displays redacted evidence already produced by Grantex:

- dry-run status;
- row, product, variant, would-create, would-update, would-archive, blocker,
  and warning counts;
- capped normalized product/variant preview rows;
- blocker and warning codes;
- review ID, review status, requester kind, decision, and audit reference;
- fixed controls showing sandbox-only, not-live, not-approved, public discovery
  off, checkout/payment off, live provider off, live Plural off, no production
  allowlist writing, no production approval, and no connector execution
  approval.

C6Sb does not render or store raw connector files, raw merchant-system
responses, credentials, private URLs, provider metadata, customer data,
checkout URLs, payment identifiers, production config values, concrete
allowlists, or secret material.

## AgenticOrg Boundary

AgenticOrg does not call merchant private APIs directly. This portal panel is a
Grantex operator/merchant evidence surface only. AgenticOrg continues to consume
only Grantex-owned preview and buyer discovery payloads after Grantex records
the required sandbox evidence.

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
- treats sandbox, demo, synthetic, fixture, dry-run, review, or rehearsal output
  as real merchant approval.

## Rollback Notes

C6Sb is portal and docs only. Roll back by removing:

- C6Sb portal API client helpers in `apps/portal/src/api/commerce.ts`;
- the Connector dry-run review panel in
  `apps/portal/src/pages/commerce/CommerceOnboarding.tsx`;
- C6Sb portal/API tests;
- this internal note and the C6Sb guide section.

No runtime API, route, migration, worker, production config, public discovery,
checkout/payment, live payment, provider credential, production allowlist,
cloud resource, or deploy workflow action is created by this slice.

## Validation

Focused validation for C6Sb:

```bash
npm --prefix apps/auth-service test -- commerce-connector-dry-run-c6r.test.ts commerce-connector-dry-run-review-c6sa.test.ts commerce-openapi.test.ts
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

Expected scan hits should be limited to stop-condition text, denylist regex
literals, negative assertions, or explicit disabled-control examples.
