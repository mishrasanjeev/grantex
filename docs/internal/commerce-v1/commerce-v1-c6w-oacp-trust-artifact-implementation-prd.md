# C6W OACP Trust Artifact Implementation PRD

Status: draft for human review only

Date: 2026-06-11

Scope: Documentation and architecture for implementing the Open Agentic Commerce Protocol future position across Grantex and AgenticOrg.

This PRD does not approve public launch, public discovery, production Commerce V1, checkout/payment creation, live payments, live Plural, provider calls, merchant private API calls, production allowlists, external protocol submission, certification, compliance, conformance, standardization, production readiness, public-launch readiness, merchant approval, checkout approval, payment approval, or live-provider approval.

## 0. Human Architecture Decisions Recorded

These decisions are accepted for this draft and must be designed explicitly:

- AgenticOrg artifact cache is scoped across all four dimensions: tenant, merchant, seller agent, and buyer agent.
- If Grantex is unavailable and artifact TTL is still valid, AgenticOrg continues non-binding discovery and decision support.
- If Grantex is unavailable and a buyer asks for a final commitment, AgenticOrg may continue only through Offline Commitment Mode.
- Seller agents are allowed to initiate connector sync jobs, subject to scoped authorization, audit, throttling, and evidence review.
- AgenticOrg may directly verify provider-owned mandate capability, subject to provider rules, user consent, jurisdiction, and no raw credential exposure.
- Third-party agents may consume AgenticOrg seller agent cards directly, but cards must carry OACP/Grantex artifact references and verification metadata.
- First internal E2E should target AI chat and agent surfaces such as ChatGPT-style, Claude Code-style, Gemini-style, and Perplexity-style experiences, using available integration surfaces rather than assuming privileged platform access.

## 1. Product Thesis

Open Agentic Commerce Protocol should not compete with ACP, UCP, AP2, A2A, MCP, x402, or schema.org. OACP should be the trust and interoperability profile that makes those protocols safe across real merchant systems and autonomous buyer/seller agents.

The clean future position is:

> OACP is a trust and interoperability profile for signed commerce artifacts, merchant-system evidence, policy enforcement, revocation, and protocol adapters across ACP, UCP, AP2, A2A, MCP, x402, and schema.org.

Grantex is the reference trust authority implementation. AgenticOrg is the reference agent-runtime implementation. Neither product should claim to own the open protocol by itself.

## 2. Why This Exists

The repo history shows strong foundations:

- Grantex has sandbox onboarding, readiness checks, public-safe previews, connector dry-run/review/remediation foundations, order foundations, provider sandbox contracts, compatibility fixtures, preview gates, and internal roadmap docs.
- AgenticOrg has a Grantex commerce connector, buyer discovery/session guardrails, refusal and source/freshness projection work, commerce sales agent prompt work, and many generic connectors/channels.

The gap is product and protocol clarity:

- AgenticOrg must be the place where buyer and seller agents are created and operated.
- Grantex must not be the runtime middleman for every buyer/seller interaction.
- Grantex must be the authority that signs, verifies, refreshes, and revokes commerce trust artifacts.
- Merchant systems must remain systems of record.
- Payment and mandate rails must own payment and mandate execution.
- OACP must interoperate with existing protocols instead of trying to replace them.

## 3. Non-Goals

OACP is not:

- A checkout protocol replacement.
- A payment rail.
- A wallet.
- A mandate provider.
- A merchant ERP.
- A Shopify or WooCommerce clone.
- A buyer/seller chat runtime.
- A claim of certification or standards acceptance.
- A reason to route every transaction through Grantex.

## 4. Reference Implementation Roles

### 4.1 Grantex Role

Grantex should implement the OACP trust authority profile:

- Canonical commerce schema registry.
- Signed commerce artifact issuance.
- Artifact verification and status.
- Artifact revocation and emergency disablement.
- Merchant source evidence review.
- Public discovery gates.
- Policy evaluation.
- Consent, session, passport, and commitment evidence.
- Optional mandate capability evidence verification.
- Protocol adapter generation.
- Audit and evidence retention.
- Compatibility fixtures and release gates.

Grantex should not own:

- Buyer agent runtime.
- Seller agent runtime.
- Buyer/seller conversation workflow.
- Raw merchant system operation.
- Raw payment credentials.
- Payment execution.
- Mandate creation.
- Carrier execution.
- Customer support execution.

### 4.2 AgenticOrg Role

AgenticOrg should implement the OACP agent runtime profile:

- Buyer Commerce Agent creation.
- Seller Commerce Agent creation.
- Buyer/seller channel UX.
- Seller connector setup UX.
- Merchant remediation workflow.
- Artifact cache and verifier.
- Channel-specific refusal packs.
- Commitment-boundary resolver.
- Grantex artifact refresh calls when needed.
- Buyer-safe explanation of signed facts.
- Seller-facing explanation of Grantex blockers.

AgenticOrg should not own:

- Canonical commerce truth.
- Public discovery approval.
- Protocol certification claims.
- Direct buyer-agent calls to merchant private APIs for authoritative commerce.
- Direct provider calls for Agentic Commerce payment execution.
- Raw provider credential custody for commerce.

### 4.3 Merchant System Role

Merchant systems own operations:

- Catalog source.
- Product media.
- Variant/SKU source.
- Price source.
- Tax source.
- Inventory source.
- Order management.
- Fulfillment.
- Returns.
- Refund operations.
- Warranty.
- Support.
- Billing and ERP records.

Examples:

- Shopify.
- WooCommerce.
- Magento.
- BigCommerce.
- Custom storefront.
- PIM.
- ERP.
- OMS.
- WMS.
- Billing.
- CRM/support.
- Logistics and carrier systems.

