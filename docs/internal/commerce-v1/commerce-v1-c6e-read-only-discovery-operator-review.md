# Commerce V1 C6E Read-Only Discovery Operator Review

## Scope

C6E adds an operator review workflow for sandbox merchants that already requested
read-only discovery review in C6D. Operators can list pending requests, inspect
readiness evidence, and record a public-safe decision.

This slice does not deploy, approve a merchant, enable public discovery, enable
production Commerce V1, create checkout/payment paths, enable live payments,
enable live Plural, write production config, or set production allowlists.

## State Model

C6E uses the existing sandbox onboarding state and append-only audit evidence.
No migration is needed.

- Pending request: `sandbox_onboarding_state = submitted_for_review`.
- `changes_requested`: stored as audit evidence and moves the existing state to
  `blocked` with public-safe remediation text.
- `rejected`: stored as audit evidence and moves the existing state to
  `not_approved` with public-safe reason text.
- `rollout_proposal_ready`: stored only as audit evidence and keeps production
  gates closed. It means the merchant is eligible for a later separate rollout
  proposal review.

No state named approved, live, certified, production_ready, payment_ready,
provider_ready, or public_discovery_enabled is introduced.

## APIs

- `GET /v1/commerce/read-only-discovery-review-requests`
- `GET /v1/commerce/merchants/{merchant_id}/sandbox-onboarding/read-only-discovery-review`
- `POST /v1/commerce/merchants/{merchant_id}/sandbox-onboarding/read-only-discovery-review/decision`

Allowed decisions:

- `changes_requested`
- `rejected`
- `rollout_proposal_ready`

Decision reason and remediation text are validated as public-safe text and reject
secrets, private artifacts, provider credentials, raw payloads, production/live
claims, payment/checkout claims, and allowlist/config values.

## Audit Evidence

Successful decisions append one of:

- `merchant.sandbox_onboarding.read_only_discovery_review.changes_requested`
- `merchant.sandbox_onboarding.read_only_discovery_review.rejected`
- `merchant.sandbox_onboarding.read_only_discovery_review.rollout_proposal_ready`

Audit metadata includes tenant, merchant, operator actor, decision, public-safe
reason/remediation summary, readiness status, preview status, blocker count, and
fixed non-enabling control flags. It does not include secrets, private merchant
documents, provider credentials, tokens, raw payloads, production config values,
concrete allowlist values, or customer data.

## Non-Enabling Controls

Every C6E response keeps these controls fixed:

- `sandbox_only: true`
- `production_approval_status: not_approved`
- `live_mode_status: not_live`
- `rollout_status: rollout_not_requested`
- `public_discovery_enabled: false`
- `checkout_payment_enabled: false`
- `live_provider_enabled: false`
- `live_plural_enabled: false`
- `production_allowlist_written: false`

CommerceAgent callers are denied from operator review endpoints.
