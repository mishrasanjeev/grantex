# C6Y4 Retention Disposition Compatibility

## Scope

C6Y4 confirms that Grantex OACP verifier and authority references remain sufficient for AgenticOrg internal audit review manifest retention disposition dry-runs and operator review packets. This is a docs/tests compatibility guard only.

Grantex does not add runtime code, persistence, routes, endpoints, OpenAPI contracts, workflows, cloud behavior, provider calls, private API calls, public discovery behavior, checkout/payment behavior, live rails, schedulers, CLIs, migrations, or export writers in this slice.

## Compatibility Guard

AgenticOrg remains the buyer and seller AI-agent runtime. AgenticOrg owns durable/local OACP artifact cache behavior, local operator decision handling, audit export bundle generation, audit review manifest handling, internal manifest query/summary behavior, and C6Y4 retention disposition dry-runs.

Grantex remains the trust, protocol, policy, and canonical OACP artifact authority. Its verifier/cache metadata can be referenced by AgenticOrg through non-sensitive authority, artifact, lineage, freshness, revocation, risk, blocked, unsupported, and evidence-count fields.

## Retention Disposition Fields

The compatibility guard expects AgenticOrg retention disposition packets to retain:

- tenant, merchant, seller agent, and buyer agent scope
- source C6Y3 summary id
- manifest_count
- retention class counts
- retention due counts
- legal hold candidate counts
- artifact family/type counts
- freshness and TTL summary
- revocation snapshot summary
- risk tier counts
- blocked and unsupported capability summaries
- redacted evidence ref count only
- disposition previews such as retain, review_later, legal_hold_review, redaction_review_required, retention_due_review, and blocked_unsafe
- next-step labels only
- allowed_to_execute = false
- future_retention_action_allowed = false
- records_deleted = false
- retention_executed = false
- non_authoritative_for_transaction = true
- no_export_file_written = true

Grantex verifier results already provide the non-sensitive artifact id/type, source refs, evidence refs, freshness, revocation, risk, blocked capabilities, unsupported capabilities, and non-enablement posture needed for AgenticOrg to build these dry-run-only packets.

## Grantex Boundary

Grantex does not receive every retention disposition packet, every audit review manifest, every audit export bundle, every retention review, or every non-binding buyer/seller interaction. Grantex must not become a transaction toll booth for local retention review, cache review, non-binding preview, or internal operator-summary workflows; it is not a transaction toll booth.

The disposition dry-run is not a Grantex approval, merchant approval, checkout approval, payment approval, mandate approval, live-provider approval, production approval, public launch approval, certification, compliance statement, conformance statement, standardization claim, or OACP public approval.

## Guardrails

The C6Y4 compatibility guard preserves:

- internal-only review metadata
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
- no checkout/payment enablement
- no live provider enablement
- no public discovery enablement

## What C6Y4 Does Not Enable

C6Y4 does not execute retention, does not delete records, purge records, write export files, run maintenance, schedule retention, expose APIs, create orders, create holds, capture payments, create mandates, issue refunds, process returns, create shipments, call providers, call carriers, call shipping providers, call merchant private APIs, call Grantex live endpoints, publish OACP, submit protocols externally, or enable public discovery.

C6Y4 does not claim certification, compliance, conformance, standardization, production readiness, public launch readiness, merchant approval, checkout approval, payment approval, mandate approval, live-provider readiness, or OACP approval.

## Future Work

A future approved slice may connect these dry-runs to durable disposition decisions or an internal operator review surface. That work must remain redacted, tenant-scoped, non-executing, and separately reviewed before any endpoint, scheduler, CLI, export writer, migration, or production retention action is introduced.
