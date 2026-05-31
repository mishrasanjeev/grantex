# Commerce V1 C5L Real Merchant Artifact Intake Checklist

Status: planning only
Date: 2026-05-26
Scope: real human merchant artifact intake checklist before any future
Commerce V1 read-only discovery allowlist or config proposal
Production changes made by this checklist: none
Production Commerce V1 changed by this checklist: no
Read-only discovery changed by this checklist: no
Merchant allowlist value approved by this checklist: no
Checkout or payment creation changed by this checklist: no
Live payment path changed by this checklist: no
Live Plural path changed by this checklist: no
Named merchant approved by this checklist: no
Secrets inspected or changed: no

This checklist defines what real human artifacts must exist before any later
rollout proposal can be prepared. It does not approve a merchant, approve
production discovery, approve a production allowlist entry, or authorize any
runtime change.

## Current State

- Grantex C5K planning is merged at
  `7a0aeec0b5b723390b76e84ac62c53927d5ef73c`.
- AgenticOrg C5K planning is merged at
  `e0382fb626bd6c92c9843d7c4fcc890274511060`.
- C5I and C5J synthetic data remains internal, local, and smoke-only.
- Synthetic data is not production approval.
- No real named merchant approval exists.
- Grantex production read-only discovery remains fail-closed.
- AgenticOrg public commerce discovery remains gated.
- Real merchant artifact intake is required before any allowlist or config
  proposal.

## Intake Rules

- Collect source artifacts from authorized humans outside the repository.
- Record only public-safe summaries and non-secret reference labels in repo.
- Do not commit private contracts, private contacts, signed approval records,
  pricing terms, customer data, raw approval messages, or sensitive business
  details.
- Do not record provider credentials, webhook secrets, idempotency keys,
  private keys, bearer tokens, database URLs, raw payloads, or production
  secret values.
- Do not use synthetic merchant IDs, names, or payloads for any production
  allowlist or rollout proposal.

## Required Human Approval Artifacts

Every artifact below must be supplied by an authorized human reviewer before
the intake can be considered complete.

| Artifact | Required evidence | Repository-safe record |
| --- | --- | --- |
| Merchant owner approval | The merchant owner approves public read-only discovery metadata for one named merchant. | Public-safe approval status and non-secret reference label only. |
| Legal/compliance approval | Legal/compliance approves merchant identity, metadata exposure, and wording posture. | Public-safe approval status and non-secret reference label only. |
| Product wording approval | Product approves the public wording and confirms no checkout, payment, live-provider, readiness, or certification claim is implied. | Public-safe approval status and non-secret reference label only. |
| Security approval | Security confirms the payload is non-secret and contains no private merchant details or provider credential path. | Public-safe approval status and non-secret reference label only. |
| Ops/on-call/support approval | Ops confirms support, monitoring, on-call, incident, and escalation posture. | Role or queue posture only; no private contacts. |
| Backup/RPO approval | Backup/RPO owner confirms read-only discovery and rollback do not weaken recovery posture. | Public-safe approval status and non-secret reference label only. |
| AgenticOrg dependency approval | Dependency owner confirms AgenticOrg remains gated until separate approval and Grantex evidence exist. | Public-safe approval status and non-secret reference label only. |
| Rollback owner approval | A rollback owner accepts responsibility for hiding read-only discovery again. | Owner role or non-secret reference label only. |
| Read-only smoke owner approval | A smoke owner accepts responsibility for future GET-only evidence collection. | Owner role or non-secret reference label only. |
| Evidence retention owner approval | An evidence owner accepts responsibility for scrubbed proof retention. | Owner role or non-secret reference label only. |

## Required Merchant Identity Fields

The intake packet must identify exactly one real merchant using reviewed
public-safe values. These values remain unapproved for any rollout until a
separate rollout proposal is reviewed.

| Field | Requirement | Repository handling |
| --- | --- | --- |
| Approved public merchant ID | Human-reviewed public identifier for one merchant. | Record only after approval; never use a synthetic ID. |
| Approved public display name | Human-reviewed public display name for the same merchant. | Record only after approval; no private aliases. |
| Approved public category | Human-reviewed public category label. | Record only after approval. |
| Approved public discovery description | Human-reviewed public read-only discovery description. | Record only after product and legal review. |
| Legal/entity reference | Public or reference-only legal/entity reference when approved. | Use non-secret reference labels only; no contracts. |
| Support/escalation posture | Approved public support and escalation posture. | No private contacts, phone numbers, emails, or personal details. |

## Required Public Payload Preview

Before any future allowlist or config proposal, reviewers must see the exact
read-only discovery payload that would be exposed. The preview must contain
only approved public-safe values and must explicitly avoid checkout, payment,
live-provider, readiness, and certification claims.

Fields requiring exact preview:

