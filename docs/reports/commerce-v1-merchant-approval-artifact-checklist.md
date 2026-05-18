# Grantex Commerce V1 Merchant Approval Artifact Checklist

Status: planning checklist only
Date: 2026-05-18
Scope: artifact collection for a future named merchant read-only production
Commerce discovery review
Production changes made by this checklist: none
Production Commerce V1 enabled by this checklist: no
Read-only discovery enabled by this checklist: no
Checkout or payment creation enabled by this checklist: no
Live payments enabled by this checklist: no
Live Plural enabled by this checklist: no
Named merchant approved by this checklist: no
Config values approved by this checklist: no
Secrets inspected or changed: no

This checklist collects the artifacts a human review group must complete before
any later proposal can request Grantex read-only production Commerce discovery
for one named merchant. It does not approve a merchant, approve configuration,
or authorize a production rollout.

## Placeholder Rules

All merchant and approver fields in this packet are placeholders. They are not
approval, and they must not be copied into production configuration.

| Placeholder | Required meaning |
| --- | --- |
| `<MERCHANT_ID_PENDING_APPROVAL>` | Merchant identifier pending human approval. |
| `<MERCHANT_PUBLIC_NAME_PENDING_APPROVAL>` | Public merchant display name pending human approval. |
| `<MERCHANT_LEGAL_ENTITY_PENDING_APPROVAL>` | Legal or entity reference pending human approval. |
| `<MERCHANT_CATEGORY_PENDING_APPROVAL>` | Public category label pending human approval. |
| `<APPROVER_NAME_PENDING>` | Named human approver pending assignment. |
| `<APPROVAL_DATE_PENDING>` | Approval date pending signoff. |

## Artifact Collection Checklist

| Artifact | Required evidence | Owner placeholder | Status |
| --- | --- | --- | --- |
| Merchant owner approval | Written approval that `<MERCHANT_ID_PENDING_APPROVAL>` and `<MERCHANT_PUBLIC_NAME_PENDING_APPROVAL>` may appear in reviewed read-only discovery metadata. | `<APPROVER_NAME_PENDING>` | Pending |
| Legal/compliance approval | Review of merchant identity, entity reference, category, consent wording, payment-control wording, and public exposure posture. | `<APPROVER_NAME_PENDING>` | Pending |
| Product wording approval | Review that all public text avoids readiness, certification, provider, checkout, payment, live payment, and live Plural overclaims. | `<APPROVER_NAME_PENDING>` | Pending |
| Security approval | Review that payload fields are non-secret, issuer/JWKS references are public verification metadata, cache headers are conservative, and rollback hides discovery. | `<APPROVER_NAME_PENDING>` | Pending |
| Ops/on-call/support approval | Named support path, on-call owner, monitoring owner, rollback owner, and incident escalation owner. | `<APPROVER_NAME_PENDING>` | Pending |
| Backup/RPO approval | Confirmation that read-only discovery rollout and rollback do not weaken backup, recovery point, or recovery time posture. | `<APPROVER_NAME_PENDING>` | Pending |
| AgenticOrg dependency approval | Confirmation that AgenticOrg public commerce discovery remains hidden until Grantex read-only smoke passes and a separate AgenticOrg approval exists. | `<APPROVER_NAME_PENDING>` | Pending |

## Public Discovery Profile Fields Requiring Review

Every public field must be explicitly reviewed. If a field is incomplete,
unreviewed, or rejected, the rollout remains blocked.

| Field | Placeholder or posture | Required reviewers |
| --- | --- | --- |
| Display name | `<MERCHANT_PUBLIC_NAME_PENDING_APPROVAL>` | Merchant owner, product wording, legal/compliance |
| Legal/entity reference | `<MERCHANT_LEGAL_ENTITY_PENDING_APPROVAL>` or omitted | Merchant owner, legal/compliance |
| Category | `<MERCHANT_CATEGORY_PENDING_APPROVAL>` | Merchant owner, product wording, legal/compliance |
| Description | Placeholder-free approved public wording only | Product wording, legal/compliance |
| Supported capabilities | Read-only discovery metadata only; no checkout or payment creation promise | Product wording, security |
| Support contact | Approved public support channel only | Ops/support, legal/compliance |
| Escalation path | Approved public or internal escalation reference, as applicable | Ops/on-call/support |
| Issuer/JWKS references | Public verification references only | Security |
| Discovery posture wording | Must say read-only discovery only and separate approval required for any broader rollout | Product wording, security |
| No-go wording | Must clearly block broad Commerce V1, checkout/payment creation, live payments, live Plural, provider credentials, and overclaims | Security, product wording, legal/compliance |