### 4.4 Payment and Mandate Rail Role

Payment and mandate providers own regulated financial actions:

- Customer authentication.
- Mandate creation.
- Mandate revocation.
- Payment authorization.
- Debit/capture.
- Settlement.
- Refund execution.
- Dispute and chargeback process.
- Provider risk decisioning.

Examples:

- Plural.
- UPI reserve.
- UPI one-time mandate.
- UPI AutoPay or e-mandate where legally approved.
- x402-compatible payment rails.
- MPP-compatible payment rails.
- PSPs.
- Wallets.
- Banks.

Grantex may verify or record only non-sensitive mandate capability evidence when that evidence is needed for cross-agent trust, policy enforcement, audit, or adapter mapping.

## 5. OACP Conceptual Layers

### 5.1 Trust Artifact Profile

Defines signed, versioned, expiring commerce artifacts that agents can use without making Grantex a synchronous dependency for every interaction.

### 5.2 Merchant System Evidence Profile

Defines how raw merchant system data becomes reviewed, redacted, source-stamped, and publishable buyer-safe facts.

### 5.3 Commitment Boundary Profile

Defines which actions require online authority checks and which actions can proceed from unexpired signed artifacts.

It also defines Offline Commitment Mode for cases where Grantex is temporarily unavailable. Offline commitment is not an unrestricted bypass. It is allowed only when all required signed artifacts explicitly allow offline commitment, the artifact TTLs are valid, the local revocation snapshot is fresh enough for the action risk tier, the provider or merchant system can verify the required capability directly, and AgenticOrg records evidence for later Grantex reconciliation.

### 5.4 Protocol Adapter Profile

Defines mappings from canonical OACP artifacts to:

- schema.org JSON-LD.
- UCP-style capability profiles.
- ACP-style action and checkout shapes.
- AP2-style evidence shapes.
- A2A agent card references.
- MCP commerce tools.
- x402-style payment capability hints where applicable.

### 5.5 Compatibility Fixture Profile

Defines positive and negative fixtures for signed artifacts, stale artifacts, revoked artifacts, unsupported payment claims, private data leakage, and unsafe public discovery claims.

## 6. Signed Artifact Envelope

Every OACP signed artifact should use a stable envelope.

Required envelope fields:

- artifact_id.
- artifact_type.
- schema_version.
- issuer.
- issuer_key_id.
- subject_type.
- subject_id.
- tenant_id.
- merchant_id when applicable.
- buyer_agent_id when applicable.
- seller_agent_id when applicable.
- source_system_refs when applicable.
- issued_at.
- expires_at.
- not_before.
- source_observed_at.
- freshness_class.
- revocation_status_url.
- policy_version.
- adapter_version.
- evidence_refs.
- payload_hash.
- signature_alg.
- signature.

Required safety fields:

- public_safe.
- contains_private_data.
- allowed_agent_uses.
- forbidden_agent_uses.
- commitment_allowed.
- offline_commitment_allowed.
- requires_online_confirmation.
- requires_provider_direct_verification.
- requires_merchant_system_confirmation.
- stale_behavior.
- refusal_code_if_invalid.

Payload must never include:

- Raw provider credentials.
- Raw merchant private API credentials.
- Raw bank details.
- Raw card details.
- Raw JWTs.
- Raw private provider payloads.
- Private customer identifiers.
- Secrets.
- Production allowlist values.

### 6.1 First Internal Artifact Signature Format

The first internal OACP artifact format should be canonical JSON with detached JWS signatures.

Decision:

- Artifact payloads remain normal JSON documents so Grantex, AgenticOrg, adapters, docs, and tests can inspect them without token-specific decoding.
- The signed bytes use JSON Canonicalization Scheme style deterministic canonical JSON.
- The signature is a detached JWS over the canonical payload hash.
- The first signing algorithm should be ES256 because the current ecosystem already has JWKS/JWT/JWS operational patterns. EdDSA/Ed25519 can be evaluated later.
- Each artifact includes `issuer`, `issuer_key_id`, `signature_alg`, `payload_hash`, and `signature`.
- Public verification keys are published through a Grantex-controlled JWKS-style key endpoint or equivalent OACP trust metadata endpoint.

Rejected for first internal version:

- JWT as the artifact container. OACP artifacts are commerce facts and evidence, not identity tokens. JWT can still be used for sessions/passports where appropriate.
- COSE as the first version. COSE may be useful later for wallet/device-native signatures, but it adds unnecessary implementation burden for the first web/service reference path.
- Simple ad hoc signed JSON. It is too easy to create incompatible canonicalization and verification behavior.

## 7. Artifact Types

### 7.1 Merchant Capability Artifact

Purpose: proves what a merchant is allowed to expose to agents.

Fields:

- merchant_display_name.
- merchant_category.
- supported_countries.
- supported_currencies.
- commerce_status.
- public_discovery_state.
- seller_agent_refs.
- allowed_protocol_adapters.
- blocked_capabilities.
- support_policy_summary.
- return_policy_summary.
- warranty_policy_summary.
- source_evidence_refs.

### 7.2 Seller Agent Capability Artifact

Purpose: lets buyer agents and other agents understand what the seller agent can safely do.

Fields:

- seller_agent_id.
- merchant_id.
- agent_runtime.
- supported_channels.
- supported_tasks.
- forbidden_tasks.
- human_review_required_tasks.
- artifact_refresh_policy.
- public_claim_limits.

### 7.3 Catalog Snapshot Artifact

Purpose: buyer-safe catalog browsing and comparison.

