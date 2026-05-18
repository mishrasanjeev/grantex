# Grantex Commerce V1 Merchant Discovery Approval Intake Template

Status: reusable intake template only
Scope: future human artifact intake for one named merchant read-only Commerce
discovery review
Production changes authorized by this template: none
Discovery or runtime enablement authorized by this template: none
Merchant approval granted by this template: none

Use this template to collect approval artifacts for a future Grantex read-only
production Commerce discovery review. This template does not approve a
merchant, approve configuration, set an allowlist value, or approve a
production rollout. Placeholders are not approval.

## Merchant Placeholder Fields

| Field | Intake value | Reviewer notes |
| --- | --- | --- |
| Merchant identifier | `<MERCHANT_ID_PENDING_APPROVAL>` | Pending |
| Public display name | `<MERCHANT_PUBLIC_NAME_PENDING_APPROVAL>` | Pending |
| Legal or entity reference | `<MERCHANT_LEGAL_ENTITY_PENDING_APPROVAL>` | Pending |
| Public category | `<MERCHANT_CATEGORY_PENDING_APPROVAL>` | Pending |

## Approval Artifact Intake

| Artifact | Evidence reference | Approver | Date | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| Merchant owner approval | `<ARTIFACT_REFERENCE_PENDING>` | `<APPROVER_NAME_PENDING>` | `<APPROVAL_DATE_PENDING>` | Pending | Merchant owner has not approved this packet. |
| Legal/compliance approval | `<ARTIFACT_REFERENCE_PENDING>` | `<APPROVER_NAME_PENDING>` | `<APPROVAL_DATE_PENDING>` | Pending | Legal and compliance review remains pending. |
| Product wording approval | `<ARTIFACT_REFERENCE_PENDING>` | `<APPROVER_NAME_PENDING>` | `<APPROVAL_DATE_PENDING>` | Pending | Wording review remains pending. |
| Security approval | `<ARTIFACT_REFERENCE_PENDING>` | `<APPROVER_NAME_PENDING>` | `<APPROVAL_DATE_PENDING>` | Pending | Non-secret metadata, issuer/JWKS, cache, rate-limit, and rollback review remains pending. |
| Ops/on-call/support approval | `<ARTIFACT_REFERENCE_PENDING>` | `<APPROVER_NAME_PENDING>` | `<APPROVAL_DATE_PENDING>` | Pending | Support, on-call, monitoring, incident, and rollback ownership remain pending. |
| Backup/RPO approval | `<ARTIFACT_REFERENCE_PENDING>` | `<APPROVER_NAME_PENDING>` | `<APPROVAL_DATE_PENDING>` | Pending | Backup and recovery posture review remains pending. |
| AgenticOrg dependency approval | `<ARTIFACT_REFERENCE_PENDING>` | `<APPROVER_NAME_PENDING>` | `<APPROVAL_DATE_PENDING>` | Pending | AgenticOrg dependency approval remains pending. |

## Public Discovery Profile Review

| Profile field | Proposed value | Required review | Status |
| --- | --- | --- | --- |
| Display name | `<MERCHANT_PUBLIC_NAME_PENDING_APPROVAL>` | Merchant owner, legal/compliance, product wording | Pending |
| Legal/entity reference | `<MERCHANT_LEGAL_ENTITY_PENDING_APPROVAL>` | Merchant owner, legal/compliance | Pending |
| Category | `<MERCHANT_CATEGORY_PENDING_APPROVAL>` | Merchant owner, legal/compliance, product wording | Pending |
| Description | `<PUBLIC_DESCRIPTION_PENDING_APPROVAL>` | Legal/compliance, product wording | Pending |
| Supported capabilities | `<SUPPORTED_CAPABILITIES_PENDING_APPROVAL>` | Security, product wording | Pending |
| Support contact | `<SUPPORT_CONTACT_PENDING_APPROVAL>` | Ops/support, legal/compliance | Pending |
| Escalation path | `<ESCALATION_PATH_PENDING_APPROVAL>` | Ops/on-call/support | Pending |
| Issuer/JWKS references | `<ISSUER_JWKS_REFERENCE_PENDING_APPROVAL>` | Security | Pending |
| Discovery posture wording | `<DISCOVERY_POSTURE_WORDING_PENDING_APPROVAL>` | Security, product wording | Pending |
| No-go wording | `<NO_GO_WORDING_PENDING_APPROVAL>` | Security, legal/compliance, product wording | Pending |

## Required Evidence Intake

| Evidence | Reference | Status | Notes |
| --- | --- | --- | --- |
| C5C deployed gate evidence | `<EVIDENCE_REFERENCE_PENDING>` | Pending | Confirms the narrow discovery gate exists and remains fail-closed. |
| C5D rollout plan | `<EVIDENCE_REFERENCE_PENDING>` | Pending | Confirms rollout plan and rollback controls. |
| C5E named merchant approval package | `<EVIDENCE_REFERENCE_PENDING>` | Pending | Confirms approval package exists and still requires human completion. |
| C5F artifact checklist | `<EVIDENCE_REFERENCE_PENDING>` | Pending | Confirms this intake maps to the current checklist. |
| Approved public payload preview | `<EVIDENCE_REFERENCE_PENDING>` | Pending | Must contain only reviewed non-secret public metadata. |
| No-go checklist | `<EVIDENCE_REFERENCE_PENDING>` | Pending | Must show no blocking condition is present. |
| Rollback checklist | `<EVIDENCE_REFERENCE_PENDING>` | Pending | Must name rollback owner and steps to hide discovery. |
| Read-only smoke checklist | `<EVIDENCE_REFERENCE_PENDING>` | Pending | Must cover approved merchant, missing merchant, non-allowlisted merchant, cache headers, and marker scans. |

## Ownership Intake

| Role | Owner | Date | Status |
| --- | --- | --- | --- |
| Rollback owner | `<APPROVER_NAME_PENDING>` | `<APPROVAL_DATE_PENDING>` | Pending |
| Read-only smoke owner | `<APPROVER_NAME_PENDING>` | `<APPROVAL_DATE_PENDING>` | Pending |
| Support owner | `<APPROVER_NAME_PENDING>` | `<APPROVAL_DATE_PENDING>` | Pending |
| Incident escalation owner | `<APPROVER_NAME_PENDING>` | `<APPROVAL_DATE_PENDING>` | Pending |
| Evidence retention owner | `<APPROVER_NAME_PENDING>` | `<APPROVAL_DATE_PENDING>` | Pending |

## Decision

| Decision state | Selected | Meaning |
| --- | --- | --- |
| Not approved | Yes | Required artifacts, owners, and reviews are not complete. |
| Approved for internal review only | No | Metadata may be reviewed internally, but not published. |
| Approved for public read-only discovery | No | Metadata may be used only in a later separately approved rollout. |

## Hard Blockers

- Missing named merchant approval remains a hard blocker.
- No config value is approved by this intake.
- No allowlist value is approved by this intake.
- No production rollout is approved by this intake.
- Completed intake still requires a separate rollout approval.
- AgenticOrg public commerce discovery remains hidden pending Grantex
  read-only smoke and separate AgenticOrg approval.
