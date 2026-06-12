# Commerce V1 C6W5 - Commitment Boundary Resolver

Status: implementation foundation, internal-only, non-enabling.

## Scope

C6W5 defines a local commitment-boundary model over signed Grantex OACP artifacts and C6W4 adapter previews.

This slice adds pure helper logic and focused tests only. It does not add endpoints, migrations, workflows, routes, OpenAPI, production config, secrets, provider adapters, public discovery, checkout/payment, live provider, live Plural, merchant private API, or cloud behavior.

Grantex remains the canonical artifact, protocol, policy, and trust authority. AgenticOrg remains the buyer/seller agent runtime. Merchant systems remain operational sources of record, and provider or fintech rails own mandate and payment execution.

## Commitment Boundary Model

C6W5 classifies actions into four internal classes:

- Non-binding preview: browse merchant profile, inspect seller card, compare catalog summaries, explain policy, explain available capabilities, show source/freshness labels, prepare buyer questions, and prepare seller-agent remediation suggestions.
- Commitment-adjacent: prepare draft quote, prepare draft cart, ask merchant or seller agent to refresh source facts, prepare non-binding reservation request, prepare mandate capability check request, and prepare human confirmation prompt.
- Commitment-bound: price lock, inventory hold, reservation, order placement, payment intent, mandate setup/use, cancellation, refund request, return authorization, and support escalation with merchant SLA promise.
- Always blocked in C6W5: live payment execution, live Plural/provider calls, public discovery enablement, production checkout/payment creation, merchant or provider private API calls, protocol publication/submission, certification/conformance claims, and final delivery/refund/settlement/payout promises without source artifact authority.

Every decision returns:

- action_class.
- allowed_to_preview.
- allowed_to_prepare.
- allowed_to_execute: false.
- refusal_or_escalation_reason.
- required fresh artifact families.
- source artifact IDs and families.
- source authority.
- freshness summary.
- risk tier.
- offline mode status.
- buyer-safe message.
- blocked capabilities.
- non-authoritative and non-enablement flags.

## Offline Commitment Mode

Non-binding preview may continue from valid cached artifacts and a valid adapter preview. Commitment-adjacent and commitment-bound actions may only prepare local requests when required artifact families are present, valid, scoped, fresh, and within TTL/risk posture.

If Grantex is unavailable and TTL is valid, AgenticOrg may continue preview and prepare non-executing commitment requests from cache. If a buyer asks for a final commitment while Grantex is unavailable, C6W5 returns prepared-not-executed wording unless the action is blocked. Critical actions are blocked offline.

Adapter previews cannot override expired, revoked, missing, stale, or ambiguous OACP artifacts. Seller cards and protocol adapters are never transaction authority.

## TTL And Risk Defaults

Artifact TTL defaults remain pinned:

- merchant capability: 24h.
- seller agent capability: 6h.
- policy: 6h.
- catalog: 6h.
- offer: 15m.
- price: 5m, or 60s for dynamic price.
- inventory: 60s, or 30s for high-velocity goods.
- public discovery: 15m display/read only.
- mandate capability: 2m at commitment boundary.
- protocol adapter: 24h max and never longer than referenced artifacts.

First-release risk caps remain conservative:

- Low: up to INR 25,000 / USD 300 equivalent, non-binding draft/quote only.
- Medium: up to INR 10,000 / USD 125 equivalent for price-lock, inventory-hold, reservation, and support preparation with source confirmation.
- High: up to INR 5,000 / USD 60 equivalent for order/payment/cancel/refund/return preparation, still non-executing in C6W5.
- Critical: blocked offline.

Missing or ambiguous amount, currency, or quantity increases risk posture and fails closed for preparation.

## Toll Booth Boundary

Grantex does not become a synchronous toll booth for browse, comparison, education, recommendation, or other non-binding messages. Grantex issues and validates canonical artifacts and adapter descriptors; AgenticOrg can use cached valid artifacts locally subject to TTL, revocation, freshness, unsupported capabilities, and scope rules.

## What This Does Not Enable

C6W5 does not enable:

- Public discovery.
- Production Commerce V1.
- Checkout/payment creation.
- Payment capture or debit.
- Live payments.
- Live provider use.
- Live Plural use.
- Provider calls.
- Carrier or shipping provider calls.
- Merchant private API calls.
- Connector credential export.
- Production allowlists.
- Public OACP publication.
- External protocol submission.
- Certification, compliance, conformance, standardization, production readiness, public-launch readiness, merchant approval, checkout approval, payment approval, live provider readiness, or OACP public readiness claims.

## Future Slices

Future implementation must still add separate evidence, controls, and approvals before any execution:

- Provider-owned mandate verification boundary with non-production evidence only.
- Merchant connector evidence path from dry-run source snapshots to Grantex canonical facts.
- Human confirmation and reconciliation contracts.
- Explicit execution rails outside C6W5 with provider and merchant system authority.
