# OACP End-User Flow

Status: current runtime closure guide, updated 2026-10-20. What is merged,
deployed and turned on: `docs/guides/oacp/runtime-launch-closure-prd.mdx`.

OACP is a signed runtime artifact protocol between Grantex and AgenticOrg. It
is not public standardization, certification, conformance, or production
payment approval.

## Ownership

- AgenticOrg is the buyer and seller AI-agent runtime. It owns Seller Commerce
  Agent onboarding, merchant connector initiation, artifact verification and
  cache, buyer sessions, bridge adapters, the purchase decision (its policy
  arbiter), and approved provider-owned mandate capability verification.
- Grantex is the trust, protocol, policy, and canonical OACP artifact
  authority. It signs artifacts and mandates, keeps every issue and refusal,
  runs the status list, and countersigns the arbiter's decisions.
- Shopify and other merchant systems remain operational systems of record.
- Plural and other provider rails own payment and mandate execution.
- Grantex is not a toll booth for every non-binding buyer/seller interaction.
  A purchase calls Grantex for its mandates and the decision countersignature.

## Runtime Flow

```mermaid
sequenceDiagram
  participant M as Merchant
  participant A as AgenticOrg
  participant S as Shopify
  participant G as Grantex
  participant B as Buyer channel
  M->>A: Create Seller Commerce Agent packet
  M->>A: Store read-only Shopify connector credential
  A->>S: Admin GraphQL product read
  A->>A: Normalize public-safe evidence
  A->>G: Authority request with redacted evidence
  G->>A: ES256-signed OACP artifacts or recorded refusal
  A->>A: Verify each artifact (JWKS, status list), then cache
  B->>A: Buyer product question
  A->>B: Answer with source/freshness labels
  B->>A: Buy
  A->>G: Intent, Cart and Payment mandates; arbiter decision
  G->>A: Signed mandates; countersigned allow or recorded refusal
  A->>B: Provider-owned execution result or exact blocker
```

The last three steps depend on AgenticOrg's own flags, which default off;
until they are on, a purchase request ends in a prepared handoff or a blocker.
Grantex never executes the payment.

## Artifact Families

Grantex C6Z authority issues these families for AgenticOrg cache intake, each
signed with an ES256 detached JWS and on an OACP Token Status List:

- `merchant_profile`
- `seller_agent_card`
- `connector_evidence`
- `catalog_snapshot`
- `offer_price_snapshot`
- `inventory_snapshot`
- `policy_scope`
- `public_discovery_state`
- `mandate_capability`
- `protocol_adapter`
- `authority_request_status`

Every artifact keeps `allowed_to_execute=false`,
`no_payment_execution=true`, and `non_authoritative_for_transaction=true`.
`public_discovery_state` is `disabled` unless the merchant opted in and
`OACP_PUBLIC_DISCOVERY_ISSUANCE_ENABLED` is on. `mandate_capability` is
`verified` only when the provider capability verifier's evidence came with the
request.

## Adapter Closure Matrix

| Adapter | Official source/spec URL | Source in Grantex | What it does | What it does not claim |
| --- | --- | --- | --- | --- |
| Schema.org Product/Offer JSON-LD | https://schema.org/Product and https://schema.org/Offer | `protocol_adapter` artifact `adapter_mapping_profile` (AgenticOrg renders) | Maps sourced product/offer facts. | No schema.org certification or publication approval. |
| UCP business profile | https://ucp.dev/ | `GET /v1/commerce/oacp/ucp-profile` (Grantex renders the `ucp` member at 2026-04-08 or 2026-08-25; the host signs and publishes) | Lists only served capabilities whose backing artifacts are live; checkout and order need a `verified` `mandate_capability`. | No UCP certification; publication only while `publication_allowed`. |
| ACP allowance and order events | https://github.com/agentic-commerce-protocol/agentic-commerce-protocol | `POST /v1/commerce/oacp/acp/delegate-payment-allowance`, `GET /v1/commerce/oacp/acp/orders/{id}/event` | Allowance from the Commerce Passport cap; order events for Grantex orders. | No card data; no outbound webhooks; no ACP certification. |
| AP2-mapped mandates | https://ap2-protocol.org/specification/ | `POST /v1/commerce/oacp/mandates/*` | Intent, Cart and Payment mandates as ES256 JWTs with AP2 v0.2 member names. | Not AP2 v0.2 SD-JWT VCs; no AP2 certification; no payment-network submission. |
| A2A agent card/task metadata | https://a2a-protocol.org/latest/specification/ | `protocol_adapter` artifact `adapter_mapping_profile` (AgenticOrg renders) | Maps seller-agent task metadata. | No official A2A marketplace approval. |
| MCP tool/resource metadata | https://modelcontextprotocol.io/specification/ | `protocol_adapter` artifact `adapter_mapping_profile` (AgenticOrg renders); UCP identity-linking scopes in `@grantex/mcp-auth` | Maps tool/resource metadata. | No MCP registry approval. |
| OpenAPI buyer-safe bridge schema | https://spec.openapis.org/oas/latest.html | `protocol_adapter` artifact `adapter_mapping_profile` (AgenticOrg renders) | Maps function/API bridge shape for buyer-safe questions. | No execution authority or public API approval. |

## Stop Conditions

Stop if a change lets Grantex execute checkout, payment, order, refund,
return, shipment or inventory holds, calls a provider live from Grantex,
mutates merchant-private systems, publishes public discovery without the
merchant opt-in and the flag, or claims certification, conformance,
standardization, merchant approval, payment approval, public-launch readiness,
or production readiness.

## Ownership

Grantex is owned by Orchestrum Technologies LLP. Inventor and owner: Sanjeev Kumar. Ownership contact: [sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in) or [mishra.sanjeev@gmail.com](mailto:mishra.sanjeev@gmail.com).
