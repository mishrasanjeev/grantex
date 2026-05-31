# Commerce V1 C5N Artifact Collection Execution Packet

Status: planning only
Date: 2026-05-26
Scope: human-facing real merchant artifact collection packet for Commerce V1
read-only discovery intake
Production changes made by this packet: none
Production Commerce V1 changed by this packet: no
Read-only discovery changed by this packet: no
Merchant allowlist value approved by this packet: no
Checkout or payment creation changed by this packet: no
Live payment path changed by this packet: no
Live Plural path changed by this packet: no
Named merchant approved by this packet: no
Secrets inspected or changed: no

This packet gives humans a repo-safe way to gather real merchant approval
artifacts outside the repository. It does not approve a merchant, approve
production discovery, approve an allowlist value, or authorize any rollout.

## Current State

- Grantex C5M is merged at
  `5bca9d65ae8b8add1b3deb30c834f9cd2d8fc158`.
- AgenticOrg C5M is merged at
  `60428b535cbd45777977d1ea6cbfd8bdb72f0774`.
- Decision state: not ready.
- No real merchant is approved.
- No allowlist value is approved.
- No public discovery is enabled.
- Grantex production read-only discovery remains fail-closed.
- AgenticOrg public commerce discovery remains gated.
- C5I and C5J synthetic data remains internal, local, and smoke-only.
- Synthetic data is not production approval.

## Human-Facing Collection Instructions

- Collect private approval artifacts outside the repository.
- Keep private contracts, private contacts, signed approval records, pricing
  terms, customer data, secrets, and sensitive business details outside the
  repository.
- The repository may receive only public-safe summaries and non-secret private
  reference labels.
- Placeholder values are not approval.
- Completing this packet does not enable rollout.
- Completing this packet does not approve public discovery, an allowlist value,
  Commerce V1, checkout, payment creation, live payments, or live Plural.
- A separate readiness review and a separate rollout approval remain required
  before any future config or allowlist proposal.

## Placeholder-Only Artifact Packet

### Merchant Identity Section

| Field | Placeholder |
| --- | --- |
| Approved public merchant ID or non-secret approval reference | `<MERCHANT_ID_PENDING_APPROVAL>` |
| Approved public display name | `<MERCHANT_PUBLIC_NAME_PENDING_APPROVAL>` |
| Approved public category | `<MERCHANT_CATEGORY_PENDING_APPROVAL>` |
| Approved public discovery description | `<MERCHANT_DISCOVERY_DESCRIPTION_PENDING_APPROVAL>` |
| Legal/entity reference, if public-safe or reference-only | `<LEGAL_ENTITY_REFERENCE_PENDING_APPROVAL>` |

