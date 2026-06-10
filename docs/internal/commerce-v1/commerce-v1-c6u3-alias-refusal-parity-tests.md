# Commerce V1 C6U3 Alias And Refusal Parity Tests

Status: internal test coverage and release-control report only.

This document does not approve production launch, real merchants, public
discovery, checkout/payment creation, live payments, live Plural, provider
calls, merchant private API calls, production config, production allowlists,
cloud resources, protocol publication, external submission, certification,
compliance, conformance, standardization, public-launch readiness, merchant
approval, or production readiness.

## Purpose

C6U3 turns the C6U2 parity matrix into executable guardrails for the boundary
between Grantex Commerce V1 contracts and AgenticOrg buyer-agent aliases. The
Grantex side owns the source contracts: OpenAPI, MCP tool names, required
passport scopes, refusal/error codes, and preview fixture controls. AgenticOrg
owns the buyer-facing aliases, local preflight refusals, and buyer-safe error
translation.

## Grantex Scope

The Grantex PR adds a focused static contract test:

- `apps/auth-service/tests/commerce-c6u3-alias-refusal-parity.test.ts`

The test intentionally does not add runtime behavior. It pins:

- the Commerce V1 MCP tool inventory consumed by AgenticOrg aliases
- `payment.get_status` requiring `commerce:payment.status.read` for
  CommerceAgent callers using `passport_jwt`
- OpenAPI documentation for the same MCP inventory
- OpenAPI non-enabling fields for public discovery, checkout/payment, live
  provider, and merchant private API controls
- C6O preview fixture flags staying false for public discovery,
  checkout/payment, live provider, direct provider, merchant private API,
  credentials, secrets, and production allowlists

## AgenticOrg Scope

The paired AgenticOrg PR owns the executable alias and buyer-refusal tests. It
proves:

- every AgenticOrg commerce alias maps to a Grantex MCP or REST contract
- `payment_get_status` refuses locally when the required passport is missing
- a valid status poll goes only to Grantex `/mcp` with `payment.get_status`
- checkout/payment, live provider, live Plural, merchant private API,
  fulfillment, and refund requests fail before non-read-only behavior can start
- public discovery hides commerce tools until the AgenticOrg gate is explicit
- stale or unknown inventory becomes cautious buyer-safe wording
- Grantex error messages are redacted before buyer-facing output
- ChatGPT, Claude, Gemini, WhatsApp, and Telegram remain future channel labels,
  not live channel exposure

## Tested Contract Matrix

| Contract | Grantex source | AgenticOrg alias | C6U3 expectation |
| --- | --- | --- | --- |
| Merchant profile | `merchant.get_profile` | `merchant_get_profile` | Grantex source contract only; no merchant private API fallback. |
| Catalog search | `catalog.search` | `catalog_search` | Grantex source contract only; browse passport behavior remains Grantex-owned. |
| Item detail | `catalog.get_item` | `catalog_get_item` | AgenticOrg must not invent price, tax, warranty, return, or availability claims. |
| Inventory | `inventory.check` | `inventory_check` | Stale or unknown inventory must not become a stock promise. |
| Cart draft | `cart.create` | `cart_create` | Idempotency and Grantex contract required; no checkout approval implied. |
| Consent request | `/v1/commerce/passports/consent-requests` | `consent_request` | Grantex owns consent request creation. |
| Consent exchange | `/v1/commerce/passports/exchange` | `consent_exchange` | Grantex owns Commerce Passport minting. |
| Buyer discovery preview | C6G preview REST route | `buyer_discovery_preview` | Read-only, sandbox-only, gated, and non-public by default. |
| Payment intent | `payment.create_intent` | `payment_create_intent` | Blocked without consent/passport, policy, idempotency, and provider safety gates. |
| Checkout handoff | `checkout.create` | `checkout_create` | Blocked without checkout passport and policy gates. |
| Payment status | `payment.get_status` | `payment_get_status` | Requires status-read passport for CommerceAgent callers. |

## Refusal Table

| Condition | Expected result |
| --- | --- |
| Missing passport for payment status | Local AgenticOrg `consent_required` refusal before Grantex call. |
| Missing passport for Grantex agent status read | Grantex MCP `passport_required` or passport-specific refusal. |
| Missing passport scope | Grantex MCP `passport_scope_missing`. |
| Checkout/payment request without gates | AgenticOrg `checkout_payment_not_enabled` or Grantex policy/passport refusal. |
| Live provider or live Plural request | AgenticOrg `live_provider_not_enabled`. |
| Merchant private API request | AgenticOrg `merchant_private_api_not_allowed`. |
| Public discovery without both gates | AgenticOrg hides commerce tools; Grantex preview fixtures keep flags false. |
| Stale or unknown inventory | Buyer-safe caution; no stock guarantee. |
| Raw provider/private error details | AgenticOrg redacts before buyer-facing output. |

## Known Remaining Gaps

| Gap | Owner | Priority | Future slice |
| --- | --- | --- | --- |
| Source/freshness projection | Grantex + AgenticOrg | P0 | C6U4 buyer-safe source, freshness, price, tax, warranty, and return projection. |
| Shared public discovery state | Grantex + AgenticOrg | P0 | C6U5 cross-repo public discovery state contract. |
| Consent/session/passport revocation propagation | Grantex + AgenticOrg | P0 | C6U6 durable session and revocation propagation. |
| Channel-specific refusal packs | AgenticOrg | P1 | Channel slices after C6U5/C6U6. |
| schema.org/UCP-style/ACP-style/AP2-style packaging | Grantex + AgenticOrg | P2 | C6U10 internal adapter packaging only. |
| Order, fulfillment, refund, support, settlement, and payout contracts | Grantex | P0 | C6U7/C6U8 post-purchase contracts. |
| AgenticOrg CI/CD cloud-build guard follow-up after PR #723 cancellation | AgenticOrg | P0 | Separate release-control slice, not C6U3. |

## Stop Conditions

- Any Grantex change exposes public discovery, checkout/payment, live provider,
  live Plural, production allowlists, production config, provider credentials,
  merchant private APIs, or cloud resources without a separate approval.
- Any AgenticOrg change calls a payment provider, Plural, merchant private API,
  provider credential route, or merchant existing system directly for commerce.
- Any buyer-facing output contains raw payloads, private URLs, secrets,
  passport/JWT values, provider credentials, database URLs, Redis URLs,
  production config, or production allowlist values.
- Any wording claims production launch, public discovery, checkout/payment, live
  provider, live Plural, protocol publication, external submission,
  certification, compliance, conformance, standardization, merchant approval,
  public-launch readiness, or production readiness.

## Validation

Expected focused validation:

- Grantex: `npm --prefix apps/auth-service test -- commerce-c6u3-alias-refusal-parity.test.ts`
- Grantex: relevant existing commerce guardrail tests, including MCP and no
  Plural leak tests
- Grantex: `node scripts/commerce-c6oe-preview-conformance-gate.mjs --mode pr`
- AgenticOrg: C6U3 alias/refusal regression tests and nearby commerce guardrail
  tests
- Both repos: `git diff --check origin/main...HEAD`, ASCII check, changed-file
  scope check, focused secret/private scan, config/allowlist scan,
  public-discovery/payment/live-provider enablement scan, direct
  provider/Plural scan, merchant private API scan, and overclaim scan

This slice adds no migration, workflow, production config, secret, provider
integration, merchant private API integration, production allowlist, public
discovery enablement, checkout/payment enablement, live provider enablement,
live Plural enablement, cloud resource, or external protocol
publication/submission action.