Fields:

- catalog_snapshot_id.
- product_refs.
- category_refs.
- source_system_refs.
- source_observed_at.
- expires_at.
- media_policy.
- private_field_redaction_status.
- sample_count.
- completeness_score.

### 7.4 Offer Price Artifact

Purpose: buyer-safe price, discount, tax, and currency claims.

Fields:

- product_id.
- variant_id.
- price.
- currency.
- tax_summary.
- discount_summary.
- offer_valid_from.
- offer_valid_until.
- price_lock_allowed.
- price_lock_requires_online_confirmation.
- source_observed_at.

### 7.5 Inventory Freshness Artifact

Purpose: buyer-safe inventory claims.

Fields:

- product_id.
- variant_id.
- availability_state.
- quantity_bucket.
- location_scope when allowed.
- source_observed_at.
- expires_at.
- hold_allowed.
- hold_requires_online_confirmation.
- stale_inventory_refusal.

### 7.6 Policy Artifact

Purpose: buyer-safe merchant policy summaries.

Fields:

- return_policy_summary.
- warranty_policy_summary.
- fulfillment_policy_summary.
- cancellation_policy_summary.
- support_policy_summary.
- jurisdiction_scope.
- last_reviewed_at.
- evidence_refs.

### 7.7 Public Discovery Artifact

Purpose: controls whether a merchant or seller agent may appear in public agentic discovery.

Fields:

- discovery_state.
- allowed_surfaces.
- blocked_surfaces.
- display_name.
- public_description.
- allowed_protocol_adapters.
- approval_evidence_refs.
- rollback_evidence_ref.
- emergency_disable_ref.

### 7.8 Mandate Capability Evidence Artifact

Purpose: optional non-sensitive proof that a provider-owned payment or mandate capability exists and is scoped for agentic use.

This artifact must not be a payment credential and must not let any party debit funds by itself.

Fields:

- provider_key.
- rail_type.
- jurisdiction.
- mandate_capability_ref.
- buyer_agent_id.
- merchant_scope.
- category_scope.
- max_amount.
- currency.
- recurrence_or_frequency.
- expires_at.
- revocation_status.
- challenge_required_conditions.
- verification_mode.
- evidence_ref.
- agenticorg_direct_verification_allowed.
- grantex_evidence_required_after_commitment.

### 7.9 Commitment Evidence Artifact

Purpose: proves that a final commitment boundary was checked.

Examples:

- Price lock.
- Inventory hold.
- Reservation.
- Order creation.
- Payment intent.
- Cancellation.
- Refund request.
- Return authorization.
- Support escalation.

Fields:

- commitment_id.
- commitment_type.
- buyer_agent_id.
- seller_agent_id.
- merchant_id.
- artifact_refs_used.
- online_check_required.
- online_check_performed_at.
- offline_commitment_mode.
- grantex_unavailable_reason.
- provider_direct_verification_ref.
- merchant_system_confirmation_ref.
- local_revocation_snapshot_id.
- queued_grantex_reconciliation_required.
- reconciliation_deadline.
- policy_decision.
- refusal_code when denied.
- provider_evidence_ref when applicable.
- audit_event_id.

### 7.10 Revocation Artifact

Purpose: lets AgenticOrg and other runtimes fail closed without calling Grantex for every low-risk interaction.

Fields:

- revocation_list_id.
- revoked_artifact_ids.
- revoked_subject_ids.
- reason_codes.
- effective_at.
- expires_at.
- emergency_disable.
- issuer_key_id.
- signature.

## 8. Transaction Routing Matrix

| Action | Can use signed artifacts? | Needs online Grantex? | Reason |
| --- | --- | --- | --- |
| Merchant browsing | Yes | No, unless artifact stale/revoked | Non-binding discovery |
| Product search | Yes | No, unless artifact stale/revoked | Non-binding discovery |
| Product comparison | Yes | No, unless price/inventory claim needs refresh | Non-binding decision support |
| Seller agent Q&A | Yes | No, unless making new commerce claim | Explanation |
| Draft cart | Yes | No if clearly non-final | Non-binding preparation |
| Quote preview | Yes | No if clearly non-final | Non-binding estimate |
| Price lock | No | Yes | Merchant obligation |
| Inventory hold | No | Yes | Merchant and buyer impact |
| Reservation | No | Yes | Merchant obligation |
| Order creation | No | Yes | Legal/commercial commitment |
| Payment intent | No | Yes | Financial commitment evidence |
| Mandate capability binding | No | Yes | Scope and revocation risk |
| Refund request | No | Yes | Financial/support commitment |
| Cancellation | No | Yes | Merchant/order state change |
| Return authorization | No | Yes | Merchant support obligation |
| Support escalation with SLA | No | Yes | Merchant obligation |
| Public discovery publish/unpublish | No | Yes | Public trust boundary |
| Emergency disablement | No | Yes | Safety boundary |

### 8.1 Offline Commitment Mode

Human decision: final commitments should continue during Grantex unavailability when the system can do so safely.

Offline Commitment Mode is allowed only when all conditions are true:

- All required artifacts are signed, unexpired, and scoped to the tenant, merchant, seller agent, and buyer agent.
- The relevant artifacts set `offline_commitment_allowed: true`.
- The action is within amount, currency, category, merchant, geography, quantity, and frequency limits.
- The local revocation snapshot is inside the allowed freshness window for the action risk tier.
- The merchant system or seller-side connector can confirm the operational fact directly when required.
- The payment or mandate provider can verify the provider-owned capability directly when required.
- AgenticOrg records a local commitment evidence artifact.
- AgenticOrg queues Grantex reconciliation with a deadline.
- The buyer sees that the action proceeded during authority-service unavailability and will be reconciled.

