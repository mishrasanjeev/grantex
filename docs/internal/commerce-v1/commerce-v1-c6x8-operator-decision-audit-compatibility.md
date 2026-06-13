# Commerce V1 C6X8 Operator Decision Audit Compatibility

## Scope

C6X8 adds a Grantex compatibility guard for AgenticOrg durable OACP operator decision records. Grantex changes are docs and tests only. The guard proves that Grantex cached-artifact verifier output remains sufficient for AgenticOrg to store redacted local operator decision audit-chain references.

## Compatibility Guard

The guard checks that Grantex verifier output carries the fields AgenticOrg needs for durable decision records:

- artifact id and family
- tenant, merchant, seller-agent, and buyer-agent scope where applicable
- source refs
- evidence refs
- verifier result ref
- freshness and revocation posture
- blocked and unsupported capabilities
- non-enablement flags

Those fields are enough for AgenticOrg to connect C6X5 maintenance plans, C6X6 operator review packets, and C6X7 operator decision records without sending every non-binding cache turn back through Grantex.

## Audit-Chain Fields

AgenticOrg can derive durable decision fields such as decision id, review packet id, maintenance plan id, decision kind, scope ids, artifact families, redacted reason codes, redacted evidence refs, opaque reviewer reference, and label-only next steps from the local review packet and Grantex-compatible verifier metadata.

The durable decision remains audit-safe: `allowed_to_execute = false`, `future_action_allowed = false`, `non_authoritative_for_transaction = true`, `no_checkout_payment_enablement = true`, `no_live_provider_enablement = true`, and `no_public_discovery_enablement = true`.

## Grantex Boundary

Grantex remains the trust, protocol, policy, and canonical OACP artifact authority. AgenticOrg remains the buyer and seller AI-agent runtime and owns local operator decision handling. Grantex is not a transaction toll booth and does not need to receive every local cache maintenance report, every local operator decision, or every non-binding buyer/seller agent interaction.

Operator decisions are not Grantex approvals, merchant approvals, checkout approvals, payment approvals, mandate approvals, live-provider approvals, or production approvals.

## Guardrails

C6X8 keeps OACP internal, non-publication, non-certifying, non-production, non-executing, fail-closed, and non-authoritative for transactions. Grantex stores only non-sensitive evidence references where policy or artifact lineage requires them. This guard does not add Grantex persistence for AgenticOrg operator decisions.

## What C6X8 Does Not Enable

C6X8 adds no Grantex route, endpoint, public OpenAPI runtime contract, migration, workflow, or cloud resource. It adds no scheduler, queue, background worker, production config, secret, provider adapter, provider call, merchant private API call, public discovery enablement, checkout, payment, order, hold, refund, return, shipping execution, live rail enablement, allowlist, external OACP publication, or approval/readiness claim.

## Future Work

Future slices may define a separately approved audit-chain export or controller handoff. That work must remain separate from checkout, payment, provider rail, merchant private API, public OACP publication, production config, and public endpoint behavior unless explicitly approved.
