> **Internal artifact - not public marketing or compliance evidence.**
> This file was relocated from `docs/reports/` to `docs/internal/commerce-v1/`
> on 2026-05-24 to mark it as operator-internal documentation. It is
> excluded from the public Mintlify navigation (`docs/docs.json`). Do
> not link this file from any public marketing page or external sales
> material. See `docs/reports/enterprise-readiness-brutal-review-2026-05-24.md`
> item P0-5 for the audit context.

# Grantex Commerce V1 Read-Only Production Discovery Proposal

Status: planning proposal only
Date: 2026-05-18
Scope: Grantex production Commerce V1 discovery posture and future enablement path
Production changes made by this proposal: none
Production Commerce V1 enabled by this proposal: no
Checkout or payment creation enabled by this proposal: no
Live payments enabled by this proposal: no
Live Plural enabled by this proposal: no
Secrets inspected or changed: no

This document prepares an implementation-ready path for a later human-approved
read-only production discovery milestone. It is not an approval to change
production configuration or to enable Commerce V1.

## Current Production Posture

The C4 production discovery readiness evidence recorded that Grantex production
Commerce V1 discovery is disabled and fails closed:

- `https://api.grantex.dev/.well-known/grantex-commerce` returned
  `commerce_disabled`.
- `https://api.grantex.dev/.well-known/jwks.json` is public and contains public
  key material only.
- `https://grantex.dev/.well-known/grantex-commerce` is absent.
- `https://grantex.dev/commerce-playground.html` is public education and
  playground content, not production discovery enablement.
- Production live payments and live Plural remain disabled.

C5A also hid AgenticOrg public commerce discovery by default, so Grantex can
prepare read-only discovery without AgenticOrg currently advertising public
commerce metadata.

## Current Code And Flag Behavior

The production well-known discovery route is:

- `GET /.well-known/grantex-commerce`

The current code gates that route with this existing non-secret environment
setting name:

- `COMMERCE_V1_ENABLED`

The same Commerce V1 feature gate is also used by Commerce MCP and Commerce
REST surfaces. Therefore, setting `COMMERCE_V1_ENABLED` in production should
not be treated as a narrow read-only discovery enablement. Even where caller
authentication, passport, policy, provider, and live-mode guards remain in
place, the flag broadens the reachable Commerce V1 surface beyond the
well-known discovery document.

Relevant existing setting names for the future review are:

| Setting name | Current planning role |
| --- | --- |
| `COMMERCE_V1_ENABLED` | Existing broad Commerce V1 gate; not narrow enough for read-only discovery alone. |
| `COMMERCE_SANDBOX_ENABLED` | Sandbox-mode control; should remain compatible with internal testing only. |
| `COMMERCE_LIVE_MODE_ENABLED` | Must remain disabled for this milestone. |
| `PLURAL_LIVE_ENABLED` | Must remain disabled for this milestone. |
| `PLURAL_SANDBOX_ENABLED` | Must not be used to imply live Plural readiness. |
| `COMMERCE_ALLOW_AUTO_TENANT` | Must not be enabled for public discovery. |
| `COMMERCE_RECONCILIATION_WORKER_ENABLED` | Out of scope for read-only discovery. |
| `PUBLIC_BASE_URL` | Public host reference used in discovery metadata. |
| `JWT_ISSUER` | Issuer reference used with public JWKS metadata. |

Recommended future implementation adds an independent read-only discovery gate
before any production enablement:

- `COMMERCE_PUBLIC_DISCOVERY_ENABLED`

That name is proposed only. It is not implemented by this planning document and
must not be set until the implementation PR, security review, and human launch
approval are complete.

## Current Public Profile Shape

When enabled, the Grantex well-known profile is expected to publish a
non-secret profile for a Commerce merchant. The current profile shape includes:

- Merchant identity fields:
  - `merchant_id`
  - `display_name`
  - `legal_name`
  - `category_preset`
  - `verification_status`
  - `environment`
  - `default_currency`
  - `country_code`
- Capability metadata.
- MCP transport metadata:
  - `streamable_http`
  - MCP endpoint path.
