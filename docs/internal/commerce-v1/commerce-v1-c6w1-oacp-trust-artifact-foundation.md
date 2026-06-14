# Commerce V1 C6W1 - OACP Trust Artifact Foundation

Status: implementation foundation, internal-only, non-enabling.

## Scope

C6W1 starts the OACP trust artifact implementation as a Grantex-owned authority foundation.

This slice adds:

- First internal artifact format defaults.
- First-release offline commitment caps.
- Artifact TTL defaults.
- Revocation snapshot and propagation SLA defaults.
- Connector credential custody defaults.
- First agent-surface bridge defaults.
- Tests and helper logic that fail closed on private, credential, raw payload, and enablement fields.

No endpoint, migration, workflow, provider adapter, public discovery, checkout/payment, live payment, live provider, merchant private API, or protocol publication is added.

## First Internal Artifact Format

The first internal OACP artifact format is canonical JSON with detached JWS signatures.

Default posture:

- Payload format: canonical JSON.
- Signature format: detached JWS.
- First algorithm: ES256.
- Artifact container: JSON object.
- JWT container: not used for OACP commerce artifacts.
- COSE: deferred for later wallet/device-native evaluation.
- Simple ad hoc signed JSON: not allowed.

JWT remains appropriate for sessions and Commerce Passports. OACP artifacts are signed commerce facts and evidence, not identity tokens.

## First-Release Offline Commitment Caps

First release caps are intentionally conservative.

| Risk tier | Monetary cap | Quantity cap | Frequency cap | Offline posture |
| --- | --- | --- | --- | --- |
| Informational | No commitment value cap because no commitment is made | Maximum 100 listed products or 20 compared products per buyer request | 30 informational requests per buyer-agent/merchant/hour | Browse and compare only |
| Low | INR 25,000 or USD 300 equivalent | Up to 10 total units, maximum 5 units per SKU | 10 draft carts or quote previews per buyer-agent/merchant/day | Non-binding draft/quote only |
| Medium | INR 10,000 or USD 125 equivalent | Up to 5 total units, maximum 2 units per SKU | 3 active holds/reservations, maximum 6 per day | Requires merchant/source confirmation |
| High | INR 5,000 or USD 60 equivalent | Up to 3 total units, maximum 1 high-value unit per SKU | 2 high-risk offline actions per buyer-agent/merchant/day | Requires provider verification or merchant/source confirmation |
| Critical | Offline not allowed | Offline not allowed | Offline not allowed | Always refuse offline |

Critical actions include public discovery publication, merchant approval or suspension, emergency disablement, policy override, production allowlists, and live-provider enablement.

## Artifact TTL Defaults

| Artifact type | Default TTL | Commitment posture |
| --- | --- | --- |
| Merchant capability | 24 hours | Eligibility and display only; emergency revocation overrides immediately |
| Seller agent capability | 6 hours | Third-party seller-card use only when public-safe |
| Policy | 6 hours | Commitment checks only inside policy limits |
| Catalog snapshot | 6 hours | Browse and compare unless paired with fresher commercial facts |
| Offer | 15 minutes | Price lock or quote only if artifact explicitly permits |
| Price | 5 minutes default, 60 seconds for promotion-sensitive categories | Price lock only with merchant/source confirmation |
| Inventory | 60 seconds default, 30 seconds for high-velocity categories | Hold/reservation only with merchant/source confirmation |
| Public discovery | 15 minutes for read/display | Publish/unpublish offline not allowed |
| Mandate capability | 2 minutes at commitment boundary, 15 minutes for non-binding display | Payment intent only with direct provider verification |
| Protocol adapter | 24 hours maximum, never longer than referenced artifacts | Display/routing only |

The effective TTL is the shortest relevant artifact TTL plus the revocation snapshot freshness rule. The stricter rule wins.

## Connector Credential Custody

Default custody order:

1. merchant-owned connector platform or merchant-owned integration runtime.
2. Merchant-selected external integration provider vault.
3. AgenticOrg encrypted connector vault as fallback only with explicit merchant authorization.
4. Grantex does not store raw Shopify, WooCommerce, ERP, OMS, WMS, PIM, billing, CRM, logistics, or provider connector credentials.

Grantex receives only public-safe source metadata, redacted evidence references, capability summaries, artifact hashes, and reconciliation status.

## Revocation Propagation SLA

Revocation propagation is jointly owned by providers, merchant systems, AgenticOrg, Grantex, and channel bridges.

First-release targets:

- Provider/fintech high-risk state: visible through webhook or polling within 30 seconds.
- Merchant inventory and price updates: within 60 seconds.
- Merchant emergency disablement: within 30 seconds.
- Other merchant operational changes: within 5 minutes.
- AgenticOrg high/critical cache purge: within 30 seconds of observed update.
- AgenticOrg medium-risk refresh: within 2 minutes.
- Grantex revocation status: visible within 30 seconds of accepted evidence.
- Active channel transaction update: next user-visible response or within 30 seconds.

If any owner misses the SLA or revocation state is ambiguous, the affected action must degrade to refusal or non-binding guidance according to risk tier.

## First Agent-Surface Bridges

First real E2E bridge defaults:

- ChatGPT-style: hosted OpenAPI tool/action bridge.
- Claude Code-style: MCP streamable HTTP bridge.
- Gemini-style: A2A task bridge plus OpenAPI fallback.
- Perplexity-style: hosted answer/search bridge plus OpenAPI read and commit-preflight endpoints.

The bridge may use a harness to emulate the chat surface only when proprietary platform access is unavailable. The harness must call real hosted non-production services and must not fabricate commerce responses.

## What This Does Not Enable

C6W1 does not enable:

- Public discovery.
- Production Commerce V1.
- Checkout/payment creation.
- Payment capture or debit.
- Live payments.
- Live provider use.
- Live Plural use.
- Provider calls.
- Merchant private API calls.
- Connector credential storage in Grantex.
- Production allowlists.
- Public OACP publication.
- IETF, NIST, UCP, ACP, AP2, A2A, MCP, schema.org, or x402 certification or compliance claims.
- Merchant approval.
- Production readiness.

## Stop Conditions

Stop later implementation if:

- Raw credentials, tokens, private provider payloads, raw JWTs, bank details, card details, private customer identifiers, or merchant private API values enter OACP artifacts.
- Grantex becomes a synchronous dependency for every browse, comparison, or non-binding recommendation.
- Offline Commitment Mode allows critical actions.
- Caps or TTLs are raised without explicit approval.
- Mock commerce responses replace real non-production dependencies in E2E.
- AgenticOrg buyer agents receive connector credentials or call merchant private APIs directly.
- Provider-owned mandate/payment capability is treated as unlimited spend authority.