Offline Commitment Mode must refuse when:

- Any required artifact is expired, revoked, missing, ambiguous, or outside scope.
- A product price, tax, fee, discount, delivery SLA, inventory hold, or mandate capability requires online confirmation and no direct provider/merchant confirmation is available.
- The action exceeds risk tier limits.
- The local revocation snapshot is stale.
- The seller agent card does not permit third-party/offline commitment.
- Provider or merchant confirmation fails.

Risk tier examples:

| Risk tier | Example | Offline allowed? |
| --- | --- | --- |
| Informational | Browse, compare, explain | Yes with valid artifacts |
| Low | Draft cart, non-binding quote | Yes with valid artifacts |
| Medium | Reservation or small inventory hold | Yes only if artifact permits and merchant confirms |
| High | Payment, mandate-bound purchase, refund | Yes only if artifact permits and provider verifies directly |
| Critical | Emergency disablement, public discovery publish, policy override | No |

First release monetary and quantity caps:

| Risk tier | Monetary cap | Quantity cap | Frequency cap | Notes |
| --- | --- | --- | --- | --- |
| Informational | No commitment value cap because no commitment is made | Maximum 100 listed products or 20 compared products per buyer request | No more than 30 informational requests per buyer-agent/merchant/hour before throttling | Browse and compare only. No promise, lock, hold, order, payment, refund, or return action. |
| Low | Up to INR 25,000 or USD 300 equivalent per non-binding draft cart or quote preview | Up to 10 total units, maximum 5 units per SKU | 10 draft carts or quote previews per buyer-agent/merchant/day | Non-binding only. Buyer-facing language must say prices and availability require confirmation before commitment. |
| Medium | Up to INR 10,000 or USD 125 equivalent per price lock, inventory hold, or provisional reservation | Up to 5 total units, maximum 2 units per SKU | 3 active holds or reservations per buyer-agent/merchant, maximum 6 per day | Requires artifact permission and merchant/source confirmation. Default hold duration is 15 minutes or shorter artifact TTL. |
| High | Up to INR 5,000 or USD 60 equivalent per `order_pending_reconciliation`, payment-intent attempt, cancellation, refund request, or return authorization request | Up to 3 total units, maximum 1 high-value unit per SKU | 2 high-risk offline actions per buyer-agent/merchant/day | Requires artifact permission plus direct provider verification for payment/mandate actions or direct merchant/source confirmation for operational actions. No payment capture, refund execution, settlement, payout, or fulfillment start. |
| Critical | Offline not allowed | Offline not allowed | Offline not allowed | Includes public discovery publication, merchant approval/suspension, emergency disablement, policy override, production allowlists, and live-provider enablement. |

Currency handling:

- Use merchant-configured local-currency caps when available.
- If both INR/USD defaults and merchant-specific caps are present, the stricter cap wins.
- If neither a merchant-specific cap nor a reliable configured currency conversion exists for the merchant currency, Offline Commitment Mode must refuse commitment actions.
- A future implementation may lower caps by category, buyer risk, seller trust tier, jurisdiction, or provider mandate scope. It must not raise these defaults without explicit approval.

### 8.2 First Implementation Offline Commitment Decisions

The first implementation should allow only commitments that are either reversible, provisional, explicitly provider/merchant-confirmed, or support-oriented.

Allowed in first implementation:

- Price lock: allowed only when the offer artifact permits offline lock, price TTL is valid, amount/currency limits pass, and merchant/source confirmation succeeds.
- Inventory hold: allowed only for small quantity or bucketed inventory holds when inventory artifact permits offline hold and merchant/source confirmation succeeds.
- Reservation: allowed only as provisional reservation with expiry, merchant/source confirmation, and queued Grantex reconciliation.
- Order: allowed only as `order_pending_reconciliation` or equivalent non-fulfillment state. Merchant fulfillment must not start until provider/merchant checks pass and reconciliation is queued.
- Payment intent: allowed only through Plural P3P direct provider verification in sandbox/approved environment. No raw provider credentials may enter agent-facing flows.
- Cancellation: allowed only when original order artifact permits offline cancellation and merchant/source confirmation succeeds.
- Refund request: allowed only as request intake, not refund execution.
- Return authorization: allowed only as provisional authorization or request intake unless merchant/source confirms the authorization.
- Support escalation: allowed when it creates a ticket or queue entry, not a hard SLA or financial obligation unless merchant/source confirms.

Not allowed in first implementation:

- Payment capture/debit without provider direct verification.
- Refund execution.
- Settlement or payout action.
- Public discovery publish/unpublish.
- Merchant approval or suspension.
- Policy override.
- Emergency disablement.
- High-value order beyond configured risk cap.
- Any commitment with expired, revoked, missing, ambiguous, or out-of-scope artifacts.

### 8.3 Revocation Snapshot Age By Risk Tier

Offline Commitment Mode must enforce both artifact TTL and revocation snapshot age. The stricter of the two wins.

| Risk tier | Examples | Maximum local revocation snapshot age |
| --- | --- | --- |
| Informational | Browse, compare, seller Q&A | 24 hours |
| Low | Draft cart, non-binding quote, policy explanation | 6 hours |
| Medium | Price lock, small inventory hold, provisional reservation, support ticket | 15 minutes |
| High | Order pending reconciliation, payment intent, cancellation, refund request, return authorization | 2 minutes |
| Critical | Public discovery state, merchant approval/suspension, policy override, emergency disablement | Offline not allowed |