- Native REST base path for Commerce V1.
- Supported Commerce tool names.
- Auth requirements:
  - agent authentication required for commerce calls.
  - merchant API key authentication required for merchant calls.
  - checkout passport required for payment.
  - public browse remains deferred.
- Required scope names for browse and checkout flows.

The current supported tool metadata includes read and write-style tool names:

- `merchant.get_profile`
- `catalog.search`
- `catalog.get_item`
- `inventory.check`
- `cart.create`
- `checkout.create`
- `payment.create_intent`
- `payment.get_status`

That tool list is accurate to the implementation, but it is also why public
production wording needs a careful review. Publishing these names must not imply
that production checkout, payment creation, live provider settlement, or live
Plural are enabled.

## Enablement Risk Assessment

Read-only discovery can be safe only if the production change is limited to
publishing reviewed, non-secret metadata. The current broad Commerce V1 flag is
not sufficient for that goal on its own.

Key risks to control before any future enablement:

- Broad flag risk: `COMMERCE_V1_ENABLED` also affects MCP and Commerce REST
  paths, not only `/.well-known/grantex-commerce`.
- Merchant selection risk: the current well-known endpoint can use a
  `merchant_id` selector, and multi-merchant behavior requires explicit
  selection. A public global profile should not be enabled without a named
  merchant decision.
- Capability language risk: published capabilities must avoid production-ready,
  live-payment-ready, external-pilot-ready, AP2/UCP/ACP certification, Plural
  certification, or provider certification claims.
- Provider risk: no provider credentials, provider account identifiers, webhook
  secrets, or live settlement language may appear.
- Runtime risk: discovery must not enable checkout or payment creation.
- Cache risk: public metadata should be short-lived or explicitly cache-safe
  until the posture is stable.
- Rollback risk: operators need a single flag or route-level gate that can hide
  discovery without touching unrelated runtime settings.

## Proposed Enablement Topology

Recommended topology for a future C5B implementation:

1. Add an independent read-only discovery gate:
   - Proposed setting name: `COMMERCE_PUBLIC_DISCOVERY_ENABLED`
   - Default: disabled.
   - Absent, empty, invalid, or non-true value: disabled.
   - Explicit safe true values only: enabled.
2. Keep `COMMERCE_V1_ENABLED` disabled until a separate decision approves the
   broader Commerce V1 runtime surface.
3. Gate only the public well-known discovery response behind
   `COMMERCE_PUBLIC_DISCOVERY_ENABLED`.
4. Do not enable checkout, payment intent creation, live payment status polling,
   live Plural, provider credentials, reconciliation workers, or webhooks.
5. Require merchant scoping:
   - Prefer authenticated or allowlisted discovery first.
   - Public discovery may be considered only for named, approved merchant IDs.
6. Publish only non-secret profile metadata and non-secret issuer/JWKS
   references.
7. Add response headers or platform configuration that prevent stale launch
   state:
   - no-store or short max-age until approved otherwise.
8. Keep AgenticOrg public commerce discovery hidden until Grantex read-only
   discovery passes a read-only smoke.

## C5C Implementation Requirements

The future implementation must keep these gate boundaries explicit:

- `COMMERCE_PUBLIC_DISCOVERY_ENABLED` controls only
  `GET /.well-known/grantex-commerce`.
- `COMMERCE_PUBLIC_DISCOVERY_ENABLED` does not enable `/mcp`, MCP
  `tools/list`, MCP `tools/call`, cart creation, checkout creation, payment
  intent creation, payment status mutation, provider webhooks, merchant
  webhooks, reconciliation workers, live payments, or live Plural.
- `COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST` is required when the public
  read-only discovery gate is enabled.
- No allowlist must fail closed.
- A requested merchant outside the allowlist must fail closed.
- The discovery payload must state that the gate is read-only metadata only,
  checkout/payment creation is not enabled by the gate, live payments are
  disabled, live Plural is disabled, and no readiness or certification claim is
  made.
- AgenticOrg `AGENTICORG_COMMERCE_PUBLIC_DISCOVERY_ENABLED` remains disabled
  until Grantex read-only discovery is approved and smoke-tested.

