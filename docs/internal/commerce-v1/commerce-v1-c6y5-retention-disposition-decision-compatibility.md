# C6Y5 Retention Disposition Decision Compatibility

## Scope

C6Y5 confirms that Grantex OACP verifier and authority references remain sufficient for AgenticOrg durable retention disposition decision records. This is a docs/tests compatibility guard only.

Grantex does not add runtime code, persistence, routes, endpoints, OpenAPI contracts, workflows, cloud behavior, provider calls, private API calls, public discovery behavior, checkout/payment behavior, live rails, schedulers, CLIs, migrations, export writers, retention execution, deletion, purge, or record redaction behavior in this slice.

## Compatibility Guard

AgenticOrg remains the buyer and seller AI-agent runtime. AgenticOrg owns durable/local OACP artifact cache behavior, local operator decision handling, audit export bundle generation, audit review manifest handling, internal manifest query/summary behavior, retention disposition dry-runs, operator packets, and durable retention disposition decision records.

Grantex remains the trust, protocol, policy, and canonical OACP artifact authority. Its verifier/cache metadata can be referenced by AgenticOrg through non-sensitive authority, artifact, lineage, freshness, revocation, risk, blocked, unsupported, and evidence-count fields.

## Durable Decision Fields

The compatibility guard expects AgenticOrg durable retention disposition decision records to retain:

- disposition decision id
- source summary id
- source retention dry-run id
- source operator packet id
- tenant, merchant, seller agent, and buyer agent scope
- generated_at and decided_at
- decision kind
- retention class and retain_until
- manifest_count
- retention_due_count
- legal_hold_candidate_count
- artifact family/type counts
- risk tier counts
- blocked and unsupported capability summaries
- redacted evidence ref count only
- redacted reason codes
- opaque reviewer reference only
- next-step labels only
- allowed_to_execute = false
- future_retention_action_allowed = false
- records_deleted = false
- retention_executed = false
- non_authoritative_for_transaction = true

Grantex verifier results already provide the non-sensitive artifact id/type, source refs, evidence refs, freshness, revocation, risk, blocked capabilities, unsupported capabilities, and non-enablement posture needed for AgenticOrg to build these local durable decision records by reference.

## Grantex Boundary

Grantex does not receive every retention disposition decision, every retention disposition dry-run, every operator packet, every manifest summary, every audit review manifest, every audit export bundle, or every non-binding buyer/seller interaction. Grantex must not become a transaction toll booth for local retention review, cache review, non-binding preview, internal operator-summary workflows, or durable disposition decisions; it is not a transaction toll booth.

The durable disposition decision is not a Grantex approval, merchant approval, checkout approval, payment approval, mandate approval, live-provider approval, production approval, public launch approval, certification, compliance statement, conformance statement, standardization claim, or OACP public approval.

## Guardrails

The C6Y5 compatibility guard preserves:

- internal-only decision metadata
- redacted evidence reference counts only
- no raw artifact payloads
- no provider payloads
- no connector payloads
- no raw JWTs or passports
- no credentials, tokens, private keys, or secrets
- no private customer data
- no payment or bank/card data
- no raw merchant private API values
- no raw reviewer identity
- allowed_to_execute = false
- future_retention_action_allowed = false
- records_deleted = false
- retention_executed = false
- no checkout/payment enablement
- no live provider enablement
- no public discovery enablement

## What C6Y5 Does Not Enable

C6Y5 does not execute retention, delete records, purge records, redact persisted records, write export files, run maintenance, schedule retention, expose APIs, create orders, create holds, capture payments, create mandates, issue refunds, process returns, create shipments, call providers, call carriers, call shipping providers, call merchant private APIs, call Grantex live endpoints, publish OACP, submit protocols externally, or enable public discovery.

C6Y5 does not claim certification, compliance, conformance, standardization, production readiness, public launch readiness, merchant approval, checkout approval, payment approval, mandate approval, live-provider readiness, or OACP approval.

## Future Work

A future approved slice may connect these decision records to an internal operator UI or a separately approved retention execution controller. That work must remain redacted, tenant-scoped, non-executing by default, and separately reviewed before any endpoint, scheduler, CLI, export writer, or production retention action is introduced.
