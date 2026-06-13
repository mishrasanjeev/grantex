# Commerce V1 C6X3 Cache Repository Compatibility

## Scope

C6X3 adds Grantex-side compatibility tests and internal documentation for the AgenticOrg OACP artifact cache repository intake shape. It proves the C6X2 cached-artifact verifier result already carries the metadata AgenticOrg needs to store, list, and evaluate local cache records. It adds no Grantex runtime code.

## Compatibility Contract

AgenticOrg remains the buyer and seller AI-agent runtime and owns local/persistent OACP artifact cache behavior. Grantex remains the trust, protocol, policy, and canonical OACP artifact authority. The verifier result is an authority-side evidence result, not a runtime execution decision and not a transaction toll booth.

The compatibility contract maps Grantex verifier output into an AgenticOrg cache record without calling Grantex live, providers, merchant private APIs, checkout/payment systems, public discovery services, or external systems.

## Required Intake Fields

The verifier result provides artifact id, artifact family/type, source authority, issuer, tenant id, merchant id, seller agent id, buyer agent id where present, source refs, evidence refs, generated_at, cached_at source timestamp, expires_at, freshness status, revocation snapshot posture, TTL policy, risk tier, blocked capabilities, unsupported capabilities, verifier result reference, and non-enablement flags.

AgenticOrg may store these fields in its local repository boundary and evaluate them with its own C6X2/C6X3 fail-closed rules.

## Non-Execution Posture

Every compatible result keeps `allowed_to_execute = false`, `non_authoritative_for_transaction = true`, `no_checkout_payment_enablement = true`, `no_live_provider_enablement = true`, and `no_public_discovery_enablement = true`.

Valid cache records may support non-binding preview or prepared-only behavior. Final commitment requests remain prepared-only or refused by AgenticOrg policy.

## Migration Decision

C6X3 adds no DB migration in Grantex. It only verifies compatibility between the existing Grantex verifier result and the AgenticOrg repository intake contract. Durable storage remains AgenticOrg-owned and requires a later explicit migration proposal if production persistence is approved.

## Guardrails

C6X3 adds no public endpoint, route, OpenAPI runtime contract, migration, workflow, cloud resource, production config, secret, production allowlist assignment, provider adapter, merchant private API call, provider call, no checkout or payment enablement, order path, hold path, refund path, return path, shipping path, public discovery enablement, no live provider rail enablement, or external OACP publication.

## Future Work

Future slices may add AgenticOrg durable repository adapters, cache eviction, tenant indexes, or revocation refresh behavior. Those slices must remain separated from checkout, payment, provider rail, merchant private API, and public OACP publication behavior unless separately approved.