Inventory, price, and mandate artifacts may require shorter TTLs than the revocation snapshot window. For example, an inventory artifact with a 60-second TTL cannot support an offline hold after 60 seconds even if the revocation snapshot is still inside the 15-minute medium-risk window.

### 8.4 Default Artifact TTLs

First internal TTL defaults:

| Artifact type | Default TTL | Offline final-commitment use | Rationale |
| --- | --- | --- | --- |
| Merchant profile/capability | 24 hours | Only for non-payment, non-publication eligibility checks; emergency revocation overrides immediately | Merchant identity changes slowly, but disablement must revoke immediately. |
| Seller agent capability | 6 hours | Yes only if seller card permits offline commitment and third-party consumption | Agent capabilities change more often than merchant profile. |
| Policy | 6 hours | Yes only for actions inside artifact limits; emergency policy revocation overrides immediately | Balances cache usefulness with policy-change risk. |
| Catalog snapshot | 6 hours | Browse and compare only unless paired with fresher offer/price/inventory artifacts | Product metadata is less volatile than price and stock. |
| Offer | 15 minutes | Price lock or quote only if artifact explicitly allows it | Offers can be promotional and must not live too long offline. |
| Price | 5 minutes default; 60 seconds for promotion-sensitive or dynamic categories | Price lock only when merchant/source confirms | Price is commercially sensitive and must be fresh. |
| Inventory | 60 seconds default; 30 seconds for high-velocity categories | Holds/reservations only when merchant/source confirms | Inventory is the most volatile operational fact. |
| Public discovery | 15 minutes for read/display; offline changes not allowed | No public discovery publish/unpublish offline | Discovery state is externally visible and must fail closed for changes. |
| Mandate capability | 2 minutes at commitment boundary; 15 minutes for non-binding display | Payment-intent attempt only when provider verifies directly | Mandate/payment capability is high risk and provider-owned. |
| Protocol adapter profile | 24 hours maximum, but never longer than the shortest referenced artifact | Adapter display only unless all referenced artifacts allow the action | Adapter output must not outlive the facts it represents. |
| Revocation snapshot | Use risk-tier table in section 8.3 | Required for all offline commitment checks | Revocation freshness is evaluated separately from artifact TTL; the stricter limit wins. |

TTL handling rules:

- The effective TTL for an action is the shortest relevant artifact TTL plus the local revocation snapshot window.
- If artifacts disagree on freshness or scope, AgenticOrg must refuse final commitment and may continue only non-binding discovery.
- Any explicit revocation, emergency disablement, production safety block, provider refusal, or merchant-system refusal overrides unexpired TTLs.

### 8.5 Revocation Propagation SLA Ownership

Revocation propagation is jointly owned by all systems in the chain. No single party can make autonomous commerce safe alone.

| Owner | SLA responsibility | First-release target |
| --- | --- | --- |
| Provider/fintech rail | Signal mandate/payment capability revocation, expiry, challenge failure, or provider-side block | Webhook or polling-visible update within 30 seconds for high-risk payment/mandate state |
| Merchant system or connector platform | Signal catalog, price, inventory, order, cancellation, return, support, and merchant disablement changes | Inventory/price within 60 seconds; emergency disablement within 30 seconds; other operational changes within 5 minutes |
| AgenticOrg | Ingest revocation/provider/merchant updates, purge local artifact cache, refuse stale commitments, and queue reconciliation | High/critical cache purge within 30 seconds of observed update; medium-risk refresh within 2 minutes |
| Grantex | Issue, revoke, and verify canonical artifacts; publish revocation status; reconcile evidence; keep audit trail | Artifact revocation status visible within 30 seconds of accepted revocation evidence |
| Buyer/seller channel bridge | Stop presenting stale commitments and refresh visible state | Next user-visible response or within 30 seconds for active transaction surfaces |

If any owner misses the SLA or the revocation state is ambiguous, the affected action must degrade to refusal or non-binding guidance according to risk tier.

## 9. Catalog, Price, and Inventory Update Model

### 9.1 Source of Updates

Catalog, price, and inventory updates originate in merchant systems:

- Shopify.
- WooCommerce.
- ERP.
- OMS.
- WMS.
- PIM.
- Pricing engine.
- Inventory system.
- CSV/manual upload for early sandbox.

### 9.2 AgenticOrg Responsibilities

AgenticOrg Seller Commerce Agent should:

- Guide connection setup.
- Explain field mapping.
- Initiate connector sync jobs when authorized.
- Run or request dry-run sync.
- Show missing fields.
- Show stale fields.
- Show conflict remediation.
- Prepare redacted evidence for Grantex review.
- Explain what Grantex will sign and what it will block.

Seller-initiated connector sync jobs must include:

- Tenant, merchant, and seller-agent scope.
- Source system type.
- Connector authorization reference.
- Sync mode: dry-run, evidence-only, or approved publish-candidate.
- Rate limit and retry policy.
- Redaction policy.
- Audit event.
- Result evidence packet.
- No automatic public discovery or final publication.

Seller agents may initiate without additional human approval only after a merchant admin has already authorized the connector and source scope:

- Read-only schema discovery.
- Read-only catalog sync dry-run.
- Read-only price sync dry-run.
- Read-only inventory freshness probe.
- Redacted sample fetch.
- Field mapping preview.
- Conflict detection.
- Policy completeness scan.
- Evidence packet generation.
- Sync status refresh.

Seller agents must not initiate without human approval:

- Writes to Shopify, WooCommerce, ERP, OMS, WMS, billing, CRM, or logistics systems.
- Price changes.
- Inventory changes.
- Order creation.
- Refund/cancellation execution.
- Credential creation, rotation, or privilege expansion.
- Public discovery publication.
- Any sync that exposes private fields to buyer agents.

