# Commerce V1 C6G AgenticOrg Buyer-Agent Discovery Integration

## Scope

C6G adds a sandbox-only AgenticOrg buyer-agent discovery preview and handoff
request workflow for merchants whose C6F rollout proposal dry run has passed.

This slice does not deploy, merge, approve a merchant, enable public discovery,
enable AgenticOrg public discovery, enable production Commerce V1, create
checkout/payment paths, enable live payments, enable live Plural, write
production config, create provider credentials, or set production allowlists.

## State Model

C6G uses append-only audit evidence and computed response payloads. No migration
is needed.

Allowed integration statuses:

- `not_ready`
- `blocked`
- `sandbox_handoff_ready`
- `sandbox_handoff_requested`
- `sandbox_handoff_withdrawn`

No state named approved, launched, certified, production_ready, live,
payment_ready, provider_ready, public_discovery_enabled, or allowlisted is
introduced.

## APIs

- `GET /v1/commerce/merchants/{merchant_id}/agenticorg-buyer-discovery-preview`
- `POST /v1/commerce/merchants/{merchant_id}/agenticorg-buyer-discovery-handoff-request`
- `POST /v1/commerce/merchants/{merchant_id}/agenticorg-buyer-discovery-handoff-withdraw`

Operators and owning merchants can inspect the preview. Trusted CommerceAgent
callers can read the historical preview state after an operator records the sandbox handoff
request and current blockers remain absent.

Handoff request and withdrawal are operator-only. CommerceAgent callers cannot
write C6G state, cannot access C6D/C6E/C6F operator endpoints, and cannot gain
merchant admin access.

## Eligibility

C6G handoff request requires:

- tenant-scoped merchant exists;
- merchant environment is sandbox;
- C6D review request audit evidence exists;
- C6E operator decision is `rollout_proposal_ready`;
- C6F rollout proposal status is `dry_run_passed`;
- current C6F dry-run result is `passed`;
- current sandbox onboarding/category/catalog readiness still passes;
- current C6C agent-facing preview status is `ready`;
- no private, provider, payment, live, production config, or allowlist fields
  are present in the public-safe package.

## Payload

The preview response includes:

- public-safe sandbox merchant reference and display fields;
- readiness summary;
- agent-facing preview summary;
- C6F rollout proposal summary;
- capped public-safe sample products;
- allowed buyer-agent capability labels;
- blocked buyer-agent capability labels;
- blocker and remediation summaries;
- handoff audit reference;
- fixed non-enabling controls.

Excluded fields include legal private names, private contracts, private
contacts, customer data, provider credentials, raw payloads, tokens, JWTs,
passports, DB/Redis URLs, private keys, production config values, concrete
allowlist values, live provider claims, and payment/checkout claims.

## Audit Evidence

C6G appends these audit events:

- `merchant.sandbox_onboarding.agenticorg_buyer_discovery_handoff.requested`
- `merchant.sandbox_onboarding.agenticorg_buyer_discovery_handoff.blocked`
- `merchant.sandbox_onboarding.agenticorg_buyer_discovery_handoff.withdrawn`

Audit metadata stores public-safe status, blocker counts, capability labels,
proposal audit references, sample counts, actor, and fixed non-enabling
controls. It does not store secrets, raw payloads, provider credentials,
production config values, concrete allowlists, private merchant artifacts,
customer data, or live/payment claims.

## Non-Enabling Controls

Every response keeps these controls fixed:

- `sandbox_only: true`
- `handoff_request_is_approval: false`
- `buyer_agent_discovery_is_public: false`
- `agenticorg_public_discovery_enabled: false`
- `production_approval_status: not_approved`
- `live_mode_status: not_live`
- `rollout_status: rollout_not_requested`
- `public_discovery_enabled: false`
- `checkout_payment_enabled: false`
- `live_provider_enabled: false`
- `live_plural_enabled: false`
- `production_allowlist_written: false`

`sandbox_handoff_requested` means only that a tenant operator recorded audit
evidence allowing a trusted CommerceAgent to consume the sandbox preview. It is
not public discovery, launch, approval, certification, production readiness,
checkout/payment readiness, live provider readiness, live Plural readiness,
config writing, or allowlist writing.

## Stop Conditions

Stop C6G work if any implementation path:

- uses the unauthenticated `.well-known` public discovery route;
- sets `COMMERCE_PUBLIC_DISCOVERY_ENABLED`;
- sets `COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST`;
- writes production config or allowlists;
- exposes secrets, private merchant artifacts, provider credentials, raw
  payloads, tokens, JWTs, DB/Redis URLs, private keys, customer data, or
  passports;
- lets CommerceAgent callers request or withdraw handoff;
- gives CommerceAgent callers operator, merchant admin, review, decision, or
  proposal write access;
- enables checkout/payment creation, live payment, live Plural, provider
  credentials, or production Commerce V1;
- treats sandbox/demo/synthetic IDs as production candidates.
