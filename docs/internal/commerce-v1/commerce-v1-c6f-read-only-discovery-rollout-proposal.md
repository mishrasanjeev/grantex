# Commerce V1 C6F Read-Only Discovery Rollout Proposal

## Scope

C6F adds an operator-only rollout proposal and dry-run evidence workflow for
sandbox merchants that already passed C6E with `rollout_proposal_ready`.

This slice is proposal-only. It does not deploy, merge, approve a merchant,
enable public discovery, enable production Commerce V1, create checkout/payment
paths, enable live payments, enable live Plural, write production config, create
provider credentials, or set production allowlists.

## State Model

C6F uses append-only audit evidence and computed response payloads. No migration
is needed.

Allowed proposal states:

- `not_created`
- `draft_created`
- `dry_run_passed`
- `dry_run_blocked`
- `withdrawn`

No state named approved, launched, certified, production_ready, live,
payment_ready, provider_ready, or public_discovery_enabled is introduced.

## APIs

- `GET /v1/commerce/merchants/{merchant_id}/read-only-discovery-rollout-proposal`
- `POST /v1/commerce/merchants/{merchant_id}/read-only-discovery-rollout-proposal`
- `POST /v1/commerce/merchants/{merchant_id}/read-only-discovery-rollout-proposal/dry-run`
- `POST /v1/commerce/merchants/{merchant_id}/read-only-discovery-rollout-proposal/withdraw`

All endpoints are operator-only and tenant-scoped. CommerceAgent callers are
denied. Live merchants are blocked from the sandbox proposal workflow.

Proposal creation requires:

- sandbox merchant environment;
- C6D request audit evidence;
- C6E latest decision of `rollout_proposal_ready`;
- current sandbox onboarding readiness passing;
- category readiness passing;
- catalog readiness passing;
- agent-facing preview status `ready`;
- no current blockers.

Dry-run evidence can pass or block. A blocked dry run records the current
public-safe blocker summary and remediation; it still does not enable any
production control.

## Evidence Package

The proposal response includes:

- merchant sandbox profile summary;
- category readiness summary;
- catalog readiness summary;
- agent-facing preview summary;
- operator review decision evidence;
- blocker and remediation status;
- evidence checklist;
- audit reference;
- fixed non-enabling controls.

Private legal artifacts, contracts, private contacts, customer data, raw
payloads, credentials, tokens, JWTs, DB/Redis URLs, private keys, provider
secrets, production config values, concrete allowlist values, and live/provider
claims are excluded.

## Audit Evidence

C6F appends these audit events:

- `merchant.sandbox_onboarding.read_only_discovery_rollout_proposal.created`
- `merchant.sandbox_onboarding.read_only_discovery_rollout_proposal.updated`
- `merchant.sandbox_onboarding.read_only_discovery_rollout_proposal.dry_run_passed`
- `merchant.sandbox_onboarding.read_only_discovery_rollout_proposal.dry_run_blocked`
- `merchant.sandbox_onboarding.read_only_discovery_rollout_proposal.withdrawn`

Audit metadata stores tenant and merchant identifiers, operator actor, proposal
status, dry-run result, public-safe evidence summaries, blocker counts,
remediation summaries, and the fixed non-enabling controls. It does not store
secrets, raw payloads, provider credentials, production config values, concrete
allowlists, private merchant artifacts, or customer data.

## Non-Enabling Controls

Every response keeps these controls fixed:

- `sandbox_only: true`
- `proposal_is_approval: false`
- `dry_run_is_launch: false`
- `production_approval_status: not_approved`
- `live_mode_status: not_live`
- `rollout_status: rollout_not_requested`
- `public_discovery_enabled: false`
- `checkout_payment_enabled: false`
- `live_provider_enabled: false`
- `live_plural_enabled: false`
- `production_allowlist_written: false`

`dry_run_passed` means only that the proposal evidence package passed the local
non-enabling dry-run checks at that time. It is not approval, certification,
launch, production readiness, customer-facing public discovery, payment
readiness, live provider readiness, live Plural readiness, config writing, or
allowlist writing.