### 9.3 Connector Credential Custody

Default decision: connector credentials should live where merchants are most comfortable and where least-privilege operational controls already exist.

Preferred custody order:

1. Merchant-owned connector platform or merchant-owned integration runtime.
2. External integration provider vault selected and authorized by the merchant.
3. AgenticOrg encrypted connector vault as a fallback for seller-agent-operated connectors, only when the merchant explicitly authorizes AgenticOrg to run that connector.
4. Grantex should not store raw Shopify, WooCommerce, ERP, OMS, WMS, PIM, billing, CRM, logistics, or provider connector credentials for this architecture.

Credential custody rules:

- Grantex receives only redacted evidence references, source metadata, artifact hashes, and capability summaries.
- AgenticOrg buyer agents never receive connector credentials.
- AgenticOrg seller agents may initiate connector sync jobs only through approved server-side connector execution paths.
- Connector scopes must be least-privilege and source-specific.
- Credential rotation, revocation, and access review must be visible to the merchant.
- If a merchant uses an external integration provider, AgenticOrg stores only the provider connection reference and non-sensitive health/status metadata.
- If AgenticOrg fallback vault is used, credentials must be encrypted, tenant-scoped, access-controlled, non-exportable through agent prompts, excluded from logs, and redacted from evidence packets.

### 9.4 Grantex Responsibilities

Grantex should:

- Review connector evidence.
- Normalize approved facts.
- Reject private or unsafe fields.
- Assign source and freshness classes.
- Sign artifacts.
- Publish artifact status and revocation state.
- Keep audit evidence.

### 9.5 Update Patterns

Catalog:

- Event/webhook preferred.
- Scheduled sync fallback.
- Manual/CSV dry-run for sandbox.
- Medium TTL unless product is promotion-sensitive.

Price:

- Event/webhook or frequent polling.
- Short TTL.
- Final price lock requires online confirmation.

Inventory:

- Event/webhook preferred.
- Frequent polling fallback.
- Very short TTL.
- Holds/reservations require online confirmation.

Policy:

- Manual review or slower sync.
- Longer TTL.
- Public policy changes require artifact refresh.

Emergency:

- Immediate artifact revocation.
- AgenticOrg must fail closed for final commitments.

## 10. Protocol Adapter Mapping

OACP should generate or define adapter profiles, not replace existing protocols.

| Target | OACP role | Grantex responsibility | AgenticOrg responsibility |
| --- | --- | --- | --- |
| schema.org | Public merchant/product/offer markup | Generate signed JSON-LD from approved artifacts | Render or link only signed JSON-LD |
| UCP-style | Commerce capability and product profile | Map capability/catalog/policy artifacts | Use capabilities in agent runtime |
| ACP-style | Action or checkout shape | Map commitment boundary and consent evidence | Use only at approved action boundaries |
| AP2-style | Mandate/payment/evidence shape | Map mandate capability and commitment evidence | Explain and confirm buyer intent |
| A2A | Agent card and task routing | Provide authority artifact references | Publish seller/buyer agent cards with Grantex refs |
| MCP | Tool interface | Expose Grantex authority tools | Call Grantex tools only at required boundaries |
| x402 | Payment capability hint | Map provider-owned capability evidence where applicable | Do not treat x402 hint as unrestricted spend authority |

### 10.1 Plural P3P First Rail Decision

The first provider-owned mandate/payment capability rail should be Plural P3P.

Implementation posture:

- Use real Plural P3P sandbox or approved non-production environment, not a mock substitute.
- Keep live Plural and live payments blocked until legal, provider, security, operations, and production approval exist.
- AgenticOrg may directly verify provider-owned Plural P3P capability only through approved server-side verification paths.
- AgenticOrg must not expose Plural credentials, tokens, webhook secrets, raw provider payloads, or raw customer identifiers to agents or public artifacts.
- Grantex should receive only non-sensitive capability evidence and reconciliation status.
- If real Plural P3P sandbox access, contract, or credentials are unavailable, implementation must stop and report the external blocker rather than replacing it with a mock.

Plural P3P capability evidence should include:

- provider_key: `plural_p3p`.
- environment: sandbox or approved non-production.
- capability_reference.
- buyer_agent_id.
- merchant_scope.
- amount and currency limits.
- recurrence or one-time scope.
- expiry.
- provider_verification_ref.
- verification_time.
- challenge_required flag.
- non-sensitive evidence hash.
- reconciliation_status.

## 11. API and Artifact Surface Plan

This is a design target, not implementation approval.

Potential Grantex surfaces:

- `GET /.well-known/oacp.json`
- `GET /commerce/oacp/artifacts/{artifact_id}`
- `GET /commerce/oacp/artifacts/{artifact_id}/status`
- `GET /commerce/oacp/revocations`
- `POST /commerce/oacp/artifacts/verify`
- `POST /commerce/oacp/connector-evidence/review`
- `POST /commerce/oacp/commitments/check`
- `POST /commerce/oacp/protocol-adapters/render`

Potential AgenticOrg surfaces:

- Seller Commerce Agent onboarding flow.
- Artifact cache.
- Artifact verifier.
- Channel refusal pack registry.
- Commitment boundary resolver.
- Connector evidence collector.
- Protocol adapter renderer for signed Grantex artifacts only.

## 12. UX Requirements

### 12.1 Seller UX

Seller should see:

- Connected systems.
- Last sync status.
- Grantex artifact status.
- Missing fields.
- Stale facts.
- Private-field blockers.
- Public discovery state.
- Protocol adapter previews.
- What buyer agents can see.
- What buyer agents cannot do.