## Merchant Scoping Proposal

No production merchant is approved by this planning task.

Recommended sequence:

1. Keep global production discovery disabled.
2. Define a named allowlist of merchant IDs through a future non-secret setting
   name such as `COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST`.
3. Require an explicit `merchant_id` query parameter for any environment with
   more than one publishable merchant.
4. Return a deterministic blocker when a merchant is not allowlisted.
5. Review each approved merchant profile before publication.

Public global discovery should be considered only after:

- there is exactly one approved production merchant profile, or
- the endpoint is intentionally designed to publish a reviewed directory, and
- legal, compliance, security, product, and operations all approve that shape.

## AgenticOrg Dependency

AgenticOrg public commerce discovery should remain hidden until Grantex
read-only production discovery is approved and verified.

The existing AgenticOrg gate name is:

- `AGENTICORG_COMMERCE_PUBLIC_DISCOVERY_ENABLED`

Future AgenticOrg public commerce discovery should be enabled only after:

1. Grantex read-only discovery is enabled through the independent discovery
   gate.
2. Grantex read-only smoke passes.
3. Grantex discovery payload is confirmed to contain no secrets, no provider
   credentials, no live-payment language, and no overclaims.
4. A human approval explicitly authorizes AgenticOrg to expose matching
   Grantex-only commerce metadata.

## No-Go Conditions

Do not enable Grantex read-only production discovery if any of these are true:

- The only available control is the broad `COMMERCE_V1_ENABLED` flag.
- Checkout, cart creation, payment intent creation, or payment status mutation
  would become publicly reachable without a separate approval.
- Live payments or live Plural would be enabled.
- Provider credentials, webhook secrets, API keys, database URLs, Redis URLs, or
  private keys would be exposed or required for the discovery response.
- The profile includes production-ready, live-payment-ready,
  external-pilot-ready, AP2/UCP/ACP certification, Plural certification, or
  provider certification claims.
- No named merchant owner has approved a merchant-specific public profile.
- Product wording, legal/compliance, security, and operations review are not
  complete.
- Rollback cannot be completed by disabling one discovery-specific gate.
- AgenticOrg public commerce discovery would be enabled before Grantex
  read-only discovery smoke passes.

## Human Gates Required

Before any production read-only discovery enablement:

- Security review of route gating, payload shape, cache posture, and rate
  limits.
- Legal/compliance review of merchant identity, claims, consent wording, and
  public metadata.
- Product wording approval for public capability/status language.
- Operations/on-call owner approval for monitoring, rollback, and support
  responsibility.
- Backup/RPO review for any production dependency touched by future runtime
  Commerce work.
- Named merchant approval for every merchant profile published.
- AgenticOrg dependency approval if AgenticOrg commerce discovery will be
  enabled afterward.

## Read-Only Smoke Checklist

Future read-only smoke must use only unauthenticated GET requests and must not
create state.

Before enablement:

- Confirm `COMMERCE_LIVE_MODE_ENABLED` is disabled.
- Confirm `PLURAL_LIVE_ENABLED` is disabled.
- Confirm no provider credential path is involved in discovery.
- Confirm AgenticOrg `AGENTICORG_COMMERCE_PUBLIC_DISCOVERY_ENABLED` remains
  disabled unless separately approved.
- Confirm the discovery gate can be rolled back independently.

After temporary or production read-only enablement:

| Check | Expected result |
| --- | --- |
| `GET https://api.grantex.dev/health` | 200 |
| `GET https://api.grantex.dev/.well-known/jwks.json` | 200, public key material only |
| `GET https://api.grantex.dev/.well-known/grantex-commerce` | 200 only when the read-only gate is explicitly enabled |
| Discovery payload secret scan | No tokens, passports, idempotency keys, provider credentials, DB/Redis URLs, private keys, raw payloads, or secret values |
| Discovery payload wording scan | No live-payment, live-Plural, external-pilot, production-ready, or certification overclaims |
| MCP and REST state-changing paths | Not enabled by the read-only discovery gate |
| AgenticOrg public commerce discovery | Hidden unless separately approved after Grantex smoke passes |

