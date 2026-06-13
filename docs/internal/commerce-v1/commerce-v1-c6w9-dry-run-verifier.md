# Commerce V1 C6W9 Dry-Run Verifier

## Scope

C6W9 adds an internal dry-run verifier over C6W8 eligibility packets. It checks whether a packet has a complete local handoff contract for a future gated controller review. It does not create a controller, execute a transaction, persist production audit events, call providers, call merchant private APIs, or enable public discovery.

Grantex remains the trust, protocol, policy, and canonical-artifact authority. AgenticOrg remains the buyer and seller agent runtime. Merchant systems remain operational sources of record, and provider or fintech rails own payment and mandate execution.

## Dry-Run Result Kinds

- `execution_controller_handoff_dry_run`
- `audit_readiness_verification`
- `missing_contract_requirement`
- `blocked_handoff_verification`
- `manual_review_required_verification`

Each result is a local verifier artifact. It is not a checkout, order, hold, payment, mandate, refund, return, shipment, publication, or approval instruction.

## Verifier Statuses

- `dry_run_accepted_for_future_controller`
- `missing_contract_requirement`
- `needs_human_review`
- `blocked`
- `stale`
- `expired`
- `mismatched`
- `unsupported`
- `unsafe`

Only `dry_run_accepted_for_future_controller` means the local packet contract shape is complete enough for a future controller review. It is still non-executing and does not imply readiness for live execution.

## Required Fields

Verifier results carry the packet lineage and source evidence forward:

- deterministic `verification_id`
- `verification_kind` and `verification_status`
- `created_at`, `expires_at`, and `max_ttl_seconds`
- `eligibility_packet_id`, `packet_kind`, and `eligibility_status`
- `reconciliation_id` and `envelope_id`
- `requested_action`, `action_class`, and `risk_tier`
- source artifact IDs and families
- redacted response evidence refs and audit lineage refs
- required confirmations and missing requirements
- freshness summary
- contract checks and audit-readiness checks
- unsupported and blocked capabilities
- buyer, seller, and operator-safe messages
- label-only next human and next system steps
- `allowed_to_execute remains false`
- `dry_run_only remains true`
- `eligibility_only remains true`
- `non_authoritative_for_transaction remains true`
- checkout, live-provider, and public-discovery non-enablement flags remain true

## Contract Checks

C6W9 checks:

- packet kind is recognized
- eligibility status is acceptable for the requested verifier kind
- reconciliation and envelope lineage are present and match any claimed refs
- source artifact refs are present
- evidence refs are redacted and non-private
- required confirmations are present
- freshness and TTL are valid
- mandate evidence is fresh when the action reaches a mandate boundary
- action class and risk tier are consistent
- amount, currency, and quantity context are present for commitment-bound actions
- non-enablement flags are intact
- no executable URL, endpoint, provider target, merchant private target, or live rail target is present
- no raw private labels or payloads are present
- no protocol publication, submission, certification, compliance, conformance, production-readiness, or execution-readiness claim is present

## Audit Readiness

Audit-readiness verification checks that the local dry-run packet carries:

- audit lineage refs
- redacted audit refs
- reconciliation and envelope lineage
- source artifact refs
- response evidence refs
- safe buyer, seller, and operator wording

C6W9 does not write production audit records. It only prepares local audit-readiness facts for a later gated slice.

## Fail-Closed Rules

C6W9 blocks or marks unsafe when:

- the C6W8 packet is missing
- the packet allows execution
- the packet is not prepared-only, reconciled-only, and eligibility-only
- the eligibility status does not match the verifier kind
- lineage is missing or mismatched
- evidence refs are missing, raw, private, or unredacted
- required confirmations are missing
- freshness or TTL is stale or expired
- risk context is missing or inconsistent
- mandate evidence is stale or missing at the boundary
- non-enablement flags are missing or false
- executable URLs, endpoint targets, provider targets, merchant private targets, or live rail targets appear
- the packet implies checkout, payment, order, hold, refund, return, shipping, provider execution, public discovery enablement, publication, or readiness claims
- secrets, raw JWTs, private keys, raw provider payloads, private merchant URLs, DB or Redis URLs, private customer data, or production allowlist values appear

## Dry-Run Acceptance Is Not Execution

Dry-run acceptance means only that a future controller review could inspect the local contract shape. It is not execution readiness, merchant approval, checkout approval, payment approval, provider readiness, public launch readiness, certification, compliance, conformance, or standardization.

## Toll Booth Boundary

Non-binding agent interactions continue from valid cached artifacts without making Grantex a transaction toll booth. Grantex validates authority-side metadata and dry-run contract shape; it does not broker live transactions or insert itself into merchant or provider execution paths.

## What This Does Not Enable

C6W9 does not enable:

- public discovery
- checkout or payment
- live providers or live rails
- live Plural behavior
- production Commerce V1
- merchant private API calls
- provider, carrier, or shipping calls
- production audit persistence
- protocol publication or submission
- certification, compliance, conformance, standardization, production-readiness, or execution-readiness claims

## Future Slices

Future slices would need separate gated work for execution-controller ownership, merchant-system handoff contracts, provider-owned mandate and payment execution, production audit persistence, human approvals, rollback handling, and runtime controls. Those are outside C6W9.