### 12.2 Buyer UX

Buyer should see:

- Source and freshness.
- Binding vs non-binding status.
- Artifact expiry.
- Merchant approval state.
- Whether final confirmation is required.
- Why a claim was refused.
- Whether payment capability must be rechecked.
- Whether the action is online-confirmed or proceeding in Offline Commitment Mode.

### 12.2.1 Compact Channel Freshness UX

WhatsApp, Telegram, SMS, voice, and small chat surfaces must not overwhelm users with artifact metadata. Use progressive disclosure:

- Default line: `Verified 2m ago. Final confirmation required.`
- If offline: `Using valid signed data. Grantex sync pending.`
- If stale: `Data is stale. I can browse, not commit.`
- If payment capability needed: `Payment permission must be checked before purchase.`
- Details command: `details`, `why`, or tap/click disclosure.

For rich chat surfaces, use compact chips:

- `Source: Shopify`
- `Fresh: 2m`
- `Binding: no`
- `Final check: required`
- `Offline mode: queued`

For voice, read only the risk-relevant sentence:

- "I can compare these items, but I need confirmation before placing the order."
- "The store data is still valid, but Grantex is unavailable, so I can place this only if the merchant and payment provider confirm directly."

### 12.3 Operator UX

Operator should see:

- Artifact issuance queue.
- Evidence review queue.
- Revocation list.
- Emergency disablement.
- Adapter preview output.
- Compatibility fixture status.
- Audit event chain.

## 13. Security and Safety Requirements

Required:

- Signed artifacts.
- Key IDs and rotation.
- Expiry and not-before fields.
- Revocation list.
- Emergency disablement.
- Payload hashes.
- Audit event links.
- Private field redaction.
- Tenant and merchant boundaries.
- Buyer/seller agent identity binding.
- Scope and amount caps for mandate capability evidence.
- Refusal on stale, revoked, missing, ambiguous, or out-of-scope artifacts.

Forbidden:

- Raw provider credentials.
- Raw merchant private API credentials.
- Raw card or bank data.
- Raw JWTs.
- Private provider payload exposure.
- Buyer-agent direct merchant private API authority.
- AgenticOrg direct payment execution for Agentic Commerce.
- Production allowlist values in public docs.
- Certification or standards claims without approval.

## 14. Compatibility and Test Plan

Grantex should maintain:

- Positive artifact fixtures.
- Negative artifact fixtures.
- Revoked artifact fixtures.
- Expired artifact fixtures.
- Stale inventory fixtures.
- Unsafe payment claim fixtures.
- Private data leakage fixtures.
- Adapter mapping fixtures.
- Commitment boundary fixtures.

AgenticOrg should maintain:

- Artifact verification tests.
- Cache expiry tests.
- Revocation tests.
- Channel refusal tests.
- Seller connector evidence tests.
- Buyer discovery from cached artifact tests.
- Final commitment requires online authority tests.
- Billing/AP/Plural isolation tests.

## 15. Documentation Inventory To Update After Approval

Grantex docs:

- Master Commerce PRD.
- Commerce V1 build spec.
- Merchant operator guide.
- Developer guide.
- OpenAPI docs when surfaces are designed.
- Internal launch roadmap.
- C6V clean architecture PRD.
- OACP internal compatibility docs.
- Public documentation only after approval.

AgenticOrg docs:

- Product PRD.
- Buyer agent docs.
- Seller Commerce Agent docs.
- Connector setup docs.
- Commerce Grantex connector docs.
- Public discovery docs.
- Channel/refusal docs.
- Billing/AP/Plural isolation docs.
- docs.json or navigation only after final doc structure is approved.

## 16. Product Gap Analysis

| Area | Gap | Owner | Priority |
| --- | --- | --- | --- |
| Trust artifact schema | No complete signed artifact envelope exists | Grantex | P0 |
| Artifact verifier/cache | AgenticOrg does not yet have full OACP artifact cache and verifier | AgenticOrg | P0 |
| Commitment boundary resolver | No complete routing matrix in runtime | Both | P0 |
| Offline Commitment Mode | Final commitments need a safe degraded path when Grantex is unavailable | Both | P0 |
| Seller Commerce Agent onboarding | No full self-serve agent onboarding packet | AgenticOrg primary, Grantex intake | P0 |
| Merchant connector evidence | No tight Shopify/WooCommerce/ERP evidence-to-artifact path | Both | P0 |
| Mandate capability evidence | No clean provider-owned mandate evidence profile | Both plus provider | P0 |
| Protocol adapters | Internal preview only, not real adapter surfaces | Grantex primary, AgenticOrg render/use | P0 |
| Revocation propagation | Needs artifact revocation and cache invalidation | Both | P0 |
| Payment path isolation | Generic payment tools risk confusion | AgenticOrg | P0 |
| Channel packs | Chat/WhatsApp/Telegram/third-party agent UX not fully specified | AgenticOrg | P1 |
| Order/fulfillment/refund | Post-purchase lifecycle incomplete | Grantex authority, merchant systems execution | P1 |
| Standards governance | Neutral public OACP governance not created | External future | P2 |

## 17. Implementation Roadmap After Approval

### C6W1 - OACP Artifact Envelope Design

Docs/tests only. Define JSON schema, TTL, revocation, payload hash, signature, and safety fields.

### C6W2 - Grantex Artifact Authority Foundation

Implement draft/internal artifact issue/verify/status helpers without public launch.

### C6W3 - AgenticOrg Artifact Verifier and Cache

Implement local verifier/cache for signed artifacts and fail-closed refusal.

