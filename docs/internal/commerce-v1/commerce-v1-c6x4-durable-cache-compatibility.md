# Commerce V1 C6X4 Durable Cache Compatibility

## Scope

C6X4 adds Grantex-side compatibility guard tests and internal documentation for the AgenticOrg durable OACP artifact cache repository contract. It adds no Grantex runtime code, migration, endpoint, route, OpenAPI runtime contract, workflow, provider adapter, or external call.

## Compatibility Guard

The guard proves the existing Grantex C6X2 cached-artifact verifier result and C6X3 repository intake shape still provide every field AgenticOrg needs for durable cache storage. AgenticOrg remains the buyer and seller AI-agent runtime and owns local/durable OACP artifact cache behavior. Grantex remains the trust, protocol, policy, and canonical OACP artifact authority.

## Durable Cache Fields

The compatible result includes artifact id, artifact type and family, issuer, authority, tenant, merchant, seller-agent, and buyer-agent scope ids, source refs, redacted evidence refs, generated, issued, cached, and expiry timestamps, freshness, revocation snapshot status and age, TTL policy, risk tier, blocked capabilities, unsupported capabilities, verifier result ref, and non-enablement flags.

## Non-Execution Posture

Every compatible result keeps `allowed_to_execute = false`, `non_authoritative_for_transaction = true`, `no_checkout_payment_enablement = true`, `no_live_provider_enablement = true`, and `no_public_discovery_enablement = true`.

## Grantex Boundary

Grantex remains the canonical artifact authority, not a transaction toll booth. Cache-compatible verifier output is verifier-result-only and does not call providers, merchant private APIs, checkout/payment systems, public discovery systems, carriers, shipping systems, or live rails.

## Guardrails

C6X4 Grantex changes store no durable records and expose no new runtime surface. Compatibility refs must remain public-safe and non-sensitive: no raw provider payloads, raw connector payloads, raw JWTs, credentials, tokens, private keys, bank or card data, private customer data, private merchant API values, secrets, production allowlists, no checkout/payment enablement, no live provider rail enablement, public discovery enablement, external OACP publication, or certification/approval/readiness claims.

## Future Work

Future Grantex slices may add additional verifier compatibility checks as AgenticOrg cache storage evolves. Those checks must remain separate from provider execution, merchant private APIs, checkout, payment, public discovery publication, and any public OACP submission unless separately approved.
