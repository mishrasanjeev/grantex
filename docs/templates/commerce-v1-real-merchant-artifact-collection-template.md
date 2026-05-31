# Commerce V1 Real Merchant Artifact Collection Template

Status: template only
Date: 2026-05-26
Scope: repo-safe placeholder template for collecting real merchant approval
artifacts outside the repository
Production changes made by this template: none
Production Commerce V1 changed by this template: no
Read-only discovery changed by this template: no
Merchant allowlist value approved by this template: no
Checkout or payment creation changed by this template: no
Live payment path changed by this template: no
Live Plural path changed by this template: no
Named merchant approved by this template: no
Secrets inspected or changed: no

Use this template to request and track human approval artifacts outside the
repository. Commit only public-safe summaries and non-secret reference labels.
Do not commit raw approvals, private contracts, private contacts, pricing
terms, customer data, provider credentials, secrets, raw payloads, production
config values, or sensitive business details.

## Placeholder Rules

- Keep every pending value as an explicit placeholder.
- Replace placeholders only after a separate human artifact review confirms
  the value is public-safe for repository use.
- A completed template is still not a production rollout approval.
- Synthetic merchant IDs, names, and payloads are never production candidates.

Required placeholders:

- `<MERCHANT_ID_PENDING_APPROVAL>`
- `<MERCHANT_PUBLIC_NAME_PENDING_APPROVAL>`
- `<MERCHANT_CATEGORY_PENDING_APPROVAL>`
- `<MERCHANT_DISCOVERY_DESCRIPTION_PENDING_APPROVAL>`
- `<LEGAL_ENTITY_REFERENCE_PENDING_APPROVAL>`
- `<PRIVATE_APPROVAL_REFERENCE_PENDING>`
- `<APPROVER_ROLE_PENDING>`
- `<APPROVER_NAME_PENDING>`
- `<APPROVAL_DATE_PENDING>`
- `<ROLLBACK_OWNER_PENDING>`
- `<READ_ONLY_SMOKE_OWNER_PENDING>`
- `<EVIDENCE_RETENTION_OWNER_PENDING>`

## Merchant Identity

| Field | Placeholder value | Repository safety rule |
| --- | --- | --- |
| Approved public merchant ID | `<MERCHANT_ID_PENDING_APPROVAL>` | Must be human-approved before any future allowlist proposal; never use a synthetic ID. |
| Approved public display name | `<MERCHANT_PUBLIC_NAME_PENDING_APPROVAL>` | Must be approved public wording, not a private alias. |
| Approved public category | `<MERCHANT_CATEGORY_PENDING_APPROVAL>` | Must be approved public wording. |
| Approved public discovery description | `<MERCHANT_DISCOVERY_DESCRIPTION_PENDING_APPROVAL>` | Must avoid checkout, payment, live-provider, certification, and readiness claims. |
| Legal/entity reference | `<LEGAL_ENTITY_REFERENCE_PENDING_APPROVAL>` | Use only a public-safe or reference-only label; do not commit contracts. |
| Support/escalation posture | `<SUPPORT_ESCALATION_POSTURE_PENDING_APPROVAL>` | Describe posture only; do not commit private contacts. |

## Human Approval Checklist