### C6W4 - Commitment Boundary Resolver

Implement the routing matrix for cached vs online Grantex behavior.

### C6W5 - Offline Commitment Mode

Implement docs/tests first for Grantex-unavailable final commitment behavior, provider direct verification, merchant system confirmation, local evidence, queued reconciliation, and fail-closed rules.

### C6W6 - Plural P3P Capability Evidence

Design and implement the first real provider-owned mandate/payment capability verification path using Plural P3P sandbox or approved non-production integration. No mock substitute. Live mode remains blocked.

### C6W7 - Seller Commerce Agent Onboarding Packet

Define and implement AgenticOrg seller onboarding packet and Grantex intake validation.

### C6W8 - Merchant Connector Evidence Path

Start with Shopify/WooCommerce-style sandbox evidence fixtures and dry-run review.

### C6W9 - Mandate Capability Evidence Profile

Define optional provider-owned mandate capability evidence without payment execution.

### C6W10 - Protocol Adapter Profile

Generate internal adapter previews from signed artifacts.

### C6W11 - Channel Refusal and Confirmation Packs

Define buyer/seller channel behavior for web, API, WhatsApp, Telegram, and third-party agent hosts.

### C6W12 - Real Agent-Surface E2E Bridge

Build a real hosted OACP Agent Gateway that exposes MCP, A2A, and OpenAPI bridges for ChatGPT-style, Claude Code-style, Gemini-style, and Perplexity-style testing. Use real staging/non-production Grantex, AgenticOrg, merchant connector sandbox, and Plural P3P sandbox paths. No mock adapters.

First bridge matrix:

| Target surface | First bridge | Required behavior | Notes |
| --- | --- | --- | --- |
| ChatGPT-style | Hosted HTTPS OpenAPI tool/action bridge exposed by OACP Agent Gateway | Buyer/seller agent actions call real AgenticOrg staging APIs and Grantex artifact verification where required | Use OpenAPI because it is the most broadly compatible web-agent bridge. If direct platform access is unavailable, use a platform-compatible tool runner that calls the same real hosted endpoints. |
| Claude Code-style | MCP streamable HTTP bridge exposed by OACP Agent Gateway | Tools expose seller-card read, buyer discovery, artifact verification, commitment preflight, and refusal paths | MCP is the cleanest first bridge for code-agent and CLI-agent workflows. |
| Gemini-style | A2A task bridge plus OpenAPI fallback | Agent card advertises task capabilities; task execution calls real AgenticOrg/Grantex staging paths | A2A is the preferred agent-to-agent bridge; OpenAPI fallback keeps the first E2E runnable if A2A client support is incomplete. |
| Perplexity-style | Hosted answer/search bridge plus OpenAPI read endpoints | Responses must include source/freshness citations and must refuse unsupported commitments | Perplexity-style flows should start with research/discovery and only hand off to commitment preflight through OpenAPI. |

No-mock rule:

- The bridge may use a harness to emulate the chat surface if a proprietary platform account or UI automation path is unavailable.
- The harness must not fake commerce responses.
- Every E2E path must call the real hosted OACP Agent Gateway, real non-production AgenticOrg runtime, real non-production Grantex artifact authority, real merchant connector sandbox, and real Plural P3P sandbox or approved non-production provider path.
- If any real non-production dependency is unavailable, the E2E must stop and report an external blocker.

### C6W13 - End-to-End Sandbox Rehearsal

Run a fake merchant through seller agent onboarding, connector evidence, Grantex artifact issuance, buyer discovery, final commitment refusal/approval boundaries, and adapter preview.

## 18. Acceptance Criteria

Before implementation proceeds, reviewers must agree:

- OACP is a trust and interoperability profile, not a checkout replacement.
- Grantex is a reference trust authority, not the transaction engine.
- AgenticOrg is the reference agent runtime.
- Merchant systems remain operational sources of record.
- Payment/mandate providers own regulated financial actions.
- Cached signed artifacts can support non-binding discovery.
- Final commitments require online authority checks unless Offline Commitment Mode is explicitly allowed by signed artifacts, provider/merchant verification succeeds, and reconciliation evidence is queued.
- Protocol adapters are generated from signed canonical artifacts.
- No public launch or standards claim is made.

## 19. Resolved Defaults And Remaining Hard Questions

Resolved defaults:

1. First offline monetary and quantity caps are defined in section 8.1.
2. Artifact TTL defaults are defined in section 8.4.
3. Connector credential custody is defined in section 9.3: merchant-owned or external integration vault first, AgenticOrg encrypted fallback only with explicit merchant authorization, and no raw merchant-system connector credentials in Grantex.
4. Revocation propagation is jointly owned by providers, merchant systems, AgenticOrg, Grantex, and channel bridges, with first-release SLA targets in section 8.5.
5. First internal artifact signature format is canonical JSON with detached JWS signatures, as defined in section 6.1.
6. First E2E bridges are defined in C6W12: ChatGPT-style via hosted OpenAPI bridge, Claude Code-style via MCP streamable HTTP, Gemini-style via A2A plus OpenAPI fallback, and Perplexity-style via hosted answer/search plus OpenAPI read/commit-preflight endpoints.

Remaining hard questions:

1. Should public OACP governance start now, or only after Grantex and AgenticOrg have a stable internal reference implementation?
2. What merchant categories require lower first-release caps than the default risk-tier table?
3. Which merchant-owned connector platforms or external integration providers should be supported first?
4. What legal/regulatory review is required before Plural P3P moves from sandbox/approved non-production to any live buyer-agent mandate flow?
5. Which public documentation surfaces should expose OACP before external governance is decided?