## Rollback Checklist

Rollback must be possible without rotating secrets or touching provider
configuration.

1. Disable the future read-only discovery gate:
   - `COMMERCE_PUBLIC_DISCOVERY_ENABLED`
2. Keep or return `COMMERCE_V1_ENABLED` to disabled unless a separate runtime
   launch has been approved.
3. Confirm `GET /.well-known/grantex-commerce` returns a fail-closed status.
4. Confirm JWKS remains public and non-secret.
5. Confirm AgenticOrg commerce public discovery remains hidden or is disabled:
   - `AGENTICORG_COMMERCE_PUBLIC_DISCOVERY_ENABLED`
6. Confirm no checkout, payment creation, live payment, or live Plural flags
   changed.
7. Record rollback evidence without raw payloads or secret values.

## Decision Table

| Option | Description | Benefits | Risks | Recommendation |
| --- | --- | --- | --- | --- |
| Keep disabled | Leave Grantex production Commerce V1 discovery fail-closed. | Safest current posture; no runtime exposure. | No public production discovery. | Recommended until an independent read-only gate exists. |
| Gated or authenticated discovery | Add a narrow read-only gate and optionally require merchant allowlist or authentication. | Allows controlled validation with minimal public exposure. | Requires implementation and reviews. | Recommended first implementation path. |
| Public read-only discovery for allowlisted merchants | Publish reviewed non-secret discovery for named merchants. | Enables public agent discovery after controls are proven. | Public wording and metadata exposure risk. | Consider only after gated smoke, merchant approval, and human launch approval. |

## Recommendation

Do not enable production Commerce V1 discovery by setting
`COMMERCE_V1_ENABLED` for a read-only launch.

Recommended C5B path:

1. Implement a narrow read-only discovery gate such as
   `COMMERCE_PUBLIC_DISCOVERY_ENABLED`.
2. Keep checkout/payment creation and live provider paths disabled.
3. Add merchant allowlist behavior before any public profile is exposed.
4. Run read-only smoke and payload scans.
5. Keep AgenticOrg public commerce discovery hidden until Grantex discovery
   passes and human approval explicitly enables AgenticOrg metadata.

## Future Implementation Prompt

Do not run this prompt until human-approved.

```text
Task: C5B implementation only - add a narrow read-only Grantex production Commerce discovery gate.

Do not deploy.
Do not merge.
Do not create cloud resources.
Do not change production config.
Do not enable production Commerce V1 runtime.
Do not enable checkout/payment creation.
Do not enable live payments.
Do not enable live Plural.
Do not enable AgenticOrg commerce public discovery.
Do not touch secrets.

Goal:
Add an independent fail-closed read-only discovery gate for
GET /.well-known/grantex-commerce so a later approved launch can publish
reviewed non-secret discovery metadata without enabling the broader Commerce V1
runtime surface.

Implement:
1. Add non-secret setting name COMMERCE_PUBLIC_DISCOVERY_ENABLED.
2. Default disabled: absent, empty, invalid, and non-true values are disabled.
3. Only explicit safe true values enable the well-known read-only response.
4. Do not use COMMERCE_PUBLIC_DISCOVERY_ENABLED to enable MCP tool calls, cart,
   checkout, payment intent creation, payment status mutation, live payments, or
   live Plural.
5. Keep COMMERCE_V1_ENABLED as the broader runtime gate.
6. Add merchant scoping with a future allowlist setting name:
   COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST.
7. Publish only reviewed non-secret merchant/profile/issuer/JWKS metadata.
8. Add cache/rate-limit posture appropriate for public read-only metadata.
9. Add tests proving read-only discovery can be enabled while state-changing
   Commerce V1 routes remain disabled.
10. Add docs and readiness validator coverage.

Validation:
- Unit/integration tests for the new gate.
- Read-only discovery payload redaction tests.
- Existing Commerce V1 readiness validators.
- Focused secret scan on changed files.
- git diff --check.

Packaging:
- Open a draft PR only.
- Do not deploy or enable production config.
```
