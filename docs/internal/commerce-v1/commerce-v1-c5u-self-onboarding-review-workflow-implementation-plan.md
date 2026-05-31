# Commerce V1 C5U Self-Onboarding Review Workflow Implementation Plan

Status: planning only
Date: 2026-05-26
Scope: future review workflow implementation plan for merchant self-onboarding
for read-only Commerce discovery
Production changes made by this plan: none
Runtime code changed by this plan: no
Workflow code changed by this plan: no
Migrations added by this plan: no
Production config changed by this plan: no
Production Commerce V1 changed by this plan: no
Read-only discovery changed by this plan: no
Merchant allowlist value approved by this plan: no
Checkout or payment creation changed by this plan: no
Live payment path changed by this plan: no
Live Plural path changed by this plan: no
Named merchant approved by this plan: no
Secrets inspected or changed: no

This C5U record describes a future review workflow implementation for merchant
self-onboarding. It is not an implementation. It does not add runtime code,
workflow code, migrations, config values, allowlist values, public discovery,
Commerce V1 enablement, checkout/payment creation, live payments, live Plural,
provider credentials, real merchant approval, or rollout approval.

## Planning-Only Review Workflow Scope

- No runtime workflow implementation.
- No production config.
- No public discovery enablement.
- No real merchant approval.
- No rollout approval.
- No checkout, payment, live payment, live Plural, provider, or broad runtime
  path.
- Review workflow records are conceptual and local-only until a separate
  implementation task is approved.
- Repository-visible data is limited to non-secret references, role labels, and
  redacted summaries.
- Any missing required review gate, owner assignment, validator pass, or
  AgenticOrg dependency signal fails closed.

## Review Gate Model

All gates are required before intake can move to `intake_ready`.

| Gate | Required decision | Repo-safe record | Blocking condition |
| --- | --- | --- | --- |
| Merchant owner | approved, blocked, or rejected | role label and non-secret reference | missing owner approval |
| Legal/compliance | approved, blocked, or rejected | role label and non-secret reference | missing legal/compliance approval |
| Product wording | approved, blocked, or rejected | role label and redacted wording summary | unclear or overclaiming public wording |
| Security | approved, blocked, or rejected | role label and non-secret reference | unresolved security concern |
| Ops/on-call/support | approved, blocked, or rejected | role label and support posture summary | support ownership missing |
| Backup/RPO | approved, blocked, or rejected | role label and recovery posture summary | backup/RPO owner missing |
| Rollback owner | assigned, blocked, or rejected | public-safe role label | rollback owner missing |
| Read-only smoke owner | assigned, blocked, or rejected | public-safe role label | smoke owner missing |
| Evidence retention owner | assigned, blocked, or rejected | public-safe role label | retention owner missing |
| AgenticOrg dependency owner | approved, blocked, or rejected | role label and dependency summary | AgenticOrg dependency incomplete |

Gate rules:

- A gate can be pending, approved, blocked, or rejected.
- Approval references are non-secret references to private systems.
- Placeholders do not count as approval.
- A single blocked or rejected gate prevents `intake_ready`.
- Review gate completion does not imply rollout approval.

## Owner Assignment Model

Required roles:

- Merchant owner.
- Legal/compliance reviewer.
- Product wording reviewer.
- Security reviewer.
- Ops/on-call/support owner.
- Backup/RPO reviewer.
- Rollback owner.
- Read-only smoke owner.
- Evidence retention owner.
- AgenticOrg dependency owner.

Role responsibilities:

- Merchant owner confirms the merchant-facing request is intentionally
  submitted.
- Legal/compliance confirms public metadata and consent/payment wording are
  acceptable for review.
- Product wording confirms public payload wording is read-only and does not
  overclaim readiness.
- Security confirms no secret, private artifact, provider credential, raw
  payload, or unsafe disclosure is present.
- Ops/on-call/support confirms support posture and operational ownership.
- Backup/RPO confirms recovery expectations for any later rollout proposal.
- Rollback owner owns later gate disablement and later approved config clearing.
- Read-only smoke owner owns local and later approved read-only validation.
- Evidence retention owner owns redacted evidence retention rules.
- AgenticOrg dependency owner owns downstream gated-state review.

