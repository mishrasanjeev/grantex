# Commerce V1 C6X5 Cache Maintenance Compatibility

## Scope

C6X5 adds Grantex-side compatibility guard tests and internal documentation for AgenticOrg OACP durable cache maintenance planning. It adds no Grantex runtime code, migration, endpoint, route, OpenAPI runtime contract, workflow, scheduler, queue, background worker, provider adapter, or external call.

## Compatibility Guard

The guard proves the existing Grantex cached-artifact verifier result still provides every field AgenticOrg needs to plan cache refresh, eviction, revocation maintenance, quarantine, and human review outcomes. AgenticOrg remains the buyer and seller AI-agent runtime and owns durable/local OACP cache behavior. Grantex remains the trust, protocol, policy, and canonical OACP artifact authority.

## Maintenance Fields

The compatible result includes artifact id, artifact type and family, issuer, authority, tenant, merchant, seller-agent, and buyer-agent scope ids, source refs, redacted evidence refs, generated, cached, and expiry timestamps, freshness, revocation snapshot status and age, TTL policy, risk tier, blocked capabilities, unsupported capabilities, verifier result ref, and non-enablement flags.

Every compatible maintenance candidate keeps `allowed_to_execute = false`, `non_authoritative_for_transaction = true`, `no_checkout_payment_enablement = true`, `no_live_provider_enablement = true`, and `no_public_discovery_enablement = true`.

## Maintenance Outcomes

AgenticOrg may classify cache records as `keep_usable`, `refresh_recommended`, `refresh_required_before_commitment`, `evict_expired`, `purge_revoked`, `quarantine_ambiguous_revocation`, `quarantine_scope_mismatch`, `quarantine_private_or_raw_ref`, `source_refresh_needed`, `human_review_required`, or `blocked_unsafe`. Grantex does not execute those actions in C6X5.

## Grantex Boundary

Grantex remains the canonical artifact authority, not a transaction toll booth. Cache-maintenance-compatible verifier output is verifier-result-only and does not call providers, merchant private APIs, checkout/payment systems, public discovery systems, carriers, shipping systems, Grantex live endpoints, or live rails.

## Guardrails

C6X5 Grantex changes store no durable records and expose no new runtime surface. Compatibility refs must remain public-safe and non-sensitive: no raw provider payloads, raw connector payloads, raw JWTs, credentials, tokens, private keys, bank or card data, private customer data, private merchant API values, secrets, production allowlists, checkout/payment enablement, live provider rail enablement, public discovery enablement, external OACP publication, or approval claims.

## What C6X5 Does Not Enable

C6X5 adds no public endpoint, public OpenAPI runtime contract, workflow, no scheduler, cron, queue, background worker, cloud resource, production config, secret, public discovery enablement, checkout, payment, order, hold, refund, return, shipping execution, live provider rail enablement, merchant private API execution, external OACP publication, or approval claim.

## Future Work

Future Grantex slices may add additional compatibility checks as AgenticOrg maintenance planning evolves. Those checks must stay separate from provider execution, merchant private APIs, checkout, payment, public discovery publication, and any public OACP submission unless separately approved.
