# Commerce V1 C5Z Seller Sandbox Onboarding Foundation

Status: implementation slice 1
Date: 2026-05-31
Scope: Grantex runtime foundation for seller self-serve sandbox onboarding
Production changes made by this slice: none
Production Commerce V1 changed by this slice: no
Public discovery changed by this slice: no
AgenticOrg public discovery changed by this slice: no
Checkout or payment creation changed by this slice: no
Live payment path changed by this slice: no
Live Plural path changed by this slice: no
Provider credential collection changed by this slice: no
Named merchant approved by this slice: no
Secrets inspected or changed: no

## Implemented Boundary

C5Z creates an API-backed seller sandbox onboarding surface on the existing
tenant-owned `commerce_merchants` row. It lets an operator or owning merchant
prepare a sandbox workspace with public-safe profile metadata and review state.

The implementation stores only:

- display name;
- category preset;
- country code;
- default currency;
- test-safe support email or support URL;
- public discovery description draft;
- sandbox onboarding state and blocker summary;
- sandbox/live environment marker already present on the merchant;
- agentic commerce requested flag.

It does not store private contracts, private contacts, signed approvals,
pricing terms, customer data, secrets, tokens, JWTs, raw payloads, DB/Redis
URLs, private keys, provider credentials, production config values, allowlist
values, checkout state, payment state, live provider references, or real
merchant approval material.

## API Surface

- `GET /v1/commerce/merchants/{merchant_id}/sandbox-onboarding`
- `PUT /v1/commerce/merchants/{merchant_id}/sandbox-onboarding`
- `POST /v1/commerce/merchants/{merchant_id}/sandbox-onboarding/transition`

All three endpoints use the existing commerce caller resolver and tenant
boundary. Operator callers may access tenant merchants. Merchant callers may
access only their own merchant. CommerceAgent callers are denied. State-changing
endpoints append commerce audit events.

## State Machine

Supported states:

- `draft_created`
- `profile_incomplete`
- `sandbox_ready`
- `submitted_for_review`
- `blocked`
- `not_approved`
- `rollout_not_requested`

Transitions to `sandbox_ready` or `submitted_for_review` require readiness
checks to pass. No state transition approves production, enables discovery,
enables checkout/payment creation, enables live payments, or enables live
Plural.

## Readiness Checks

The runtime readiness response includes:

- merchant profile present;
- category preset selected;
- public-safe description present;
- private artifacts not stored in public fields;
- no production allowlist/config values;
- no live provider path;
- no checkout/payment enablement.

The readiness response always reports:

- `live_mode_status: not_live`;
- `production_approval_status: not_approved`;
- `rollout_status: rollout_not_requested`.

Passing readiness means only that the sandbox profile can be submitted for
review. It is not merchant approval, production approval, public discovery
approval, AgenticOrg launch approval, checkout approval, payment approval, live
Plural approval, or provider readiness evidence.