Allowed repo-safe role labels:

- `<MERCHANT_OWNER_ROLE>`.
- `<LEGAL_COMPLIANCE_REVIEWER_ROLE>`.
- `<PRODUCT_WORDING_REVIEWER_ROLE>`.
- `<SECURITY_REVIEWER_ROLE>`.
- `<OPS_SUPPORT_OWNER_ROLE>`.
- `<BACKUP_RPO_REVIEWER_ROLE>`.
- `<ROLLBACK_OWNER_ROLE>`.
- `<READ_ONLY_SMOKE_OWNER_ROLE>`.
- `<EVIDENCE_RETENTION_OWNER_ROLE>`.
- `<AGENTICORG_DEPENDENCY_OWNER_ROLE>`.

Private owner/contact details remain outside repositories. Missing-owner
behavior is fail-closed: the workflow remains `approvals_pending` or `blocked`
and cannot advance to `intake_ready`.

## State Transition Rules

| From state | Allowed next state | Required conditions | Blockers |
| --- | --- | --- | --- |
| `draft_created` | `submitted_for_review` | Required draft fields present. | missing public-safe draft field |
| `submitted_for_review` | `scans_running` | Local validator requested. | validator unavailable |
| `scans_running` | `review_ready` | All required scans pass. | any scan blocker |
| `scans_running` | `blocked` | At least one fixable blocker. | secret, private detail, overclaim, config value |
| `scans_running` | `rejected` | Hard-stop blocker. | secret retained, live/provider path, synthetic production candidate |
| `blocked` | `draft_created` | Submitter removes blocker. | blocker still present |
| `review_ready` | `approvals_pending` | Human gate review begins. | missing required gate row |
| `approvals_pending` | `intake_ready` | All gates approved or assigned and all owners present. | missing gate, missing owner, dependency incomplete |
| `approvals_pending` | `blocked` | Fixable gate or owner blocker. | incomplete review record |
| `approvals_pending` | `rejected` | Gate rejection or hard-stop finding. | rejected required gate |
| `intake_ready` | `rollout_proposal_ready` | Separate rollout proposal reference created. | rollout reference missing |
| `rollout_proposal_ready` | `rolled_back` | Later rollback event reference recorded. | rollback owner missing |
| any non-terminal state | `rejected` | Hard-stop condition. | private material, live/provider path, config value |

Terminal states:

- `rejected` is terminal for the current packet.
- `rolled_back` is terminal for a later approved rollout record.

`rollout_proposal_ready` is not production approval. It only indicates that a
separate rollout proposal can be reviewed.

## Validator Integration Points

Before submit:

- Validate required draft fields.
- Validate no private material is pasted.
- Expected blocker codes: `missing_required_field`,
  `private_material_detected`, `secret_detected`.

Before `review_ready`:

- Run all C5T scan categories.
- Expected blocker codes: `overclaim_detected`,
  `production_looking_id`, `synthetic_production_candidate`,
  `config_allowlist_value`, `payload_not_read_only`.

Before `intake_ready`:

- Validate all required gates and owners.
- Validate AgenticOrg dependency owner is present.
- Expected blocker codes: `missing_review_gate`, `missing_owner`,
  `agenticorg_dependency_incomplete`.

Before `rollout_proposal_ready`:

- Validate intake state, read-only smoke owner, rollback owner, and evidence
  retention owner.
- Expected blocker codes: `intake_not_ready`, `rollback_owner_missing`,
  `smoke_owner_missing`, `evidence_owner_missing`.

After rollback:

- Validate rollback evidence summary and fail-closed posture.
- Expected blocker codes: `rollback_reference_missing`,
  `rollback_evidence_not_redacted`, `gate_not_disabled`.

## Redacted Audit Evidence Behavior

Record:

- Event type.
- Actor role.
- Timestamp reference.
- Decision.
- Blocker code.
- Redacted hash if needed.
- Redacted event summary.
- Production effect, always `none` in this plan.