## Required Evidence Packet

The future approval record must attach or link these artifacts before any
rollout request can proceed:

| Evidence | Required status |
| --- | --- |
| C5C deployed gate evidence | Confirm deployed narrow discovery gate remains fail-closed until explicitly enabled later. |
| C5D rollout plan | Confirm the rollout plan records config names only, no values, and keeps the merchant allowlist blocker hard-blocking. |
| C5E named merchant approval package | Confirm the approval package is complete and all placeholders are replaced by reviewed human-entered values before rollout approval. |
| Approved public payload preview | Reviewed preview containing only non-secret public metadata for `<MERCHANT_ID_PENDING_APPROVAL>`. |
| No-go checklist | Completed checklist showing no blocking condition is present. |
| Rollback checklist | Named rollback owner and verified steps to hide discovery again. |
| Read-only smoke checklist | Planned GET-only checks for health, JWKS, approved merchant discovery, missing merchant refusal, non-allowlisted merchant refusal, cache headers, and marker scans. |

## Decision States

One decision must be selected by authorized humans later. Until that happens,
the decision is not approved.

| Decision | Meaning | Production rollout permitted |
| --- | --- | --- |
| Not approved | Merchant artifacts are missing, incomplete, rejected, or still placeholder-only. | No |
| Approved for internal review only | Merchant metadata can be reviewed internally but not published publicly. | No |
| Approved for public read-only discovery | Merchant metadata can be used in a later approved read-only discovery rollout. | Not by this checklist; a separate rollout approval is still required |

Selected decision: Not approved

Reason: `<APPROVAL_REASON_PENDING>`

## No-Go Conditions

Do not proceed if any condition below is true:

- Named merchant owner approval is missing.
- The artifact packet still contains unresolved merchant placeholders.
- Broad `COMMERCE_V1_ENABLED` would be required.
- Any checkout or payment route would become enabled.
- A live payment or live Plural flag would be true.
- Provider credentials would be exposed or referenced as public metadata.
- Public wording would imply readiness, certification, external pilot approval,
  live payment approval, live Plural approval, or provider approval.
- AgenticOrg public commerce discovery would be enabled before Grantex
  read-only smoke passes.
- Rollback owner, read-only smoke owner, support owner, incident escalation
  owner, or evidence retention owner is missing.

## Ownership Fields

These ownership rows must be completed by named humans before a later rollout
request can be approved.

| Role | Owner | Date | Notes |
| --- | --- | --- | --- |
| Rollback owner | `<APPROVER_NAME_PENDING>` | `<APPROVAL_DATE_PENDING>` | `<APPROVAL_NOTE_PENDING>` |
| Read-only smoke owner | `<APPROVER_NAME_PENDING>` | `<APPROVAL_DATE_PENDING>` | `<APPROVAL_NOTE_PENDING>` |
| Support owner | `<APPROVER_NAME_PENDING>` | `<APPROVAL_DATE_PENDING>` | `<APPROVAL_NOTE_PENDING>` |
| Incident escalation owner | `<APPROVER_NAME_PENDING>` | `<APPROVAL_DATE_PENDING>` | `<APPROVAL_NOTE_PENDING>` |
| Evidence retention owner | `<APPROVER_NAME_PENDING>` | `<APPROVAL_DATE_PENDING>` | `<APPROVAL_NOTE_PENDING>` |

## AgenticOrg Dependency

AgenticOrg commerce public discovery remains hidden until Grantex read-only
discovery is approved for a named merchant and smoke-tested successfully.

AgenticOrg requires separate approval before enabling
`AGENTICORG_COMMERCE_PUBLIC_DISCOVERY_ENABLED`. This Grantex checklist does not
approve that AgenticOrg setting.

## Explicit Status

- No merchant is approved by this packet.
- Placeholders are not approval.
- No config value is approved by this packet.
- No production rollout is approved by this packet.
- `COMMERCE_PUBLIC_DISCOVERY_ENABLED` remains disabled unless a later approved
  rollout changes it.
- `COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST` remains unset unless a later
  approved rollout changes it.
- `COMMERCE_V1_ENABLED` remains outside this read-only discovery packet and
  must not be enabled for this path.