- `merchant_id`
- `display_name`
- `category`
- `public_discovery_description`
- `supported_capabilities`
- `scope_wording`
- `capability_wording`
- `issuer_reference`
- `jwks_uri_reference`
- `cache_headers`
- `rate_limit_posture`
- `support_contact_policy`
- `incident_escalation_policy`
- `rollback_owner_reference`
- `read_only_smoke_owner_reference`
- `evidence_owner_reference`

The payload preview must state:

- Checkout is out of scope.
- Payment creation is out of scope.
- Live payments are out of scope.
- Live Plural is out of scope.
- Direct provider credentials are out of scope.
- No provider certification, Plural certification, AP2 certification, UCP
  certification, ACP certification, or production readiness is claimed.
- Cache, header, and rate-limit posture is read-only and reversible.

## Required Legal And Compliance Evidence

- Approval that public metadata is non-secret.
- Approval that consent and payment wording is accurate.
- Approval that no production checkout or payment readiness is implied.
- Approval that private contracts, private contacts, pricing terms, customer
  data, and sensitive business details remain outside repositories.
- Approval that any legal/entity reference is either public-safe or
  reference-only.
- Approval that any public support posture excludes private contacts.

## Provider And Payment Limitations

- No live payments.
- No live Plural.
- No provider credentials.
- No checkout or payment creation.
- No broad `COMMERCE_V1_ENABLED` request.
- Read-only discovery gate only.
- No direct Stripe, Plural, Pine, or provider credential handling.
- No state-changing production request is part of C5L.

## Rejection Criteria

Reject the intake packet if any condition below is true:

- Any required approval artifact is missing.
- Merchant identity is unclear or does not identify exactly one reviewed
  merchant.
- Realistic private data is included in the repository.
- A production-looking merchant ID appears without an explicit human approval
  reference.
- Wording claims live payment, live Plural, provider readiness, certification,
  checkout readiness, payment creation readiness, or production readiness.
- Synthetic merchant IDs, names, or payloads are requested for production use.
- A request enables broad runtime behavior instead of the read-only discovery
  gate.
- Private contracts, private contacts, signed approval records, pricing terms,
  customer data, raw payloads, or sensitive business details are committed.
- Provider credentials, secret values, private keys, bearer tokens, webhook
  secrets, idempotency keys, database URLs, or raw provider material appear.

## Safety Checks Before Future Allowlist Or Config Proposal

These checks must be rerun on any later intake or rollout proposal:

- Secret and private-detail scan.
- Overclaim scan for readiness, certification, checkout, payment creation,
  live payment, live Plural, provider approval, or broad Commerce V1 claims.
- Merchant ID and merchant name review.
- Public payload preview review.
- Allowlist value review using only a human-approved merchant ID.
- Grantex read-only smoke plan review for GET-only checks, refusal checks,
  cache/header checks, marker scans, rollback, and evidence retention.
- AgenticOrg dependency review confirming public commerce discovery remains
  gated until separate approval exists.

## Stop Conditions

Stop and do not prepare a future rollout proposal if any condition below is
true:

- No named merchant approval exists.
- Legal, security, product, or ops approval is missing.
- Merchant owner approval is missing.
- Rollback owner, read-only smoke owner, or evidence retention owner is
  missing.
- Any secret or private merchant detail is present in the repository.
- Any production config enablement is requested.
- Any checkout, payment creation, live Plural, live payment, or provider path
  is requested.
- Any synthetic merchant ID is proposed for production allowlist use.
- AgenticOrg public discovery is requested before Grantex named merchant
  approval, read-only smoke review, and separate AgenticOrg approval exist.

## Next-Step Decision Matrix

| Decision | Meaning | Allowed next action |
| --- | --- | --- |
| Not ready | One or more required artifacts are missing. | Keep intake blocked and collect missing human artifacts outside repo. |
| Intake ready | Artifacts are present and repo-safe summaries are recorded, but rollout is not approved. | Prepare a separate readiness review only. |
| Rollout proposal ready | All required artifacts are complete and reviewed, with no secrets, private data, or overclaims. | Prepare a separate proposal that still requires explicit approval before any config or allowlist change. |
| Rejected | Secrets, private data, overclaims, live-provider paths, synthetic production IDs, or broad runtime requests are present. | Stop, remove unsafe material outside repo, and restart intake review. |

## Explicit Non-Approval

- This checklist does not approve a merchant.
- This checklist does not approve production discovery.
- This checklist does not approve a production allowlist value.
- This checklist does not enable `COMMERCE_PUBLIC_DISCOVERY_ENABLED`.
- This checklist does not set `COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST`.
- This checklist does not enable Commerce V1.
- This checklist does not enable checkout or payment creation.
- This checklist does not enable live payments.
- This checklist does not enable live Plural.
- This checklist does not enable AgenticOrg public commerce discovery.
- This checklist does not treat synthetic smoke data as production approval.
