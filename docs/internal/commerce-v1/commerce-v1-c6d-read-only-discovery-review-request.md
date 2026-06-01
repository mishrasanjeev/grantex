# Commerce V1 C6D Read-Only Discovery Review Request

## Scope

C6D adds a sandbox-only request workflow for read-only discovery review. It
lets a tenant-scoped merchant or operator ask for human review after the C5Z
sandbox profile, C6A category checklist, C6B catalog readiness, and C6C
agent-facing preview all pass.

The request is not approval. It does not enable public discovery, production
Commerce V1, checkout/payment creation, live payments, live Plural, provider
credentials, order fulfillment, refunds, or production allowlisting.

## Runtime Behavior

- `GET /v1/commerce/merchants/{merchant_id}/sandbox-onboarding` returns a
  computed `read_only_discovery_review` payload.
- `POST /v1/commerce/merchants/{merchant_id}/sandbox-onboarding/read-only-discovery-review-request`
  accepts an empty body only.
- The request endpoint is tenant-scoped and uses the existing operator or
  owning-merchant caller boundary. CommerceAgent callers do not gain merchant
  admin access through this route.
- Accepted requests transition the existing sandbox onboarding state to
  `submitted_for_review`.
- Blocked attempts return blocker/remediation details and write public-safe
  audit evidence.
- Live merchants are blocked.

## Eligibility

A request is accepted only when:

- the merchant exists in the caller tenant;
- the merchant environment is sandbox;
- sandbox profile readiness passes;
- category required checks pass;
- catalog required checks pass;
- the agent-facing preview is ready;
- public-safe fields pass validation;
- no private artifacts appear in public/runtime fields;
- no production config or allowlist values are present;
- checkout/payment execution remains disabled;
- live provider and live Plural paths remain disabled;
- provider credentials are not included;
- no synthetic/demo ID is submitted as a production candidate.

## Fixed Non-Enabling Controls

The computed review payload always reports:

- `sandbox_only: true`
- `request_is_approval: false`
- `live_mode_status: not_live`
- `production_approval_status: not_approved`
- `rollout_status: rollout_not_requested`
- `public_discovery_enabled: false`
- `checkout_payment_enabled: false`
- `live_provider_enabled: false`
- `live_plural_enabled: false`
- `production_allowlist_written: false`

## Audit Evidence

Accepted requests write
`merchant.sandbox_onboarding.read_only_discovery_review.requested`.

Blocked requests write
`merchant.sandbox_onboarding.read_only_discovery_review.blocked`.

Audit metadata is limited to tenant/merchant context, request status, state,
readiness status, preview status, blocker summaries, and fixed false controls.
It must not include secrets, private merchant details, raw payloads, provider
credentials, tokens, passports, DB/Redis URLs, private keys, concrete
production allowlist values, or production config values.

## No Migration Decision

C6D intentionally reuses the existing sandbox onboarding state machine. The
request state maps to `submitted_for_review`; blocked/rejected/withdrawn-like
states map to the existing `blocked`, `not_approved`, and
`rollout_not_requested` values. A later slice can add dedicated immutable
request timestamps if product needs a separate history beyond
`sandbox_onboarding_updated_at`.

## Validation Evidence

Implementation readiness should include:

- auth-service commerce tests;
- auth-service typecheck;
- portal onboarding tests;
- portal typecheck;
- OpenAPI/schema validation;
- `git diff --check`;
- secret/private-detail scan;
- production config and allowlist assignment scan;
- public discovery enablement scan;
- checkout/payment enablement scan;
- live payment/live Plural/provider credential path scan;
- overclaim scan;
- realistic merchant/private detail scan;
- synthetic/demo production-candidate scan.