| Approval | Approver role | Approver name | Approval date | Private artifact reference | Status |
| --- | --- | --- | --- | --- | --- |
| Merchant owner | `<APPROVER_ROLE_PENDING>` | `<APPROVER_NAME_PENDING>` | `<APPROVAL_DATE_PENDING>` | `<PRIVATE_APPROVAL_REFERENCE_PENDING>` | Pending |
| Legal/compliance | `<APPROVER_ROLE_PENDING>` | `<APPROVER_NAME_PENDING>` | `<APPROVAL_DATE_PENDING>` | `<PRIVATE_APPROVAL_REFERENCE_PENDING>` | Pending |
| Product wording | `<APPROVER_ROLE_PENDING>` | `<APPROVER_NAME_PENDING>` | `<APPROVAL_DATE_PENDING>` | `<PRIVATE_APPROVAL_REFERENCE_PENDING>` | Pending |
| Security | `<APPROVER_ROLE_PENDING>` | `<APPROVER_NAME_PENDING>` | `<APPROVAL_DATE_PENDING>` | `<PRIVATE_APPROVAL_REFERENCE_PENDING>` | Pending |
| Ops/on-call/support | `<APPROVER_ROLE_PENDING>` | `<APPROVER_NAME_PENDING>` | `<APPROVAL_DATE_PENDING>` | `<PRIVATE_APPROVAL_REFERENCE_PENDING>` | Pending |
| Backup/RPO | `<APPROVER_ROLE_PENDING>` | `<APPROVER_NAME_PENDING>` | `<APPROVAL_DATE_PENDING>` | `<PRIVATE_APPROVAL_REFERENCE_PENDING>` | Pending |
| AgenticOrg dependency | `<APPROVER_ROLE_PENDING>` | `<APPROVER_NAME_PENDING>` | `<APPROVAL_DATE_PENDING>` | `<PRIVATE_APPROVAL_REFERENCE_PENDING>` | Pending |
| Rollback owner | `<APPROVER_ROLE_PENDING>` | `<ROLLBACK_OWNER_PENDING>` | `<APPROVAL_DATE_PENDING>` | `<PRIVATE_APPROVAL_REFERENCE_PENDING>` | Pending |
| Read-only smoke owner | `<APPROVER_ROLE_PENDING>` | `<READ_ONLY_SMOKE_OWNER_PENDING>` | `<APPROVAL_DATE_PENDING>` | `<PRIVATE_APPROVAL_REFERENCE_PENDING>` | Pending |
| Evidence retention owner | `<APPROVER_ROLE_PENDING>` | `<EVIDENCE_RETENTION_OWNER_PENDING>` | `<APPROVAL_DATE_PENDING>` | `<PRIVATE_APPROVAL_REFERENCE_PENDING>` | Pending |

## Public Payload Preview Placeholder Schema

```yaml
merchant_id: "<MERCHANT_ID_PENDING_APPROVAL>"
display_name: "<MERCHANT_PUBLIC_NAME_PENDING_APPROVAL>"
category: "<MERCHANT_CATEGORY_PENDING_APPROVAL>"
discovery_description: "<MERCHANT_DISCOVERY_DESCRIPTION_PENDING_APPROVAL>"
issuer_reference: "<ISSUER_REFERENCE_PENDING_APPROVAL>"
jwks_uri_reference: "<JWKS_REFERENCE_PENDING_APPROVAL>"
supported_read_only_capabilities:
  - "<READ_ONLY_CAPABILITY_PENDING_APPROVAL>"
posture:
  non_secret_metadata_only: true
  no_checkout_or_payment_creation: true
  no_live_payment_path: true
  no_live_plural_path: true
  no_provider_credentials: true
  no_certification_or_readiness_claim: true
cache_and_headers:
  cache_header_posture: "<CACHE_HEADER_POSTURE_PENDING_APPROVAL>"
  rate_limit_posture: "<RATE_LIMIT_POSTURE_PENDING_APPROVAL>"
owners:
  rollback_owner: "<ROLLBACK_OWNER_PENDING>"
  read_only_smoke_owner: "<READ_ONLY_SMOKE_OWNER_PENDING>"
  evidence_retention_owner: "<EVIDENCE_RETENTION_OWNER_PENDING>"
```

## Repo-Safe Intake Status Fields

| Field | Allowed values | Current template value |
| --- | --- | --- |
| Merchant identity status | pending, reviewed, rejected | pending |
| Approval artifact status | pending, complete, rejected | pending |
| Payload preview status | pending, reviewed, rejected | pending |
| Safety scan status | pending, passed, failed | pending |
| Owner assignment status | pending, complete, rejected | pending |
| Decision state | not ready, intake ready, rollout proposal ready, rejected | not ready |

## Explicit Rejected Material

Do not place any of this material in the repository:

- Private contracts.
- Private contacts.
- Signed approval records.
- Pricing terms.
- Customer data.
- Secrets.
- Tokens, passports, or JWTs.
- Provider credentials.
- Raw payloads.
- DB or Redis URLs.
- Production config values.
- Live-payment or live-Plural claims.
- Certification or readiness claims.
- Realistic private merchant details.
- Synthetic IDs proposed as production candidates.

## Stop Conditions

Stop collection and do not prepare a future proposal if any condition below is
true:

- Real merchant approval is missing.
- Any private material appears in the repository.
- Any secret appears in the repository.
- Any production config or allowlist value appears.
- Any synthetic ID is proposed for production.
- Any broad runtime, live payment, checkout, payment creation, or provider path
  is requested.
- AgenticOrg public discovery is requested before Grantex read-only smoke
  passes and separate AgenticOrg approval exists.

## Non-Approval

- This template does not approve a merchant.
- This template does not approve an allowlist value.
- This template does not enable public discovery.
- This template does not enable Commerce V1.
- This template does not enable checkout or payment creation.
- This template does not enable live payments or live Plural.
- This template does not treat synthetic data as production approval.
