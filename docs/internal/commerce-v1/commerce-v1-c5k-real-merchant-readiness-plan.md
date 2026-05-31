# Commerce V1 C5K Real Merchant Readiness Plan

Status: planning only
Date: 2026-05-26
Scope: bridge from C5I/C5J synthetic smoke success to a future real named
merchant approval intake
Production changes made by this plan: none
Production Commerce V1 changed by this plan: no
Read-only discovery changed by this plan: no
Merchant allowlist value approved by this plan: no
Checkout or payment creation changed by this plan: no
Live payment path changed by this plan: no
Live Plural path changed by this plan: no
Named merchant approved by this plan: no
Secrets inspected or changed: no

This record defines the next review path after C5I and C5J. It does not
approve a real merchant, approve production discovery, approve a production
allowlist entry, or authorize any rollout.

## Current State

- Grantex C5J evidence is merged at
  `37fa71b4192398085daf9e07f53342b46882b578`.
- AgenticOrg C5J evidence is merged at
  `5f2a61513ba9aabf56ab6393de20e1493f562d25`.
- C5I synthetic dataset work is merged.
- C5J local synthetic smoke evidence is merged.
- No real named merchant approval exists.
- Grantex production read-only discovery remains fail-closed.
- `COMMERCE_PUBLIC_DISCOVERY_ENABLED` remains disabled.
- `COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST` has no approved production
  value from this plan.
- AgenticOrg public commerce discovery remains gated.
- Real C5I artifact intake remains blocked until human approvals are provided.

## What C5I And C5J Proved

- The C5I synthetic dataset validators work against the internal synthetic
  dataset shape.
- The local Grantex synthetic discovery-gate tests pass.
- The AgenticOrg gated discovery and no-provider-call tests pass.
- The synthetic dataset remains internal, local, and smoke-only.
- The synthetic path can verify guardrails without requiring real merchant
  details, provider credentials, production config, or production allowlist
  values.

## What C5I And C5J Did Not Prove

- They did not prove real merchant approval.
- They did not approve production discovery.
- They did not approve a production merchant allowlist value.
- They did not prove checkout, payment creation, live payment, live Plural, or
  live provider readiness.
- They did not approve AgenticOrg public commerce discovery.
- They did not convert synthetic merchant IDs, names, or payloads into
  production evidence.

## Required Real Merchant Artifacts

All artifacts must be collected from authorized humans outside the repository.
Only public-safe summaries and non-secret private references may be recorded in
repo after review.

| Artifact | Required evidence | Current state |
| --- | --- | --- |
| Approved public merchant ID | A human-approved public identifier for one real merchant. | Pending |
| Approved public merchant display name | A human-approved public display name for the same merchant. | Pending |
| Approved category | A reviewed public category label. | Pending |
| Approved public discovery description | Reviewed public wording for read-only discovery. | Pending |
| Merchant owner approval | Written merchant owner approval for public read-only discovery metadata. | Pending |
| Legal/compliance approval | Approval covering merchant identity, public wording, and exposure posture. | Pending |
| Product wording approval | Approval that wording avoids readiness, certification, checkout, payment, live provider, and production overclaims. | Pending |
| Security approval | Approval that payload fields are public-safe and contain no secrets, private details, provider credentials, or direct provider paths. | Pending |
| Ops/on-call/support approval | Named support, monitoring, on-call, incident, and escalation ownership. | Pending |
| Backup/RPO approval | Confirmation that read-only discovery and rollback do not weaken backup or recovery posture. | Pending |
| AgenticOrg dependency approval | Confirmation that AgenticOrg remains gated until separate dependency approval exists. | Pending |
| Rollback owner | Named owner for hiding read-only discovery again. | Pending |
| Read-only smoke owner | Named owner for future GET-only production smoke evidence. | Pending |
| Support owner | Named owner for support response. | Pending |
| Incident owner | Named owner for incident escalation and triage. | Pending |
| Evidence owner | Named owner for evidence retention and scrubbed proof records. | Pending |

## Public Payload Preview Review

A future C5K readiness review must preview the exact public payload before any
rollout request. The preview must use approved values only and must not include
secrets, private merchant data, provider credentials, live payment claims, live
Plural claims, provider certification claims, or production readiness claims.

Fields requiring exact review:

- `merchant_id`
- `display_name`
- `category`
- `public_discovery_description`
- `supported_capabilities`
- `discovery_posture`
- `support_contact_policy`
- `incident_escalation_policy`
- `issuer`
- `jwks_uri`
- `cache_headers`
- `rollback_owner_reference`
- `read_only_smoke_owner_reference`
- `evidence_owner_reference`

Allowed posture for the preview: read-only discovery metadata for one approved
merchant only. The preview must state that checkout, payment creation, live
payments, live Plural, and direct provider credential handling remain out of
scope.

## Validation Gates Before Any Future Production Rollout

Every gate below must pass before any later rollout proposal can request
production read-only discovery:

- Secret and private-detail scan of the public payload preview and related
  docs.
- Overclaim scan for readiness, certification, live payment, live Plural,
  checkout, production approval, provider approval, or broad Commerce V1 claims.
- Production-looking ID and name review to ensure only the approved real
  merchant identity appears and no synthetic IDs are present.
- Approved merchant allowlist review using the human-approved merchant ID only.
- Grantex read-only smoke plan review for GET-only checks, refusal checks,
  cache headers, marker scans, rollback, and evidence retention.
- AgenticOrg dependency review confirming AgenticOrg public commerce discovery
  remains gated until separate approval and Grantex read-only smoke evidence
  exist.

## Stop Conditions

Stop the path and do not prepare a rollout request if any condition below is
true:

- A named real merchant approval is missing.
- Legal, security, product, or ops approval is missing.
- Merchant owner approval is missing.
- Rollback owner, read-only smoke owner, support owner, incident owner, or
  evidence owner is missing.
- Any request requires broad `COMMERCE_V1_ENABLED`.
- Any request enables checkout or payment creation.
- Any request touches live payments or live Plural.
- Any provider credential would be exposed, logged, documented, or treated as
  public metadata.
- Any synthetic merchant ID, synthetic merchant name, or synthetic payload is
  proposed for production allowlist use.
- Any AgenticOrg public commerce discovery request appears before the Grantex
  named merchant approval and read-only smoke review are complete.

## Recommended Next Real Step

Collect the real human approval artifacts outside the repository. After the
approval packet exists, update intake documentation only with public-safe
summaries and non-secret private references. Do not include raw approval
messages, private merchant details, provider credentials, secret values, or
production config values in the repository.

## Explicit Non-Approval

- This plan does not approve a merchant.
- This plan does not approve production discovery.
- This plan does not approve a production allowlist value.
- This plan does not enable `COMMERCE_PUBLIC_DISCOVERY_ENABLED`.
- This plan does not set `COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST`.
- This plan does not enable Commerce V1.
- This plan does not enable checkout or payment creation.
- This plan does not enable live payments.
- This plan does not enable live Plural.
- This plan does not enable AgenticOrg public commerce discovery.
- This plan does not treat synthetic smoke data as production approval.
