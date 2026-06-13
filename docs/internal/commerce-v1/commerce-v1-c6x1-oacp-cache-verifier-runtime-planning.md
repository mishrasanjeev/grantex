# Commerce V1 C6X1 OACP Cache and Verifier Runtime Planning

## Scope

C6X1 is an internal planning and test slice for persistent OACP artifact cache behavior in AgenticOrg and artifact issuance/verifier runtime boundaries in Grantex. It defines the contract shape and guardrails for later implementation work. It does not add runtime execution behavior.

Grantex remains the trust, protocol, policy, and canonical OACP artifact authority. AgenticOrg remains the buyer and seller AI-agent runtime. Merchant systems remain operational sources of record. Provider and fintech rails own mandate and payment execution.

## Correct Ownership Model

- AgenticOrg owns buyer and seller agent runtime behavior, local cache consumption, source-aware messaging, and fail-closed handling.
- Grantex owns canonical OACP artifact schemas, issuance policy, verifier policy, revocation posture, and artifact lineage rules.
- Merchant systems own operational facts such as catalog, inventory, fulfillment, order state, support state, return state, and refund state.
- Provider and fintech rails own mandate capability, mandate setup, payment authorization, capture, settlement, payout, and provider-owned evidence.
- Valid cached OACP artifacts may support non-binding interactions without requiring Grantex in every agent turn.
- Commitment-bound actions still require freshness, revocation, risk, refusal, human/source confirmation, and handoff rules from the C6W3 through C6W9 foundations.

## Planned Artifact Issuance Boundary

Future Grantex issuance work should define how canonical artifacts are minted, signed, versioned, and revoked without making Grantex a transaction toll booth. The planned issuer boundary should include:

- artifact family and schema version
- canonical artifact ID
- source authority and source family
- issued-at and expires-at timestamps
- TTL policy selected by artifact family
- revocation snapshot reference
- non-sensitive evidence references
- policy posture and unsupported capability wording
- non-enablement flags for checkout, payment, live provider rails, public discovery, and protocol publication

The issuer must not mint live execution instructions. It must not call providers, merchant private APIs, checkout systems, payment systems, carriers, shipping providers, or public discovery endpoints.

## Planned Verifier Runtime Boundary

Future Grantex verifier work should verify artifact shape, signature lineage, freshness, TTL, revocation posture, source authority, and policy posture. The verifier should return evidence about whether an artifact is locally usable for preview, preparation, or future handoff checks.

The verifier boundary must remain authority-side and non-executing. It must not approve payment, checkout, fulfillment, refund, shipment, mandate setup, settlement, payout, or merchant operational changes. It must not become a required toll booth for every non-binding buyer or seller agent interaction.

## AgenticOrg Cache Contract

AgenticOrg should persist only the OACP artifact cache data required for agent runtime decisions:

- cached artifact envelope
- artifact family and ID
- source authority
- issued-at, received-at, and expires-at timestamps
- TTL and freshness status
- revocation snapshot reference and age
- signature or verifier result reference
- non-sensitive evidence references
- blocked and unsupported capability wording
- non-enablement flags
- last local validation result

The cache should support non-binding preview, education, comparison, explanation, buyer-question preparation, seller-agent remediation suggestions, and prepared-only handoff flows when artifacts are valid. It must fail closed for stale, expired, revoked, ambiguous, missing, mismatched, or unsafe artifacts.

## Freshness, Revocation, And TTL Defaults

Initial planning keeps the C6W5 TTL posture unless a future approved slice changes it:

| Artifact family | Planning TTL posture |
| --- | --- |
| merchant capability | 24h |
| seller agent capability | 6h |
| policy | 6h |
| catalog | 6h |
| offer | 15m |
| price | 5m, or 60s for dynamic price |
| inventory | 60s, or 30s for high-velocity goods |
| public discovery display facts | 15m display/read only |
| mandate capability | 2m at commitment boundary |
| protocol adapter | 24h max and never longer than referenced artifacts |

Verifier planning must treat revocation state as fail-closed. A missing or stale revocation snapshot cannot be overridden by adapter previews, seller cards, cached summaries, or user text.

## Evidence References

Grantex may retain non-sensitive evidence references when policy or artifact lineage requires them. It must not store raw credentials, raw JWTs, raw provider payloads, private merchant API URLs, DB or Redis URLs, private keys, production allowlist values, or private customer data inside OACP artifacts or verifier planning artifacts.

Evidence references should be redacted, deterministic where useful, and traceable to source family and authority. They are lineage pointers, not operational payloads.

## Non-Binding Versus Commitment-Bound Use

Non-binding interactions may continue from valid cached artifacts:

- browse merchant profile
- inspect seller card
- compare catalog summaries
- explain policy
- explain capabilities
- show source and freshness labels
- prepare buyer questions
- prepare seller-agent remediation suggestions

Commitment-bound or commitment-adjacent actions must use the C6W5 through C6W9 fail-closed chain before any future execution handoff can be considered. C6X1 does not approve or implement execution handoff.

## Fail-Closed Rules

Planning requires fail-closed behavior when:

- cached artifact envelope is missing
- signature or verifier result is missing or invalid
- source authority is missing or mismatched
- artifact family is unsupported or mismatched
- issued-at, expires-at, TTL, freshness, or revocation posture is missing
- artifact is stale, expired, revoked, ambiguous, or superseded
- evidence refs are missing for commitment-bound checks
- evidence refs are raw, private, or unredacted
- adapter preview tries to override missing, expired, or revoked canonical artifacts
- risk, amount, currency, quantity, mandate, price, inventory, or policy posture is ambiguous
- any field implies checkout, payment, live provider rails, public discovery enablement, merchant private API calls, protocol publication, certification, conformance, production launch, or execution approval

## Guardrails

C6X1 guardrails require:

- docs/tests/planning-first only
- no runtime code
- no public endpoint
- no public OACP publication
- no checkout or payment enablement
- no live provider rail enablement
- no merchant private API execution
- no production config change
- no production allowlist assignment
- no OpenAPI runtime contract
- no migration
- no workflow
- no public docs navigation entry
- no landing page runtime UI
- no blog post publication
- no certification, compliance, conformance, standardization, production-readiness, public-launch-readiness, merchant-approval, checkout-approval, payment-approval, live-provider-readiness, or execution-readiness claim

## What This Does Not Enable

C6X1 does not enable public discovery, production Commerce V1, checkout, payment, live provider rails, live mandate behavior, merchant private APIs, carrier or shipping calls, production audit persistence, OACP publication, or any execution controller.

## Future Work

Future slices would need separate approval for:

- persistent AgenticOrg cache implementation
- Grantex artifact issuance implementation
- Grantex verifier runtime implementation
- signature verification plumbing
- revocation snapshot distribution
- cache invalidation and refresh jobs
- production audit persistence
- controlled execution handoff ownership
- merchant-system and provider-owned execution contracts

Those future slices must keep non-binding cached agent interactions from routing through Grantex on every turn, and must preserve provider and merchant operational ownership.
