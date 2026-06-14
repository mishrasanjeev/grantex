# C6Z Runtime Artifact Authority

## Scope

C6Z adds a real internal authority intake and issuance path for the runtime vertical demo.
AgenticOrg submits a redacted seller onboarding authority request and normalized Shopify
read-only connector evidence. Grantex validates the request and issues internal OACP artifacts
that AgenticOrg can cache for non-binding buyer answers.

## Correct Ownership Model

AgenticOrg owns seller and buyer agent runtime behavior, seller onboarding UX and API,
connector initiation, cached artifact consumption, buyer web sessions, MCP bridge behavior,
and provider-owned capability verification. Grantex owns trust, protocol, policy, and
canonical internal OACP artifact authority.

Grantex does not receive every non-binding buyer or seller turn. It does not become a
transaction toll booth for cached product Q&A, cached artifact lookup, channel responses,
or provider-owned capability checks.

## Internal Request Contract

The internal endpoint is:

`POST /v1/commerce/oacp/c6z/authority-requests`

It accepts:

- tenant, merchant, and seller agent scope
- merchant display name and commerce categories
- connector choice `shopify`
- connector mode `read_only`
- requested authority scope
- artifact cache scope
- source freshness policy
- redacted source evidence ref
- source observed timestamp
- `no_payment_execution = true`
- `no_public_discovery_enablement = true`

It returns one of:

- `received` when a valid intake request arrives before connector evidence
- `pending_sandbox_review`
- `rejected`
- `artifact_issuance_ready`

No live approval or public discovery state is created by this endpoint. Internal artifacts are issued only when the request is valid and redacted connector evidence is present.

## Issued Artifact Families

C6Z issues internal artifacts for:

- `merchant_profile`
- `seller_agent_card`
- `connector_evidence`
- `catalog_snapshot`
- `offer_price_snapshot`
- `inventory_snapshot`
- `policy_scope`
- `authority_request_status`

Each artifact includes tenant, merchant, seller agent, Shopify source evidence reference,
issued and expiry timestamps, freshness labels, unsupported capabilities, non-enablement
flags, and detached-JWS internal signature posture.

## Runtime Boundaries

C6Z artifacts are internal OACP artifacts only. They do not authorize checkout, payment,
order creation, inventory holds, refund, return, shipping, public discovery publication,
live provider execution, provider calls, merchant private API calls, or production Commerce
V1 enablement.

Grantex stores no raw Shopify token, raw connector payload, provider payload, private
merchant value, raw JWT, credential, token, private key, bank or card data, private customer
data, production allowlist value, or live execution target in these artifacts.

## Demo Sequence

1. AgenticOrg creates the seller onboarding packet.
2. AgenticOrg performs Shopify Admin GraphQL read-only sync.
3. AgenticOrg stores normalized redacted connector evidence.
4. AgenticOrg submits the authority request and connector evidence to Grantex.
5. Grantex validates scope, freshness, and non-enablement flags.
6. Grantex issues internal OACP artifacts.
7. AgenticOrg caches the artifacts and answers buyer questions from cache.

## Validation

Focused tests cover:

- accepted authority request validation
- internal artifact issuance for all C6Z families
- internal signature verification
- stale source evidence rejection
- missing or mismatched scope rejection
- raw connector payload and secret rejection
- execution target rejection
- endpoint response under existing commerce auth context

## Future Pilot Blockers

A real pilot merchant still needs external setup outside this slice:

- Shopify Admin GraphQL app credentials with read-only product, variant, media, and inventory scopes
- a safe AgenticOrg credential store or environment-backed local secret resolver
- merchant-owned confirmation of catalog and freshness policy
- separately reviewed provider capability credentials
- separately approved retention, checkout, payment, mandate, order, public discovery, or live provider work