### Public Payload Preview Section

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
```

### Approval Artifact Reference Section

| Approval | Repo-safe reference placeholder | Status |
| --- | --- | --- |
| Merchant owner | `<PRIVATE_APPROVAL_REFERENCE_PENDING>` | Pending |
| Legal/compliance | `<PRIVATE_APPROVAL_REFERENCE_PENDING>` | Pending |
| Product wording | `<PRIVATE_APPROVAL_REFERENCE_PENDING>` | Pending |
| Security | `<PRIVATE_APPROVAL_REFERENCE_PENDING>` | Pending |
| Ops/on-call/support | `<PRIVATE_APPROVAL_REFERENCE_PENDING>` | Pending |
| Backup/RPO | `<PRIVATE_APPROVAL_REFERENCE_PENDING>` | Pending |
| AgenticOrg dependency | `<PRIVATE_APPROVAL_REFERENCE_PENDING>` | Pending |

### Owner Assignment Section

| Owner role | Repo-safe placeholder |
| --- | --- |
| Rollback owner | `<ROLLBACK_OWNER_PENDING>` |
| Read-only smoke owner | `<READ_ONLY_SMOKE_OWNER_PENDING>` |
| Evidence retention owner | `<EVIDENCE_RETENTION_OWNER_PENDING>` |

### Safety Review Section

| Review | Placeholder result |
| --- | --- |
| Secret and private-detail scan | `<SECRET_PRIVATE_DETAIL_SCAN_PENDING>` |
| Overclaim scan | `<OVERCLAIM_SCAN_PENDING>` |
| Merchant ID and name review | `<MERCHANT_ID_NAME_REVIEW_PENDING>` |
| Synthetic production-candidate scan | `<SYNTHETIC_ID_PRODUCTION_CANDIDATE_SCAN_PENDING>` |
| Public payload preview review | `<PUBLIC_PAYLOAD_PREVIEW_REVIEW_PENDING>` |

### Decision State Section

| Field | Current value |
| --- | --- |
| Merchant identity status | Not ready |
| Approval artifact status | Not ready |
| Payload preview status | Not ready |
| Safety scan status | Not ready |
| Owner assignment status | Not ready |
| Decision state | Not ready |

## Repo-Safe Summary Fields Humans May Later Provide

- Approved public merchant ID or a non-secret reference authorizing it.
- Approved public display name.
- Approved public category.
- Approved public discovery description.
- Non-secret private approval references.
- Public-safe owner role labels, if approved for repository storage.
- Public payload preview summary.
- Secret/private-detail scan result summary.
- Overclaim scan result summary.
- Merchant ID/name review summary.
- Synthetic production-candidate scan result summary.

## Explicit Rejected Material

Do not place any of this material in the repository:

- Private contracts.
- Private contacts.
- Signed approval records.
- Pricing terms.
- Customer data.
- Secrets.
- Tokens, passports, or JWTs.
- Idempotency keys.
- Webhook secrets.
- Provider credentials.
- Raw payloads.
- DB or Redis URLs.
- Private keys.
- Production config values.
- Live-payment, live-Plural, or provider credential claims.
- Certification or readiness claims.
- Synthetic IDs as production candidates.

## Safety Scan Commands For Future Public-Safe Summaries

Run these commands only against future public-safe summary files proposed for
repository storage. Replace `<SUMMARY_FILE>` with the reviewed file path.

```powershell
rg -n -i "<SECRET_OR_PROVIDER_CREDENTIAL_PATTERN>" <SUMMARY_FILE>
rg -n -i "<PRIVATE_MERCHANT_DETAIL_PATTERN>" <SUMMARY_FILE>
rg -n -i "<READINESS_CERTIFICATION_OR_LIVE_PAYMENT_OVERCLAIM_PATTERN>" <SUMMARY_FILE>
rg -n -i "<PRODUCTION_LOOKING_MERCHANT_ID_OR_REALISTIC_NAME_PATTERN>" <SUMMARY_FILE>
rg -n -i "<SYNTHETIC_ID_PRODUCTION_CANDIDATE_PATTERN>" <SUMMARY_FILE>
git diff --check
```

## Stop Conditions

Stop and do not prepare a readiness or rollout proposal if any condition below
is true:

- Real merchant approval is missing.
- Private artifact content appears in the repository.
- Any secret appears in the repository.
- Production config or allowlist values are included.
- Broad `COMMERCE_V1_ENABLED` is requested.
- Checkout, payment creation, live payment, live Plural, or payment-provider
  path is requested.
- AgenticOrg public discovery is requested before Grantex read-only smoke
  passes and separate AgenticOrg approval exists.
- Any required scan fails.
- Any synthetic ID is proposed for production.

## Explicit Non-Approval

- This packet does not approve a merchant.
- This packet does not approve production discovery.
- This packet does not approve a production allowlist value.
- This packet does not enable `COMMERCE_PUBLIC_DISCOVERY_ENABLED`.
- This packet does not set `COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST`.
- This packet does not enable Commerce V1.
- This packet does not enable checkout or payment creation.
- This packet does not enable live payments.
- This packet does not enable live Plural.
- This packet does not enable AgenticOrg public commerce discovery.
- This packet does not treat synthetic data as production approval.