Never record:

- Private contracts.
- Private contacts.
- Signed approval records.
- Pricing terms.
- Customer data.
- Secrets.
- Tokens/passports/JWTs.
- Provider credentials.
- Raw payloads.
- DB/Redis URLs.
- Private keys.
- Production config values.
- Concrete allowlist values.

The audit timeline must be append-only in any future implementation. Repository
docs may include only redacted examples and non-secret references.

## Human Approval Recording Rules

- Private approvals stay outside repositories.
- Repository records store only non-secret references and public-safe summaries.
- Placeholders are not approval.
- Approval completion does not imply rollout approval.
- Reviewers are represented by role labels, not private contacts.
- Approval record bodies, signatures, contracts, private emails, pricing terms,
  and sensitive business details are never stored in repositories.
- If any approval reference cannot be represented safely, the workflow remains
  blocked until a non-secret reference is supplied.

## AgenticOrg Dependency Review Sequence

1. Grantex review workflow reaches `intake_ready` or
   `rollout_proposal_ready`.
2. A separate approved Grantex read-only smoke task runs and passes.
3. AgenticOrg receives only a redacted Grantex summary and smoke reference.
4. AgenticOrg dependency owner reviews the gated-state summary.
5. AgenticOrg remains gated until separate AgenticOrg approval exists.
6. AgenticOrg public commerce discovery remains disabled during Grantex intake
   and read-only smoke.
7. AgenticOrg rollback/disable path remains independent and can keep or return
   metadata exposure to `none`.

The Grantex workflow cannot create AgenticOrg public discovery enablement.

## Rollback Coordination

Required rollback roles:

- Read-only discovery rollback owner.
- AgenticOrg rollback owner.
- Evidence retention owner.

Rollback expectations:

- Rollback references are non-secret summaries.
- Any later approved read-only discovery gate can be disabled by a separate
  rollback process.
- Any later approved config can be cleared by a separate rollback process.
- Rollback smoke verifies that discovery is disabled and no public metadata is
  exposed.
- AgenticOrg remains gated or returns to gated behavior.
- If rollback owner, rollback reference, or rollback smoke is missing, the
  workflow fails closed.

## Stop Conditions

Stop the workflow if:

- Required review gate is missing.
- Required owner is missing.
- Validator scan fails.
- Private material appears in repository docs.
- Real merchant approval is absent.
- Synthetic value is proposed for real rollout or allowlist use.
- Production config or allowlist value appears.
- Broad Commerce V1, live payment, checkout/payment, live Plural, or provider
  path is requested.
- AgenticOrg public discovery is requested before Grantex read-only smoke and
  separate AgenticOrg approval.

## Mermaid Review Workflow Diagram

```mermaid
flowchart TD
  A[draft_created] --> B[submitted_for_review]
  B --> C[scans_running]
  C --> D{Validator scans pass?}
  D -- No fixable blocker --> E[blocked]
  D -- Hard stop --> F[rejected]
  E --> A
  D -- Yes --> G[review_ready]
  G --> H[approvals_pending]
  H --> I{All gates and owners complete?}
  I -- No --> E
  I -- Gate rejected --> F
  I -- Yes --> J[intake_ready]
  J --> K{Separate rollout proposal reference?}
  K -- No --> J
  K -- Yes --> L[rollout_proposal_ready]
  L --> M{Rollback reference recorded?}
  M -- Yes --> N[rolled_back]
```

## Future Notes

- C5V rollout automation proposal must remain separate from this review
  workflow plan.
- A local-only prototype should precede any runtime implementation.
- No production enablement can occur without separate explicit approval.
- This plan does not approve a merchant, allowlist value, config value, public
  discovery, checkout, payment, live payment, live Plural, or provider path.

## Production Safety Controls

- Grantex remains fail-closed.
- AgenticOrg remains gated.
- No public discovery.
- No broad Commerce V1.
- No checkout/payment creation.
- No live payments.
- No live Plural.
- No provider credentials.
- No synthetic production candidates.
- No production config values.
- No concrete allowlist values.
- No rollout approval from this plan.
