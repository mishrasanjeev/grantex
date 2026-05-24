> **Internal artifact — not public marketing or compliance evidence.**
> This file was relocated from `docs/reports/` to `docs/internal/commerce-v1/`
> on 2026-05-24 to mark it as operator-internal documentation. It is
> excluded from the public Mintlify navigation (`docs/docs.json`). Do
> not link this file from any public marketing page or external sales
> material. See `docs/reports/enterprise-readiness-brutal-review-2026-05-24.md`
> item P0-5 for the audit context.

# Grantex Commerce V1 Named Merchant Discovery Approval Package

Status: planning template only
Date: 2026-05-18
Scope: named merchant approval package for a future read-only production Commerce discovery rollout
Production changes made by this package: none
Production Commerce V1 enabled by this package: no
Read-only discovery enabled by this package: no
Checkout or payment creation enabled by this package: no
Live payments enabled by this package: no
Live Plural enabled by this package: no
Named production merchant approved by this package: no
Secrets inspected or changed: no

This package is a template for collecting approval of a named merchant public
discovery profile. It does not approve a merchant, enable discovery, or set
production configuration.

## Current Blocker

No named production merchant is approved for public read-only Commerce
discovery.

Until a complete approval record exists, the production read-only discovery
rollout remains blocked. Placeholder entries below are not approval records and
must not be copied into production configuration.

Required placeholder syntax:

| Placeholder | Meaning |
| --- | --- |
| `<MERCHANT_ID_PENDING_APPROVAL>` | Merchant identifier to be approved later. |
| `<MERCHANT_PUBLIC_NAME_PENDING_APPROVAL>` | Public-facing merchant display name to be approved later. |
| `<MERCHANT_LEGAL_NAME_PENDING_APPROVAL>` | Legal merchant name to be approved later if it is intended for public metadata. |
| `<APPROVER_NAME_PENDING>` | Human approver name to be filled during an approval process. |
| `<APPROVAL_DATE_PENDING>` | Approval date to be filled only after signoff. |
| `<ROLLBACK_OWNER_PENDING>` | Named rollback owner to be filled before launch. |

## Required Merchant Approval Artifacts

The approval packet for a future merchant must include all artifacts below:

| Artifact | Required content |
| --- | --- |
| Merchant owner approval | Confirmation that the merchant owner approves public read-only discovery metadata for `<MERCHANT_ID_PENDING_APPROVAL>`. |
| Public profile field review | Approved values for every field listed in the profile field table below. |
| Product wording approval | Confirmation that public status and capability language does not imply launch readiness. |
| Legal/compliance approval | Confirmation that merchant identity, consent wording, and payment-control wording are acceptable for public metadata. |
| Security approval | Confirmation that payload content is non-secret, issuer/JWKS references are public, cache/rate-limit posture is acceptable, and rollback is verified. |
| Operations approval | On-call owner, support path, monitoring owner, rollback owner, and evidence retention owner. |
| AgenticOrg dependency approval | Confirmation that AgenticOrg remains hidden until Grantex read-only smoke passes and a separate approval exists. |

## Merchant Profile Fields Requiring Approval

The future public discovery profile must be reviewed field by field. If a field
is not approved, it must be omitted or the rollout must remain blocked.

| Field or section | Placeholder or required posture | Required reviewers |
| --- | --- | --- |
| `merchant_id` | `<MERCHANT_ID_PENDING_APPROVAL>` | Merchant owner, security, operations |
| `display_name` | `<MERCHANT_PUBLIC_NAME_PENDING_APPROVAL>` | Merchant owner, product wording, legal/compliance |
| `legal_name` | `<MERCHANT_LEGAL_NAME_PENDING_APPROVAL>` or omitted | Merchant owner, legal/compliance |
| `category_preset` | Approved generic category only | Product wording, legal/compliance |
| `verification_status` | Must not imply certification or readiness | Product wording, legal/compliance |
| `environment` | Must clearly indicate read-only discovery posture | Product wording, security |
| `default_currency` | Public non-secret currency metadata only | Merchant owner, legal/compliance |
| `country_code` | Public non-secret country metadata only | Merchant owner, legal/compliance |
| Capability metadata | Read-only discovery only; no checkout/payment enablement claim | Security, product wording |
| MCP transport metadata | Metadata only; no runtime tool-call enablement claim | Security |
| REST endpoint metadata | Metadata only; no checkout/payment creation claim | Security, product wording |
| Issuer/JWKS references | Public verification references only | Security |
| Required scopes | Descriptive only; must not imply live checkout availability | Security, product wording |

## Wording Review Checklist

The public profile and surrounding documentation must avoid all claims below:

- Production-ready.
- Live-payment-ready.
- Live-Plural-ready.
- External-pilot-ready.
- AP2 certification.
- UCP certification.
- ACP certification.
- Provider certification.
- Plural certification.
- Any equivalent wording that implies public checkout/payment launch approval.

Approved wording must say:

- Discovery is read-only metadata.
- Checkout and payment creation are not enabled by the discovery gate.
- Live payments are not enabled.
- Live Plural is not enabled.
- Provider credentials are not exposed.
- External pilot or live rollout requires separate approvals.

## Security Review Checklist

Security approval must confirm:

- The discovery payload contains no bearer tokens, passports, idempotency key
  values, webhook secrets, provider credentials, raw payloads, DB/Redis URLs,
  private keys, or secret values.
- Issuer and JWKS references are public verification metadata only.
- Cache headers are conservative for gated public metadata.
- Rate-limit posture is acceptable for unauthenticated public GET requests.
- Missing or non-approved merchant selectors fail closed.
- The rollback path hides discovery without rotating secrets.
- Evidence records only endpoint names, HTTP status, latency, error/blocker
  codes, headers, marker booleans, and redacted hashes.

