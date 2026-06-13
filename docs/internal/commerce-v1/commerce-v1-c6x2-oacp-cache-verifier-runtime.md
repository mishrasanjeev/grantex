# Commerce V1 C6X2 OACP Cache Verifier Runtime

## Scope

C6X2 adds an internal cached OACP artifact verifier helper for Grantex. The helper validates locally cached canonical artifact envelopes and returns verifier-result-only decisions for AgenticOrg cache consumption and future handoff planning. It does not issue new runtime authority, execute commerce actions, or add public surfaces.

## Correct Ownership Model

AgenticOrg remains the buyer and seller AI-agent runtime, including local and persistent OACP artifact cache behavior. Grantex remains the trust, protocol, policy, and canonical OACP artifact authority. Merchant systems remain operational sources of record. Provider and fintech rails own mandate and payment execution where separately approved. Valid cached OACP artifacts may support non-binding interactions without making Grantex a transaction toll booth for every agent turn; Grantex is not a transaction toll booth.

## Cached Artifact Verifier Contract

The verifier consumes a cached OACP artifact envelope, payload, expected scope, local revocation snapshot posture, and local signature-verifier posture. It preserves artifact id, artifact family/type, issuer and authority references, tenant/merchant/agent scope, issued/generated/expires timestamps, TTL, freshness status, revocation posture, source authority, non-sensitive evidence references, blocked capabilities, unsupported capabilities, and non-enablement flags.

The result is verifier-result-only. It may allow non-binding cached preview or preparation decisions to continue elsewhere, but it never creates a transaction authority decision.

## Verifier Result Fields

Accepted results include artifact id, artifact family, issuer, issuer key id, source authority, subject, cache scope, issued_at, generated_at, expires_at, max_ttl_seconds, freshness status, revocation snapshot timestamp, source refs, evidence refs, blocked capabilities, unsupported capabilities, detached-JWS posture, verifier result reference, buyer-safe message, and operator-safe message.

Every result keeps `allowed_to_execute = false`, `non_authoritative_for_transaction = true`, `no_checkout_payment_enablement = true`, `no_live_provider_enablement = true`, and `no_public_discovery_enablement = true`.

## Freshness, Revocation, And TTL

C6X2 uses the existing internal OACP artifact TTL defaults. The verifier refuses artifacts with missing timestamps, expired timestamps, stale freshness posture, or TTL longer than the pinned policy. A fresh local revocation snapshot is required and must be within the risk-tier maximum age. Revoked artifacts or revoked subjects are refused.

## Fail-Closed Rules

The verifier fails closed for missing artifact id, missing issuer or authority key references, missing subject or required scope, scope mismatch, stale or expired metadata, ambiguous or stale revocation posture, revoked state, payload hash mismatch, missing detached-JWS/verifier posture, private/raw payload fields, secrets or token-like refs, executable labels, checkout/payment/live-provider/public-discovery enablement flags, and publication or readiness-oriented refs.

## Persistence And Migration Decision

C6X2 adds a pure internal verifier helper and focused tests. It adds no DB migration. Durable persistence table design remains a later explicit migration proposal if needed for production storage. This slice validates cached artifacts presented to Grantex helper code; it does not persist production audit records or cache records.

## Guardrails

C6X2 adds no public endpoint, route, OpenAPI runtime contract, migration, workflow, cloud resource, production config, secret, production allowlist assignment, provider adapter, merchant private API call, provider call, no checkout or payment enablement, order path, hold path, refund path, return path, shipping path, public discovery enablement, no live provider rail enablement, or external OACP publication.

## What C6X2 Does Not Enable

C6X2 does not make OACP public. It does not create checkout, payment, provider, mandate, carrier, shipping, merchant private API, or production Commerce V1 behavior. It does not approve merchant, checkout, payment, mandate, provider, public launch, production, or future execution use.

## Future Work

Future slices may propose an explicit persistence migration, cache compaction policy, tenant-bound cache indexes, revocation refresh jobs, or controlled execution handoff integration. Each future slice must keep non-binding cached interactions separate from commitment-bound or execution paths and must be approved separately before any public or live behavior is introduced.