## Operations Review Checklist

Operations approval must confirm:

- On-call owner: `<APPROVER_NAME_PENDING>`.
- Support owner: `<APPROVER_NAME_PENDING>`.
- Monitoring owner: `<APPROVER_NAME_PENDING>`.
- Rollback owner: `<ROLLBACK_OWNER_PENDING>`.
- Evidence retention owner: `<APPROVER_NAME_PENDING>`.
- Rollback can be completed by disabling read-only discovery configuration and
  clearing the merchant allowlist configuration.
- No production secrets, provider credentials, checkout/payment settings, live
  payment settings, or live Plural settings are changed by this approval.

## AgenticOrg Dependency Gate

AgenticOrg must remain hidden until Grantex read-only smoke passes.

The AgenticOrg public commerce discovery gate is separate and requires separate
approval after Grantex read-only discovery is approved, enabled, and
smoke-tested.

Required AgenticOrg posture:

1. AgenticOrg public commerce discovery remains disabled before Grantex
   read-only rollout.
2. AgenticOrg public commerce discovery remains disabled during Grantex
   read-only rollout.
3. AgenticOrg public commerce discovery remains disabled after Grantex
   read-only rollout unless a separate AgenticOrg approval record is signed.

## Exact Config Names

This package records config names only, not values:

- `COMMERCE_PUBLIC_DISCOVERY_ENABLED`
- `COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST`
- `AGENTICORG_COMMERCE_PUBLIC_DISCOVERY_ENABLED`

## Decision Record

One decision must be selected by authorized reviewers. Until a decision is
completed, the default decision is not approved.

| Decision | Meaning | Production rollout permitted |
| --- | --- | --- |
| Not approved | Merchant profile is incomplete, unreviewed, or rejected. | No |
| Approved for internal review only | Merchant profile may be reviewed internally but not published publicly. | No |
| Approved for public read-only discovery | Merchant profile may be used in a later approved read-only discovery rollout. | Not by this package; requires separate rollout approval |

Selected decision: Not approved

Reason: `<APPROVAL_REASON_PENDING>`

## Signoff Table

The table below uses placeholders only. It is not complete until named humans
replace the placeholders during an approval process.

| Approval gate | Approver | Date | Decision | Notes |
| --- | --- | --- | --- | --- |
| Merchant owner | `<APPROVER_NAME_PENDING>` | `<APPROVAL_DATE_PENDING>` | Pending | `<APPROVAL_NOTE_PENDING>` |
| Security | `<APPROVER_NAME_PENDING>` | `<APPROVAL_DATE_PENDING>` | Pending | `<APPROVAL_NOTE_PENDING>` |
| Legal/compliance | `<APPROVER_NAME_PENDING>` | `<APPROVAL_DATE_PENDING>` | Pending | `<APPROVAL_NOTE_PENDING>` |
| Product wording | `<APPROVER_NAME_PENDING>` | `<APPROVAL_DATE_PENDING>` | Pending | `<APPROVAL_NOTE_PENDING>` |
| Operations/on-call/support | `<APPROVER_NAME_PENDING>` | `<APPROVAL_DATE_PENDING>` | Pending | `<APPROVAL_NOTE_PENDING>` |
| Backup/RPO | `<APPROVER_NAME_PENDING>` | `<APPROVAL_DATE_PENDING>` | Pending | `<APPROVAL_NOTE_PENDING>` |
| AgenticOrg dependency | `<APPROVER_NAME_PENDING>` | `<APPROVAL_DATE_PENDING>` | Pending | `<APPROVAL_NOTE_PENDING>` |

## Future Approved-Run Prompt

Do not run this prompt until every required approval record is signed.

```text
Task: C5F approved Grantex named merchant read-only discovery rollout.

Approved:
- Enable only Grantex read-only Commerce discovery for the named approved merchant.
- Use only the narrow read-only discovery gate.
- Do not enable production Commerce V1 runtime.
- Do not enable checkout/payment creation.
- Do not enable live payments.
- Do not enable live Plural.
- Do not enable AgenticOrg commerce public discovery.
- Do not touch secrets except existing deployment references required by the normal deploy path.
- Do not run state-changing production requests.

Preconditions:
1. Confirm the named merchant approval package is complete.
2. Confirm all signoff rows are approved by named humans.
3. Confirm the approved merchant identifier replaces only:
   <MERCHANT_ID_PENDING_APPROVAL>
4. Confirm the approved public merchant name replaces only:
   <MERCHANT_PUBLIC_NAME_PENDING_APPROVAL>
5. Confirm the approved profile contains no secret values and no readiness or certification overclaims.
6. Confirm AgenticOrg public commerce discovery remains disabled.

Rollout:
1. Apply only the approved Grantex read-only discovery config names:
   - COMMERCE_PUBLIC_DISCOVERY_ENABLED
   - COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST
2. Deploy or revise only if the platform requires it for config-name changes.
3. Do not change secrets, checkout/payment settings, live payment settings, live Plural settings, or provider credentials.

Read-only smoke:
1. GET health.
2. GET JWKS.
3. GET approved merchant discovery.
4. Confirm missing or non-approved merchant discovery fails closed.
5. Confirm no provider credential, secret, live-payment, live-Plural, or overclaim markers.
6. Confirm conservative cache headers.
7. Confirm AgenticOrg public commerce discovery remains hidden.

Rollback:
1. Disable read-only discovery configuration.
2. Clear merchant allowlist configuration.
3. Deploy or revise only if required.
4. Confirm discovery fails closed.
```
