# PRD: Grantex Commerce

## 1. Product Summary

**Product name:** Grantex Commerce  
**Product type:** New product line under Grantex, integrated with AgenticOrg  
**Primary positioning:** Trusted agentic commerce infrastructure for merchants  
**Primary users:** Merchants, payment partners, commerce platforms, AI agent platforms, enterprise operations teams  
**Primary partner rail:** Pine Labs / Plural for payments, checkout, affordability, POS, settlement, and merchant reach

Grantex Commerce lets merchants safely accept AI-agent-led commerce across online and offline channels. It combines Grantex's delegated authorization and audit layer, AgenticOrg's merchant AI employees, Pine Labs/Plural payment rails, and UCP/ACP/MCP interoperability.

The product must not be a small demo or MVP. It should become a working production-grade product line with a clear separation of responsibilities:

- **Grantex.dev:** Trust, consent, agent identity, scoped authorization, payment passports, policy enforcement, audit, merchant commerce gateway, UCP/ACP/MCP authorization wrapper.
- **AgenticOrg.ai:** Merchant AI agents and workflows: sales, support, catalog, offer, reconciliation, store operations, and human-in-loop merchant workbench.
- **Pine Labs / Plural integrations:** Payment execution, checkout links, payment orders, subscriptions, refunds, rewards, affordability, online gateway, offline POS bridge where available.

The core thesis:

> Plural lets merchants accept online payments. Pine POS lets merchants accept offline payments. Grantex Commerce lets merchants safely accept AI agents.

## 1.1 Implementation Contract For Claude Code

This PRD is the source of truth for building a finished product. Claude Code should not reduce this to a demo, landing page, thin MCP wrapper, or checkout-only integration.

Build must satisfy these rules:

1. **Grantex Commerce is the merchant control plane.** Merchant registration, catalog, inventory, pricing, offers, payments, AI-native publishing, UCP/ACP/MCP settings, policies, analytics, and audit live in Grantex.
2. **AgenticOrg is the merchant AI workforce.** AgenticOrg consumes Grantex Commerce data and Grantex grants; it does not become the source of truth for merchant catalog, inventory, pricing, policies, or payment settings.
3. **Pine/Plural executes payments.** Do not create a competing payment processor. Wrap Plural/Pine APIs behind Grantex authorization, policy, audit, and merchant controls.
4. **UCP/ACP/MCP are interoperability adapters.** They are required, but the product is not only an adapter. The core product is trusted agentic commerce execution.
5. **Every agent action must be attributable.** Store who acted, on whose behalf, under which grant, against which merchant, under which policy version, and with which provider result.
6. **Every payment-affecting action must be consented or policy-approved.** No agent-created checkout, payment, refund, loyalty redemption, subscription, or store reservation may bypass Grantex Commerce Passport and merchant policy evaluation.
7. **Every external integration must have sandbox, live, and mocked modes.** If Pine/Plural live access is unavailable, build a provider interface and mocked/sandbox adapter so the product can be developed and tested end-to-end.
8. **Every UI flow must have an equivalent API.** The product must support dashboard users and developer/platform integrations.
9. **Every module must have tests.** Include unit tests, integration tests, policy tests, agent safety evals, webhook tests, and end-to-end sandbox tests.
10. **Do not leave ambiguous TODOs in production paths.** Unknown partner details should be isolated behind typed interfaces, feature flags, and explicit configuration.

## 1.2 Definition Of Finished Product

The finished product is considered complete when all of the following are true:

1. A merchant can register, verify, connect catalog, connect inventory, configure pricing/offers, connect Plural sandbox/live credentials, publish AI-native endpoints, and enter live mode.
2. An external AI agent can discover the merchant profile, search catalog, check inventory, create cart, request user consent, create checkout/payment intent, and receive payment status.
3. A user can approve, inspect, and revoke a commerce grant.
4. A merchant can define policies controlling agent access, amount limits, product/category limits, payment methods, refund permissions, loyalty redemption, and human approval.
5. A Plural payment flow works end-to-end in sandbox with webhook-driven status updates and audit trail.
6. AgenticOrg commerce agents can use Grantex Commerce safely for sales, support, reconciliation, catalog enrichment, offers, and store operations.
7. UCP-style profile, ACP-compatible checkout metadata, and MCP tools are published and protected by Grantex authorization.
8. Audit logs, analytics, compliance exports, and operational dashboards are available.
9. Security, privacy, observability, rate limiting, idempotency, and error handling are production-grade.
10. Release sign-off checklist in Section 19 passes without critical gaps.

## 1.3 Product Ownership Matrix

| Capability | Grantex.dev | AgenticOrg.ai | Pine/Plural | Notes |
| --- | --- | --- | --- | --- |
| Merchant registration | Owner | Consumer | Optional partner referral | Source of truth in Grantex Commerce |
| Merchant verification | Owner | None | Optional partner data | Store verification status and evidence |
| Catalog ingestion | Owner | Uses | None unless provided by merchant | AgenticOrg may enrich but not own canonical catalog |
| Inventory ingestion | Owner | Uses | Pine POS source where available | Store freshness/confidence per SKU/location |
| Pricing/offers data | Owner | Uses/recommends | Provides offer/EMI/reward eligibility where available | Merchant policy decides final exposure |
| Payment execution | Wraps/enforces | Uses tools | Owner | Grantex never stores raw card/payment credentials |
| Consent/passports | Owner | Requests/uses | Verifies where integrated | Grantex moat |
| Merchant policies | Owner | Must obey | Optional risk input | Policy decision logged for every protected action |
| Commerce agents | Provides permissions/data | Owner | None | AgenticOrg agents must use scoped Grantex grants |
| UCP/ACP/MCP endpoints | Owner | May consume | Optional | Grantex publishes and gates endpoints |
| Audit ledger | Owner | Writes events | Provider event source | Unified audit timeline in Grantex |
| Analytics | Owner | Agent run metrics contributor | Payment metrics contributor | Merchant dashboard in Grantex |

## 1.4 How To Use This PRD

This document is the **target-state master PRD** for Grantex Commerce. It describes the full product platform that should exist over multiple releases.

It must not be treated as a single implementation sprint or a one-shot Claude Code task.

Implementation rule:

- Use this PRD as the architectural north star.
- Use a separate V1 build spec for the first shippable implementation slice.
- Do not attempt every module in this document at once.
- Do not implement broad commerce-platform features before the Commerce Passport, policy, audit, and payment authorization core works.

The first implementation must prove:

> An AI agent can initiate a commerce action through a payment provider only when Grantex can prove user consent, scope, policy approval, revocation status, and audit evidence.

Anything that does not strengthen that proof is roadmap until the core is live.

## 1.5 Provider Neutrality And Pine/Plural Positioning

Plural/Pine is the first reference payment and merchant-rail partner. It must not be hardcoded as the only possible provider.

Product positioning must remain provider-neutral:

- Grantex Commerce is not "Pine Labs agentic commerce."
- Grantex Commerce is the authorization, policy, audit, and capability publishing layer for AI-agent commerce.
- Plural is the first payment adapter and partner implementation.
- Pine POS is the first offline/POS adapter and partner implementation.
- Razorpay, Cashfree, Stripe, Adyen, PhonePe, ONDC, bank rails, and future providers must be supportable through the same adapter model.

Implementation requirements:

- Provider-specific code must live behind typed adapter interfaces.
- Provider names may appear in configuration, adapter packages, docs, and partner demos.
- Core data models must use neutral fields such as `payment_provider`, `provider_account_id`, `provider_capability_status`, and `provider_reference_id`.
- Merchant-facing product copy should say "connect payment provider" first and "Plural" as the first supported provider.
- Partner-facing Pine/Plural demos may be co-branded, but core Grantex docs must remain provider-neutral.

Strategic reason:

If Grantex Commerce appears to be only Pine Labs infrastructure, non-Pine merchants and non-Pine AI platforms may not adopt it. The product should benefit from Pine/Plural access without being limited to Pine/Plural distribution.

## 2. Strategic Context

AI agents are becoming buying interfaces. Users will increasingly ask ChatGPT, Gemini, Copilot, Perplexity, WhatsApp agents, voice agents, and vertical AI assistants to discover, compare, select, reserve, pay, track, return, and reorder products.

Merchants need to become AI-native, but the need is broader than exposing UCP or ACP endpoints. Merchants need a trusted operating layer for agentic commerce:

- Which agent is acting?
- Which human authorized it?
- What is the spending limit?
- What products/categories can it access?
- Can it create carts, payments, refunds, subscriptions, or reservations?
- Can merchant policies override agent actions?
- Can authorization be revoked?
- Can every action be audited?
- Can the merchant attribute revenue to agent channels?

UCP, ACP, MCP, and payment APIs are important interoperability adapters. They are not the moat. The moat is trusted authorization, policy control, auditability, merchant operations, and payment execution.

## 2.1 Merchant Category Strategy

Grantex Commerce must be built as a category-agnostic infrastructure platform but launched with category-specific presets. Claude Code must not hardcode the product to one vertical, and must not build a vague generic onboarding flow that ignores category differences.

Core principle:

> Build generic commerce primitives. Package them as merchant category presets.

Supported platform categories:

- `electronics_appliances`
- `fashion_lifestyle`
- `beauty_personal_care`
- `pharmacy_wellness`
- `grocery_convenience`
- `restaurant_qsr`
- `services_bookings`
- `subscriptions_digital`
- `home_furniture`
- `b2b_wholesale`
- `generic_retail`

Initial launch categories:

1. **Electronics and appliances**
   - Highest priority launch category.
   - Best fit for Pine/Plural because EMI, offers, warranties, store pickup, inventory, and assisted selling matter.
2. **Fashion, footwear, beauty, and lifestyle**
   - High priority launch category.
   - Strong fit for variants, returns/exchanges, loyalty, agent-assisted discovery, and support.
3. **Pharmacy, wellness, and health retail**
   - Controlled pilot category.
   - Requires stricter policy defaults, compliance copy, restricted claims, and human approval for sensitive actions.

Later categories:

- Grocery and convenience.
- Restaurant/QSR.
- Services and appointment bookings.
- Home and furniture.
- B2B wholesale.
- Subscription/digital products.

Category preset requirements:

Each category preset must define:

- Required catalog fields.
- Optional but recommended catalog fields.
- Inventory rules.
- Pricing rules.
- Offer/EMI/reward behavior.
- Cart behavior.
- Checkout behavior.
- Booking/reservation behavior.
- Return/refund rules.
- Complaint/support workflows.
- Warranty/service workflows.
- Loyalty/gift-card behavior.
- Default AI-native capabilities.
- Default protocol exposure.
- Default merchant policies.
- Required AgenticOrg agent templates.
- Required eval cases.
- Restricted actions.
- Required human approval thresholds.

Category preset behavior:

- Merchant onboarding must ask for category.
- Merchant can select multiple categories if needed.
- Category presets pre-fill required fields, policies, and capability publishing defaults.
- Merchant can customize preset defaults, but high-risk overrides require admin/owner permission.
- Category preset must be stored on merchant profile and versioned.
- Readiness scoring must use category-specific requirements.
- AgenticOrg agent behavior must load category-specific instructions and evals.

Category preset examples:

| Category | Required Data | Default Capabilities | Default Guardrails |
| --- | --- | --- | --- |
| Electronics/appliances | SKU, brand, model, specs, warranty, price, inventory, EMI eligibility | catalog, inventory, pricing, offers, cart, checkout, payment, pickup, warranty, support | user consent for checkout, merchant approval for refund execution, exact inventory hidden unless trusted agent |
| Fashion/lifestyle | SKU, brand, size, color, images, variants, return policy, inventory, price | catalog, variants, inventory, pricing, offers, cart, checkout, returns/exchanges, loyalty | size/fit disclaimers, return eligibility required, no availability promise if stale inventory |
| Beauty/personal care | ingredients, skin/hair type tags, usage guidance, images, price, inventory | catalog, recommendations, bundles, cart, checkout, loyalty, subscriptions | no medical claims, disclose ingredient data source |
| Pharmacy/wellness | product type, prescription flag, regulatory category, inventory, price | catalog, availability, support, controlled checkout, refill reminders where legal | human approval for restricted items, no diagnosis, no prescription bypass |
| Grocery/convenience | SKU, pack size, perishability, substitutions, delivery/pickup slots, inventory | catalog, inventory, substitutions, cart, delivery, payment | substitution approval, freshness windows, stale inventory blocks checkout |
| Restaurant/QSR | menu items, modifiers, availability, prep time, delivery/pickup, taxes | menu, cart, booking/order, payment, complaint | allergen disclosure, prep-time estimates, cancellation policy |
| Services/bookings | service catalog, staff/resource availability, time slots, cancellation policy, price | service discovery, booking, payment, cancellation, support | booking confirmation required, cancellation rules visible |
| Subscriptions/digital | plan, billing cycle, entitlement, renewal/cancellation terms | plan discovery, subscription create/manage, payment, support | explicit recurring consent, cancellation terms required |
| Home/furniture | dimensions, material, delivery constraints, assembly, warranty, returns | catalog, inventory, delivery, checkout, booking, warranty/support | delivery feasibility check, return restrictions visible |
| B2B wholesale | MOQ, tier pricing, tax terms, credit terms, account permissions | catalog, pricing, quote/cart, checkout/request, support | account-level authorization, quote approval, payment terms control |

Acceptance criteria:

- Category preset is selected during onboarding.
- Readiness score changes based on category.
- Capability defaults change based on category.
- Policy defaults change based on category.
- Agent eval suite changes based on category.
- Merchant can preview category-specific protocol exposure before publishing.

## 3. Goals

### 3.1 Business Goals

1. Establish Grantex as the trust and consent layer for AI-led commerce.
2. Establish AgenticOrg as the merchant AI employee layer for agentic commerce operations.
3. Enable Pine/Plural merchants to accept AI-agent-initiated transactions safely.
4. Create a product category: **Agentic Commerce Acceptance Governance**.
5. Generate enterprise and partner revenue through SaaS, usage fees, transaction-linked pricing, and implementation services.
6. Create a wedge for deeper Pine Labs partnership around agentic payments, online checkout, POS, offers, affordability, loyalty, reconciliation, and merchant operations.

### 3.2 Product Goals

1. Allow a merchant to onboard, connect catalog/payment systems, and configure agent permissions.
2. Allow a user to authorize an AI agent to perform commerce actions with scoped, revocable, auditable grants.
3. Allow an AI agent to create Plural payment orders/links only when a valid Grantex commerce grant exists.
4. Allow merchants to expose AI-native commerce endpoints using UCP/ACP/MCP-compatible interfaces.
5. Allow AgenticOrg merchant agents to sell, support, reconcile, and operate commerce workflows using Grantex-enforced permissions.
6. Provide a merchant console for policies, agent channels, transaction logs, audits, failed actions, and revenue attribution.
7. Provide production-grade observability, compliance exports, security controls, and developer documentation.

### 3.3 Non-Goals

1. Do not build a new payment gateway.
2. Do not duplicate Plural checkout, Pine POS, or Pine settlement logic.
3. Do not build a generic consumer shopping app as the primary product.
4. Do not depend on scraping as the core commerce integration pattern.
5. Do not position the product only as a UCP/ACP adapter.
6. Do not create a third disconnected brand that dilutes Grantex and AgenticOrg.

## 4. Target Users And Personas

### 4.1 Merchant Owner / Commerce Head

Needs:

- More sales from AI channels.
- Control over pricing, offers, fulfillment, and customer experience.
- Low-risk way to try AI commerce.
- Clear revenue attribution.

Key product surfaces:

- Merchant onboarding.
- Merchant policy console.
- Agent revenue dashboard.
- Payment/checkout configuration.

### 4.2 Merchant Operations Team

Needs:

- Handle AI-generated orders, failed payments, refunds, returns, store pickup, and support.
- See why transactions failed.
- Reconcile payment and order data.

Key product surfaces:

- Operations dashboard.
- Reconciliation agent.
- Support agent.
- Audit timeline.

### 4.3 Developer / Integration Team

Needs:

- APIs, SDKs, webhooks, MCP tools, test environment, UCP/ACP documentation.
- Ability to plug into existing catalog, checkout, CRM, support, order management, and ERP systems.

Key product surfaces:

- Developer docs.
- API keys.
- Webhooks.
- Sandbox.
- Integration logs.

### 4.4 Consumer / End User

Needs:

- Understand what the AI agent is allowed to do.
- Approve payment/action safely.
- Revoke authorization.
- Get support if something goes wrong.

Key product surfaces:

- Grantex consent screen.
- Payment passport summary.
- Authorization history.
- Revocation page.

### 4.5 AI Agent Platform / External Agent

Needs:

- Discover merchant capabilities.
- Request permission.
- Call commerce APIs with scoped tokens.
- Receive structured errors and policy decisions.

Key product surfaces:

- UCP/ACP/MCP-compatible endpoints.
- Agent trust registry.
- Grant verification APIs.
- Commerce action APIs.

### 4.6 Pine / Plural Product And Partnership Teams

Needs:

- Demonstrate AI commerce leadership.
- Increase payment volume.
- Increase merchant stickiness.
- Add trust, consent, and audit to agentic payments.
- Avoid risky unrestricted agent payments.

Key product surfaces:

- Partner dashboard.
- Plural adapter.
- Pine POS bridge.
- Agentic payment audit ledger.
- Co-branded demos.

## 5. Product Architecture

### 5.1 System Layers

1. **Grantex Core**
   - Agent identity.
   - Human authorization.
   - Scoped grant tokens.
   - Delegation chains.
   - Revocation.
   - Audit log.
   - Policy engine.
   - Trust registry.

2. **Grantex Commerce**
   - Commerce grant templates.
   - Agent payment passport.
   - Merchant policy console.
   - Commerce action enforcement.
   - UCP/ACP/MCP adapters.
   - Plural checkout adapter.
   - Pine POS bridge.
   - Commerce audit ledger.
   - Commerce analytics.

3. **AgenticOrg Commerce**
   - Merchant Sales Agent.
   - Offer Agent.
   - Catalog Agent.
   - Support Agent.
   - Reconciliation Agent.
   - Store Operations Agent.
   - Human-in-loop workflows.

4. **Pine / Plural Rails**
   - Hosted checkout.
   - Payment links.
   - Orders and payments.
   - Webhooks.
   - Refunds.
   - Subscriptions.
   - Affordability/EMI.
   - Rewards.
   - POS payment/reservation where available.

5. **External Agent Surfaces**
   - ChatGPT.
   - Gemini / Google AI Mode / UCP-compatible agents.
   - Copilot.
   - WhatsApp agents.
   - Merchant website/app agents.
   - MCP clients.
   - A2A-capable agents.

### 5.2 Recommended Deployment Model

Use a multi-tenant SaaS architecture with optional enterprise self-hosting for regulated merchants.

Required environments:

- Local development.
- Sandbox.
- Staging.
- Production.
- Partner demo environment.

Required tenant types:

- Grantex internal tenant.
- Pine/Plural partner tenant.
- Merchant tenant.
- Agent platform tenant.
- Sandbox demo tenant.

### 5.2.1 Enterprise Deployment Requirements

Production deployment must support:

- Multi-tenant SaaS.
- Partner tenant mode for Pine/Plural.
- Enterprise tenant isolation.
- Optional dedicated deployment for regulated merchants.
- Separate sandbox and live environments.
- Separate secrets per merchant/provider/environment.
- Regional configuration for data residency where required.
- Blue/green or rolling deployments.
- Backward-compatible database migrations.
- Rollback plan for every release.

Enterprise readiness requirements:

- SSO/SAML/OIDC for merchant teams.
- SCIM user provisioning where available.
- RBAC and least-privilege defaults.
- Audit export API.
- Admin audit trail.
- Data retention configuration.
- Custom domain support for merchant-facing consent where required.
- SLA reporting.
- Support escalation workflow.
- Incident communication workflow.
- Disaster recovery runbook.

### 5.2.2 Reliability, SLA, And DR Targets

Targets for GA:

- API availability: 99.9% for GA, path to 99.95% for enterprise.
- Protected action fail mode: fail closed if authorization, policy, or audit write is unavailable.
- Payment provider outage behavior: block payment creation, preserve cart/session, show fallback handoff.
- RPO: 15 minutes for production transactional data.
- RTO: 4 hours for GA, path to 1 hour for enterprise.
- Audit event durability: no acknowledged protected action without audit event persistence.
- Webhook processing: idempotent, replayable, and recoverable.
- Background sync jobs: resumable after failure.
- Consent/passport verification: degraded offline verification allowed only when revocation freshness policy permits.

Operational requirements:

- Status page or internal service health page.
- Incident severity levels.
- On-call runbook.
- Provider outage playbooks.
- Data restore drill before GA.
- Load test before GA.

### 5.3 Service Boundary Requirements

Implement the product as explicit modules even if the first version is a monolith. Code should preserve these boundaries:

1. **Merchant Service**
   - Owns merchant profile, verification, stores, channels, integrations, and live/sandbox status.
2. **Catalog Service**
   - Owns product, SKU, variant, attribute, media, product Q&A, catalog readiness, and feed sync.
3. **Inventory Service**
   - Owns store-level inventory, reservations, stock freshness, stock confidence, and inventory sync jobs.
4. **Pricing And Offer Service**
   - Owns base price, sale price, member price, agent-only offer rules, coupons, bundles, EMI/reward eligibility metadata, and price freshness.
5. **Commerce Passport Service**
   - Owns commerce consent, grant issuance, grant verification, revocation, passport claims, and delegation constraints.
6. **Policy Service**
   - Owns merchant policies, policy versions, policy simulation, and policy decisions.
7. **Payment Adapter Service**
   - Owns provider interfaces for Plural/Pine/mocked providers, payment intents, checkout links, payment status, refunds, subscriptions, and webhooks.
8. **AI-Native Gateway Service**
   - Owns UCP-style profile, ACP-compatible metadata, MCP tools, well-known endpoints, and external agent access.
9. **Audit Service**
   - Owns append-only commerce events, event hashing, exports, timeline views, and compliance reports.
10. **Analytics Service**
   - Owns derived metrics, dashboards, funnels, attribution, and partner reports.
11. **AgenticOrg Connector**
   - Owns secure data/tool access from AgenticOrg agents into Grantex Commerce.

### 5.4 Integration Modes

Every external integration must support these modes:

- `mock`: deterministic local behavior for development and CI.
- `sandbox`: partner sandbox/test API behavior.
- `live`: production behavior with real credentials and webhooks.

Each provider adapter must expose:

- `healthCheck()`
- `validateCredentials()`
- `createPaymentIntent()`
- `createCheckoutLink()`
- `getPaymentStatus()`
- `createRefundRequest()`
- `getRefundStatus()`
- `createSubscription()` where supported.
- `handleWebhook()`
- `normalizeError()`

If a provider capability is unavailable, return a typed `capability_unavailable` error and show the missing capability in the dashboard.

### 5.5 Tenant And Environment Isolation

Requirements:

- Tenant data must never leak across merchants.
- Sandbox and live credentials must be stored separately.
- Sandbox passports must not authorize live payments.
- Live passports must include environment claim `env=live`.
- Webhook endpoints must distinguish provider, environment, and merchant.
- Test/demo merchants must be visually marked in dashboard and API responses.
- Admin impersonation must be audited.

### 5.6 Feature Flags

Required feature flags:

- `commerce_enabled`
- `commerce_live_mode_enabled`
- `plural_sandbox_enabled`
- `plural_live_enabled`
- `pine_pos_bridge_enabled`
- `ucp_profile_enabled`
- `acp_metadata_enabled`
- `mcp_tools_enabled`
- `agenticorg_commerce_agents_enabled`
- `merchant_policy_enforcement_enabled`
- `human_approval_required`
- `audit_export_enabled`

Feature flags must be tenant-scoped and environment-aware.

## 6. Core Product Modules

### 6.1 Merchant Commerce Gateway

### Purpose

Allow merchants to connect their commerce systems and expose controlled AI-native commerce capabilities.

### Required Features

1. Merchant onboarding wizard.
2. Merchant profile and verification.
3. Store/location management.
4. Online/offline channel configuration.
5. Catalog connector.
6. Payment connector.
7. Fulfillment and return policy configuration.
8. Agent access settings.
9. UCP/ACP/MCP exposure settings.
10. Test/sandbox mode.

### Merchant Profile Fields

- Merchant ID.
- Legal name.
- Display name.
- Website.
- Support email.
- Support phone.
- Business category.
- Merchant category preset.
- Secondary category presets.
- Category preset version.
- MCC/category.
- GSTIN or local tax identifier where relevant.
- Country.
- Currency.
- Store locations.
- Fulfillment methods.
- Return policy.
- Refund policy.
- Warranty/service policy.
- Payment provider configuration.
- Agent access status.

### Acceptance Criteria

- Merchant can complete onboarding without engineering help for basic payment-link based commerce.
- Merchant can connect Plural credentials or use sandbox Plural credentials.
- Merchant can publish a machine-readable agent commerce profile.
- Merchant can disable all agent access instantly.

### Merchant Lifecycle States

Every merchant must have an explicit lifecycle state:

- `draft`: merchant account created but profile incomplete.
- `profile_complete`: required business fields completed.
- `verification_pending`: verification submitted.
- `verified`: merchant identity verified or accepted for sandbox.
- `catalog_connected`: at least one catalog source connected or uploaded.
- `inventory_connected`: inventory source connected or manual inventory configured.
- `pricing_connected`: pricing source connected or manual pricing configured.
- `payments_sandbox_ready`: payment provider sandbox configured.
- `ai_native_sandbox_ready`: well-known/MCP/UCP-style profile available in sandbox.
- `sandbox_validated`: required sandbox tests passed.
- `live_requested`: merchant requested live activation.
- `live`: merchant can accept live agentic commerce actions.
- `suspended`: admin or risk suspension.
- `disabled`: merchant disabled agentic commerce.

State transitions must be explicit, audited, and visible in the merchant dashboard.

### Merchant Onboarding Validation Gates

Required gates before sandbox:

- Business profile complete.
- Merchant category preset selected.
- At least one catalog item exists.
- At least one price exists for each published SKU.
- Inventory mode selected: real-time, scheduled, manual, or not applicable.
- Payment provider mode selected: Plural sandbox, mocked provider, or payment link fallback.
- Default merchant policy created.
- Category preset defaults applied.
- Agent access mode selected.

Required gates before live:

- Merchant verified.
- Live payment credentials validated.
- Webhook endpoint verified.
- Catalog sync successful within last 24 hours.
- Inventory sync successful within merchant-configured freshness threshold, unless inventory is not applicable.
- Pricing sync successful within last 24 hours.
- Emergency disable tested.
- At least one successful sandbox payment.
- At least one successful Commerce Passport issuance and revocation test.
- Category-specific readiness score meets launch threshold.

### Catalog, Inventory, And Pricing Data Ownership

Grantex Commerce must be the canonical AI-native view of merchant commerce data. It does not need to replace the merchant's source system, but it must maintain normalized read models for agents:

- Source systems remain systems of record for operational commerce.
- Grantex stores normalized, indexed, agent-readable snapshots.
- Every record stores `source_system`, `source_record_id`, `sync_job_id`, `last_synced_at`, and `sync_status`.
- Conflicts are resolved by source priority configured by merchant.
- Stale data must be marked and optionally hidden from agents.
- AgenticOrg agents must read through Grantex APIs, not directly from merchant source connectors unless explicitly configured.

### Data Freshness Rules

Default freshness requirements:

- Catalog: fresh if synced within 24 hours.
- Pricing: fresh if synced within 24 hours.
- Inventory: fresh if synced within 15 minutes for store-level inventory, 4 hours for non-real-time catalog inventory, or merchant-configured threshold.
- Offers: fresh if synced within offer provider's expiry or 24 hours, whichever is shorter.

Behavior:

- If catalog is stale, show warning but allow read-only discovery if merchant permits.
- If pricing is stale, block checkout unless merchant policy allows stale-price fallback.
- If inventory is stale, label as `availability_unknown` and block reservation unless merchant policy allows manual confirmation.
- If payment provider health is down, block payment intent creation and allow only lead/support handoff.

### Required Merchant Dashboard Cards

Commerce Home must show:

- Merchant lifecycle state.
- Merchant category preset.
- AI-native readiness score.
- Category-specific readiness score.
- Catalog health.
- Inventory health.
- Pricing health.
- Payment provider health.
- Agent access status.
- Policy enforcement status.
- Last agent transaction.
- Open human approvals.
- Recent failed actions.
- Emergency disable button.

### Required Merchant Actions

Merchants must be able to:

- Register a merchant.
- Invite team members.
- Configure RBAC.
- Select and update merchant category presets.
- Preview category preset defaults.
- Connect/disconnect catalog sources.
- Upload CSV.
- Map product fields.
- Review import errors.
- Connect/disconnect inventory sources.
- Configure inventory freshness.
- Connect/disconnect pricing sources.
- Configure offer rules.
- Connect Plural/Pine credentials.
- Validate webhooks.
- Configure AI agent access.
- Publish/unpublish AI-native endpoints.
- Simulate an agent query.
- Simulate checkout.
- Export audit logs.
- Disable all agentic commerce.

### 6.2 Grantex Commerce Passport

### Purpose

Provide signed, verifiable, revocable authorization credentials for AI-commerce actions.

### Definition

A **Commerce Passport** is a signed credential binding:

- Human principal.
- Agent identity.
- Merchant.
- Allowed commerce actions.
- Payment constraints.
- Product/category constraints.
- Spending limits.
- Expiry.
- Delegation rules.
- Revocation status.
- Audit reference.

### Required Grant Scopes

Initial scope taxonomy:

- `commerce:catalog.read`
- `commerce:inventory.read`
- `commerce:cart.create`
- `commerce:cart.update`
- `commerce:checkout.create`
- `commerce:payment.initiate`
- `commerce:payment.capture`
- `commerce:payment.status.read`
- `commerce:payment.refund.request`
- `commerce:order.read`
- `commerce:order.create`
- `commerce:order.cancel.request`
- `commerce:return.create`
- `commerce:subscription.create`
- `commerce:subscription.manage`
- `commerce:offer.read`
- `commerce:offer.apply`
- `commerce:loyalty.read`
- `commerce:loyalty.redeem`
- `commerce:store.reserve`
- `commerce:support.create`
- `commerce:audit.read`

### Required Passport Claims

- `iss`: Grantex issuer.
- `sub`: Human principal DID/user ID.
- `aud`: Merchant or commerce gateway.
- `agent_id`: Registered agent ID.
- `agent_did`: Agent DID where available.
- `merchant_id`.
- `merchant_did` where available.
- `scopes`.
- `max_amount`.
- `currency`.
- `category_allowlist`.
- `merchant_allowlist`.
- `payment_method_constraints`.
- `fulfillment_constraints`.
- `expires_at`.
- `jti`.
- `grant_id`.
- `delegation_depth`.
- `policy_version`.
- `consent_record_id`.
- `audit_session_id`.

### User Consent UX

Consent screen must show in plain language:

- Which agent is requesting access.
- Which merchant it wants to transact with.
- What it can do.
- Maximum amount.
- Validity period.
- Payment method constraints.
- Whether payment requires final user confirmation.
- Revocation option.

Example:

> Allow "AgenticOrg Sales Agent" to create a checkout with "ABC Electronics" up to INR 35,000, apply eligible offers/EMI, and initiate payment. Valid for 15 minutes. Final payment confirmation required.

### Acceptance Criteria

- Passport can be verified offline using Grantex JWKS.
- Passport can be checked online for revocation.
- Passport enforces amount, merchant, category, scope, and expiry.
- Passport logs all usage events.
- Passport can be revoked by user, merchant, or Grantex admin.

### Passport Types

Support these passport types:

- `browse`: agent can browse/search public or user-approved catalog data.
- `cart`: agent can create and modify carts but cannot initiate payment.
- `checkout`: agent can create checkout/payment intent but final user confirmation is still required.
- `payment_delegated`: agent can initiate payment within explicit amount, merchant, category, and time constraints.
- `support`: agent can read order/payment status and create support/return/refund requests.
- `merchant_operator`: merchant-side agent can operate on merchant workflows, subject to merchant RBAC and policy.

Each passport type maps to a default scope bundle, but merchants and users can reduce scopes before approval.

### Consent Evidence Requirements

Every consent record must store:

- Human-readable consent text shown to the user.
- Machine-readable scopes and constraints.
- Agent identity and verification status.
- Merchant identity and verification status.
- Requested amount/currency if payment-related.
- Consent timestamp.
- IP address and user agent where available.
- Authentication method used.
- Passkey/WebAuthn evidence where available.
- Revocation instructions shown to user.
- Hash of consent payload.

Consent text must be reproducible from stored data for dispute handling.

### Revocation Semantics

Revocation must support:

- Revoke one passport.
- Revoke all passports for one agent.
- Revoke all passports for one merchant.
- Revoke all commerce passports for one user.
- Merchant blocklist of an agent.
- Admin suspension of an agent or merchant.

Revocation must block:

- New API calls using the passport.
- New payment intents.
- New checkout links.
- New refund/return actions.
- New loyalty redemptions.

Revocation does not automatically cancel already-paid provider transactions; those must follow provider refund/cancellation flows and merchant policy.

### Amount And Currency Rules

- All amount limits must use integer minor units internally.
- Currency must be ISO 4217.
- Passport currency must match payment intent currency unless merchant policy explicitly allows conversion.
- Payment amount must be less than or equal to `max_amount`.
- If line items change after consent, re-evaluate total amount, merchant, category, and scope.
- If total increases above consented amount, require new consent.
- If total decreases, do not require new consent unless merchant policy requires reapproval.

### 6.3 Plural Agentic Checkout Adapter

### Purpose

Allow authorized agents to create and manage Plural checkout/payment flows safely.

### Required Features

1. Create Plural order/payment link/hosted checkout using valid Commerce Passport.
2. Retrieve payment status.
3. Handle Plural webhooks.
4. Map Plural payment state to Grantex audit timeline.
5. Support sandbox and live credentials.
6. Support refunds where available.
7. Support subscriptions where available.
8. Support offer/EMI/reward eligibility discovery where APIs allow.
9. Support merchant-level fallback to payment link if full checkout API is not available.

### Required API Wrapper Endpoints

Use Grantex Commerce API names independent of Plural internals:

- `POST /v1/commerce/payments/intents`
- `GET /v1/commerce/payments/intents/{id}`
- `POST /v1/commerce/payments/intents/{id}/checkout-link`
- `POST /v1/commerce/payments/intents/{id}/cancel`
- `POST /v1/commerce/refunds`
- `GET /v1/commerce/refunds/{id}`
- `POST /v1/commerce/subscriptions`
- `GET /v1/commerce/subscriptions/{id}`
- `POST /v1/webhooks/plural`

### Payment Intent Object

Fields:

- `id`.
- `merchant_id`.
- `agent_id`.
- `human_principal_id`.
- `commerce_passport_jti`.
- `amount`.
- `currency`.
- `line_items`.
- `metadata`.
- `payment_provider`: `plural`.
- `provider_order_id`.
- `provider_payment_id`.
- `checkout_url`.
- `status`.
- `expires_at`.
- `created_at`.
- `updated_at`.

Statuses:

- `created`
- `authorization_required`
- `authorized`
- `checkout_created`
- `payment_pending`
- `paid`
- `failed`
- `cancelled`
- `expired`
- `refunded`
- `partially_refunded`

### Acceptance Criteria

- API rejects payment creation without a valid Commerce Passport.
- API rejects amount above passport limit.
- API rejects merchant mismatch.
- API rejects expired/revoked passport.
- Successful payment creates a complete audit timeline.
- Webhook verification is implemented.
- Sandbox demo works end-to-end.

### Payment Adapter Rules

The adapter must never expose raw provider complexity to agents. Agents call Grantex Commerce APIs; Grantex calls Plural/Pine adapters.

Rules:

- Require idempotency key for create/cancel/refund/subscription APIs.
- Store provider request and response hashes, not sensitive payment payloads.
- Normalize provider statuses into Grantex statuses.
- Retry transient provider failures with bounded exponential backoff.
- Do not retry non-idempotent provider actions without idempotency key.
- Mark unknown webhook events as `provider_event_unrecognized` and store for review.
- Verify webhook signatures before changing state.
- Reconcile payment status by polling provider if webhook is delayed or missing.
- Provide manual reconciliation action in dashboard.
- Support payment expiry and checkout link expiry.

### Provider Capability Matrix

Dashboard must display which capabilities are available for each merchant/provider/environment:

- Create payment order.
- Generate hosted checkout.
- Generate payment link.
- Payment status.
- Refund.
- Partial refund.
- Subscription.
- EMI/affordability.
- Reward points.
- Webhooks.
- Offline/POS payment.
- Store pickup/reservation.

If a merchant selects a feature not supported by their provider mode, show the exact missing capability and remediation.

### Payment State Machine

Valid state transitions:

- `created` -> `authorization_required`
- `authorization_required` -> `authorized`
- `authorized` -> `checkout_created`
- `checkout_created` -> `payment_pending`
- `payment_pending` -> `paid`
- `payment_pending` -> `failed`
- `created|authorized|checkout_created|payment_pending` -> `cancelled`
- `created|authorized|checkout_created|payment_pending` -> `expired`
- `paid` -> `partially_refunded`
- `paid|partially_refunded` -> `refunded`

Invalid transitions must be rejected and logged.

### 6.4 Pine POS Agent Bridge

### Purpose

Extend agentic commerce from online payments to offline retail stores using Pine Labs POS/payment capabilities.

### Required Features

1. Store-level merchant profile.
2. Store reservation request.
3. Pickup/payment code generation.
4. POS payment intent creation where supported.
5. Staff notification.
6. Payment status sync.
7. Reconciliation with merchant and payment records.

### Core Flows

#### Reserve And Pay In Store

1. Agent finds product/store.
2. User grants permission.
3. Agent creates reservation.
4. Merchant/store receives reservation.
5. Customer visits store.
6. POS validates pickup code.
7. Customer pays at POS.
8. Grantex audit records completion.

#### Pay Online, Pick Up In Store

1. Agent creates Plural checkout.
2. Customer pays.
3. Store receives paid pickup order.
4. Customer presents pickup code.
5. Store fulfills.
6. Audit and reconciliation complete.

### Acceptance Criteria

- Offline flow can be run in sandbox mode if Pine POS live integration is not ready.
- Store reservation cannot exceed merchant policy rules.
- Pickup code must be short-lived and auditable.
- Store staff can mark reservation as fulfilled/cancelled/no-show.

### 6.5 AI-Native Merchant Profile And UCP/ACP/MCP Gateway

### Purpose

Make merchants discoverable and transactable by AI agents using emerging commerce protocols while preserving Grantex authorization and merchant control.

### Required Features

1. Generate AI-native merchant profile.
2. Publish UCP-style capability descriptor.
3. Provide MCP tools for merchant commerce actions.
4. Support ACP-compatible checkout metadata where applicable.
5. Protect action endpoints with Grantex Commerce Passport.
6. Provide capability negotiation.
7. Provide sandbox/testing endpoint.

### Universal AI-Agent Publishing Requirement

Merchants must be able to publish controlled, machine-readable commerce capabilities for all supported AI agents and protocols from one Grantex Commerce console.

Supported agent/protocol surfaces:

- Grantex Commerce native API.
- MCP tools.
- UCP-style merchant profile and capability descriptors.
- ACP-compatible checkout/session metadata where applicable.
- A2A-compatible agent handoff metadata where applicable.
- Website/app embedded merchant agents.
- AgenticOrg agents.
- Future external agent registries through adapter interface.

The merchant must not configure each protocol separately from scratch. Grantex Commerce must maintain one canonical merchant capability model and generate protocol-specific views from it.

Canonical capability categories:

- Merchant profile.
- Store/location profile.
- Catalog publishing.
- Product detail publishing.
- Inventory/availability publishing.
- Pricing publishing.
- Offer/discount/EMI/reward publishing.
- Cart creation and cart update.
- Checkout/session creation.
- Payment initiation.
- Payment status.
- Booking/reservation.
- Store pickup.
- Delivery/shipping options.
- Order creation/reference.
- Order status.
- Cancellation request.
- Refund request/execution where supported.
- Return/exchange request.
- Complaint/support ticket.
- Warranty/service request.
- Loyalty read/redeem.
- Gift card read/redeem.
- Subscription create/manage where supported.
- Human handoff.
- Merchant policy/terms discovery.
- Audit/receipt reference.

Protocol publishing behavior:

- If a protocol supports a capability natively, publish the native mapping.
- If a protocol does not support a capability, expose it through Grantex native API/MCP tool and mark it as protocol extension.
- If a provider does not support execution of a capability, expose capability as `unavailable` with reason and fallback.
- If merchant disables a capability, remove it from all protocol views or mark it disabled consistently.
- If a capability requires user consent, protocol metadata must show required scopes and auth flow.
- If a capability requires merchant approval, protocol metadata must show `requires_human_approval`.
- If a capability is sandbox-only, protocol metadata must show environment restrictions.

Merchant publishing controls:

- Global publish/unpublish switch.
- Per-protocol enable/disable.
- Per-capability enable/disable.
- Public vs verified-agent visibility.
- Read-only vs transactional mode.
- Sandbox vs live mode.
- Store/location-level publishing.
- Product/category-level publishing.
- Inventory visibility level: exact quantity, availability bucket, or hidden.
- Pricing visibility level: public price, authenticated price, member price, or hidden.
- Offer visibility level: public, eligible-after-user-grant, hidden.
- Agent allowlist/blocklist.
- Rate limits.
- Emergency disable.

The merchant must see exactly what each protocol/agent surface can access before publishing.

### Capability Publishing Matrix

| Capability | Grantex Native API | MCP | UCP-style | ACP-compatible | A2A/Agent Handoff | Required Default Authorization |
| --- | --- | --- | --- | --- | --- | --- |
| Merchant profile | Yes | Yes | Yes | Limited/metadata | Yes | Public or verified agent |
| Store/location profile | Yes | Yes | Yes | Limited/metadata | Yes | Public or verified agent |
| Catalog search | Yes | Yes | Yes | Limited/product metadata | Yes | Merchant-configured |
| Product details | Yes | Yes | Yes | Limited/product metadata | Yes | Merchant-configured |
| Inventory availability | Yes | Yes | Yes | Limited/extension | Yes | Verified agent or user grant by default |
| Exact inventory quantity | Yes | Yes | Extension | Extension | Yes | Merchant approval or trusted agent |
| Pricing | Yes | Yes | Yes | Yes where checkout metadata supports | Yes | Merchant-configured |
| Personalized/member pricing | Yes | Yes | Extension | Extension | Yes | User grant |
| Offers/EMI/rewards | Yes | Yes | Yes/extension | Yes/extension | Yes | User grant if personalized |
| Cart create/update | Yes | Yes | Yes | Extension/session | Yes | Verified agent plus policy |
| Checkout create | Yes | Yes | Yes | Yes | Yes | Commerce Passport |
| Payment initiate | Yes | Yes | Payment extension/AP2-compatible where applicable | Yes | Yes | Commerce Passport |
| Payment status | Yes | Yes | Extension | Yes/session status | Yes | User grant or merchant ops grant |
| Booking/reservation | Yes | Yes | Extension | Extension | Yes | User grant plus merchant policy |
| Store pickup | Yes | Yes | Yes/extension | Extension | Yes | User grant plus merchant policy |
| Shipping/delivery options | Yes | Yes | Yes | Yes/extension | Yes | Cart/checkout scope |
| Order status | Yes | Yes | Extension | Yes where supported | Yes | User grant |
| Cancellation request | Yes | Yes | Extension | Extension | Yes | User grant plus merchant policy |
| Refund request | Yes | Yes | Extension | Extension | Yes | User grant plus merchant policy |
| Refund execution | Yes | Yes | Extension | Extension | Yes | Merchant approval by default |
| Return/exchange request | Yes | Yes | Extension | Extension | Yes | User grant plus merchant policy |
| Complaint/support ticket | Yes | Yes | Extension | Extension | Yes | User grant or public lead mode |
| Warranty/service request | Yes | Yes | Extension | Extension | Yes | User grant |
| Loyalty read/redeem | Yes | Yes | Extension | Extension | Yes | Explicit user grant |
| Gift card read/redeem | Yes | Yes | Extension | Extension | Yes | Explicit user grant |
| Subscription create/manage | Yes | Yes | Extension | Yes where provider supports | Yes | Commerce Passport/user grant |
| Human handoff | Yes | Yes | Extension | Extension | Yes | Context-dependent |

### Capability Definitions

Each published capability must have:

- `capability_id`
- `display_name`
- `description`
- `protocol_mappings`
- `supported_environments`
- `required_scopes`
- `required_passport_type`
- `requires_user_consent`
- `requires_merchant_approval`
- `provider_dependency`
- `provider_capability_status`
- `rate_limit`
- `visibility`
- `input_schema`
- `output_schema`
- `error_codes`
- `audit_event_name`
- `last_validated_at`

Capability definitions must be visible to merchants and developers.

### Publishing Validation

Before publishing AI-native capabilities, Grantex must validate:

- Merchant profile exists.
- Merchant policy exists and is active.
- Required endpoints are reachable.
- Required schemas are valid.
- Required payment provider capabilities are available.
- Catalog has at least one publishable product for catalog publishing.
- Pricing exists for checkout-enabled products.
- Inventory mode is configured for inventory/reservation capabilities.
- Consent and passport flows are configured for protected capabilities.
- Webhook endpoint is configured for payment/refund/order updates.
- Sandbox test passes for every live transactional capability.

If validation fails, Grantex must block publishing for affected capabilities and show exact remediation.

### Protocol Adapter Interface

Implement protocols through adapters, not hardcoded one-off logic.

Adapter interface:

- `getProtocolName()`
- `getSupportedCapabilities()`
- `generateMerchantProfile(merchantCapabilityModel)`
- `generateToolManifest(merchantCapabilityModel)`
- `mapCapabilityToProtocol(capability)`
- `validateProtocolProfile(profile)`
- `handleProtocolRequest(request)`
- `normalizeProtocolError(error)`

Initial adapters:

- `grantex_native`
- `mcp`
- `ucp_style`
- `acp_compatible`
- `a2a_handoff`

Future adapters must be addable without changing canonical merchant capability definitions.

### Required Public Endpoints

At minimum:

- `GET /.well-known/grantex-commerce`
- `GET /.well-known/ucp`
- `GET /mcp`
- `POST /v1/commerce/catalog/search`
- `GET /v1/commerce/catalog/items/{id}`
- `POST /v1/commerce/cart`
- `POST /v1/commerce/cart/{id}/items`
- `POST /v1/commerce/checkout`
- `POST /v1/commerce/payments/intents`
- `GET /v1/commerce/orders/{id}`
- `POST /v1/commerce/returns`

### MCP Tools

Required MCP tools:

- `merchant.get_profile`
- `catalog.search`
- `catalog.get_item`
- `inventory.check`
- `offers.get_eligible`
- `cart.create`
- `cart.add_item`
- `checkout.create`
- `payment.create_intent`
- `payment.get_status`
- `order.get_status`
- `return.create_request`
- `support.create_ticket`

### Authorization Behavior

- Read-only catalog search may be public or merchant-configured.
- Inventory checks may be public, restricted, or rate-limited.
- Cart creation requires agent identity.
- Checkout/payment requires Commerce Passport.
- Order history, returns, loyalty, and support require user-bound grant.

### Acceptance Criteria

- External agent can discover merchant capabilities.
- MCP client can call read-only tools in sandbox mode.
- Write/payment tools require valid Grantex grant.
- Merchant can disable UCP/ACP/MCP exposure.

### AI-Native Profile Contract

`/.well-known/grantex-commerce` must return:

- Merchant identity.
- Verification status.
- Supported environments.
- Supported protocols.
- Supported commerce capabilities.
- Supported auth methods.
- Supported payment modes.
- Supported fulfillment modes.
- Required scopes per action.
- MCP server URL.
- UCP-style profile URL.
- Checkout/payment endpoint URL.
- Support endpoint URL.
- Public key/JWKS URL.
- Terms and policy URLs.
- Last updated timestamp.

The UCP-style profile must be generated from the same merchant capability model. Do not maintain separate duplicated config for Grantex and UCP profiles.

### MCP Tool Behavior

Each MCP tool must define:

- Tool name.
- Description.
- Input schema.
- Output schema.
- Required scope.
- Whether user grant is required.
- Whether merchant policy approval is required.
- Rate limit.
- Audit event name.
- Error model.

Tool responses must be structured and must not rely on natural language alone. Agent-facing text can be included in a `display_message` field, but machine-readable fields are mandatory.

### ACP Compatibility Requirements

Where ACP checkout metadata is implemented:

- Map Grantex merchant ID to ACP merchant reference.
- Map Grantex payment intent to ACP checkout/session reference.
- Require Commerce Passport before payment-affecting actions.
- Preserve merchant as seller of record.
- Record ACP session IDs in audit metadata.
- Return clear fallback when ACP is unsupported for a merchant.

### Agent Discovery And Rate Limits

Default limits:

- Anonymous merchant profile requests: rate-limited by IP and merchant.
- Anonymous catalog search: disabled by default unless merchant opts in.
- Verified agent catalog search: allowed subject to merchant policy.
- Inventory checks: rate-limited and optionally hidden for low-trust agents.
- Checkout/payment: always requires Commerce Passport.

Merchants must be able to configure public vs verified-agent access.

### 6.6 Merchant Policy Console

### Purpose

Give merchants control over how agents access, recommend, transact, support, and refund commerce actions.

### Required Policy Controls

1. Agent allowlist/blocklist.
2. Trusted agent registry integration.
3. Scope-level permissions.
4. Transaction value limits.
5. Product/category allowlists/blocklists.
6. Payment method restrictions.
7. Human confirmation requirements.
8. Refund/return approval thresholds.
9. Loyalty/reward redemption permissions.
10. Offer/discount guardrails.
11. Time-of-day rules.
12. Store/location rules.
13. Rate limits.
14. Fraud/anomaly alerts.
15. Emergency disable switch.

### Policy Examples

- Allow verified agents to search catalog without user grant.
- Require user grant for checkout creation.
- Require final human confirmation above INR 10,000.
- Allow payment links but not direct capture.
- Allow refunds only as requests, not automatic actions.
- Disable agentic checkout for high-risk categories.
- Allow store pickup reservation for 30 minutes only.

### Acceptance Criteria

- Policies are versioned.
- Every policy decision is logged.
- Merchants can simulate policy decisions before enabling live mode.
- Policy changes take effect within 60 seconds.
- Emergency disable switch blocks new write/payment actions immediately.

### Policy Evaluation Contract

Policy evaluation input:

- Merchant ID.
- Agent ID and trust status.
- Human principal ID where available.
- Requested action.
- Requested scopes.
- Product/category/SKU data.
- Amount and currency.
- Payment method.
- Fulfillment method.
- Store/location.
- Passport claims.
- Risk signals.
- Environment.

Policy evaluation output:

- `allow`, `deny`, or `requires_human_approval`.
- Decision ID.
- Policy version.
- Matched rule IDs.
- Human-readable explanation.
- Machine-readable reason code.
- Required remediation if denied.
- Audit event ID.

Policy decision must be evaluated before provider calls and after any cart/amount change.

### Required Default Policies

Create safe defaults:

- Public agents can read only basic merchant profile.
- Catalog search requires verified agent unless merchant opts into public discovery.
- Inventory exact quantity hidden by default; expose availability buckets instead.
- Cart creation requires verified agent identity.
- Checkout/payment requires user Commerce Passport.
- Refunds are requests only by default.
- Loyalty redemption requires explicit user grant.
- High-value actions require human confirmation.
- New or untrusted agents have lower rate limits.
- Emergency disable blocks all write/payment actions.

### 6.7 Commerce Audit Ledger

### Purpose

Provide complete evidence trail for AI-led commerce actions.

### Events To Capture

- Agent registration.
- Merchant capability discovery.
- Consent requested.
- Consent granted/denied/revoked.
- Passport issued.
- Passport verified.
- Policy evaluated.
- Catalog searched.
- Cart created/updated.
- Offer applied.
- Payment intent created.
- Checkout link generated.
- Payment authorized/failed/paid.
- Webhook received.
- Order created.
- Store reservation created.
- Refund/return requested.
- Support ticket created.
- Human override.
- Fraud/anomaly event.

### Event Fields

- `event_id`.
- `tenant_id`.
- `merchant_id`.
- `agent_id`.
- `human_principal_id`.
- `grant_id`.
- `commerce_passport_jti`.
- `action`.
- `resource_type`.
- `resource_id`.
- `policy_decision`.
- `request_hash`.
- `response_hash`.
- `provider`.
- `provider_event_id`.
- `ip_address`.
- `user_agent`.
- `created_at`.
- `metadata`.

### Acceptance Criteria

- Audit log is tamper-evident or hash-chained.
- Audit export is available in JSON and CSV.
- Audit search supports merchant, agent, user, transaction, event type, and date range.
- Sensitive fields are redacted or tokenized.

### Audit Timeline Views

Required timeline views:

- User consent timeline.
- Agent session timeline.
- Payment intent timeline.
- Order/support timeline.
- Merchant policy decision timeline.
- Provider webhook timeline.
- Refund/return timeline.

Each timeline must show:

- Event time.
- Actor.
- Action.
- Decision/result.
- Related resource.
- Linked grant/passport.
- Provider reference where applicable.
- Error/remediation if failed.

### Audit Retention

Default retention:

- Audit events: 7 years for live commerce tenants unless contract overrides.
- Sandbox audit events: 90 days unless merchant exports.
- Raw webhook payloads: 180 days with sensitive fields redacted.
- Consent evidence: same retention as live audit events.

Retention policy must be configurable for enterprise tenants.

### 6.8 AgenticOrg Commerce Agent Pack

### Purpose

Deliver merchant-facing AI employees that use Grantex Commerce safely and produce direct business value.

### Required Agents

#### 6.8.1 Sales Agent

Responsibilities:

- Product discovery.
- Product Q&A.
- Comparison.
- Cart creation.
- Checkout link creation.
- Handoff to human when needed.

Required integrations:

- Catalog.
- Inventory.
- Offers.
- Plural checkout adapter.
- Grantex consent.

#### 6.8.2 Offer Agent

Responsibilities:

- Identify eligible EMI, reward points, coupons, gift cards, loyalty offers, bank offers.
- Recommend merchant-safe offer.
- Enforce margin/policy limits.

Required integrations:

- Plural affordability where available.
- Merchant offer rules.
- Loyalty/gift card systems.

#### 6.8.3 Catalog Agent

Responsibilities:

- Enrich product data.
- Detect missing attributes.
- Generate AI-readable descriptions.
- Map variants.
- Generate product Q&A.
- Prepare UCP/ACP/MCP-ready catalog metadata.

Required integrations:

- Merchant catalog source.
- CMS/e-commerce platform.
- Grantex Commerce Gateway.

#### 6.8.4 Support Agent

Responsibilities:

- Order status.
- Payment status.
- Return eligibility.
- Refund request.
- Warranty/support ticket.

Required integrations:

- Order API.
- Payment status API.
- Support/CRM system.
- Grantex user grant.

#### 6.8.5 Reconciliation Agent

Responsibilities:

- Match orders, payments, refunds, settlements.
- Flag mismatches.
- Explain failed payments.
- Generate daily reconciliation report.

Required integrations:

- Plural payment events.
- Merchant order management.
- Settlement reports.

#### 6.8.6 Store Operations Agent

Responsibilities:

- Manage offline reservations.
- Notify store staff.
- Handle pickup/no-show/cancellation.
- Escalate stock mismatch.

Required integrations:

- Pine POS bridge.
- Store inventory.
- Staff notification channels.

### AgenticOrg Requirements

- Each agent must use Grantex scopes.
- Each agent action must produce audit events.
- Human-in-loop must be available for high-risk actions.
- Agents must support merchant-specific policies.
- Agents must expose test/sandbox mode.

### Agent Tooling Contract

AgenticOrg agents must use Grantex Commerce tools through a scoped tool manifest:

- No direct Plural/Pine provider calls from agents.
- No direct payment credential handling.
- No direct write to merchant catalog/pricing/inventory unless a merchant operator grant allows it.
- No checkout creation without Commerce Passport.
- No refund execution unless policy and provider capability allow it.
- No unsupported offer promises.
- No exact inventory promise unless inventory freshness is valid.

Each agent run must store:

- Agent template version.
- Merchant ID.
- User/session ID where available.
- Tools called.
- Grantex scopes used.
- Policy decisions.
- Human approvals.
- Final outcome.
- Evaluation result where applicable.

### Required Agent Guardrails

Agents must:

- Prefer structured tool results over model memory.
- Cite product/price/inventory source timestamp in internal reasoning metadata.
- Ask for consent before payment-affecting actions.
- Escalate when policy says `requires_human_approval`.
- Refuse unsupported payment/refund/loyalty operations.
- Avoid claiming guaranteed availability when inventory is stale.
- Avoid promising discounts not returned by offer tools.
- Avoid storing payment details in conversation memory.

## 7. Website And Product Surface Requirements

### 7.1 Work Required On Grantex.dev

#### 7.1.1 New Commerce Landing Page

Create:

- `/commerce`

Purpose:

- Explain Grantex Commerce as trusted authorization for AI-led commerce.

Required sections:

1. Hero:
   - Headline: "Let merchants safely accept AI agents."
   - Subcopy: "Grantex Commerce provides verifiable consent, scoped payment authority, merchant policies, audit logs, and Pine/Plural payment execution for agentic commerce."
2. Problem:
   - AI agents can act, but merchants need proof of authorization.
3. Solution:
   - Commerce Passport.
   - Merchant Policy Console.
   - Plural Agentic Checkout Adapter.
   - UCP/ACP/MCP gateway.
   - Audit ledger.
4. Product architecture diagram.
5. Pine/Plural integration section.
6. Developer quickstart.
7. Compliance and audit section.
8. CTA:
   - "Try sandbox"
   - "Request Pine/Plural pilot"
   - "Read docs"

#### 7.1.2 Developer Docs

Create docs section:

- `/docs/commerce`

Required docs:

- Introduction.
- Commerce Passport concepts.
- Grant scopes.
- Consent flow.
- Plural checkout adapter.
- MCP tools.
- UCP profile.
- Webhooks.
- Merchant policies.
- Audit events.
- Sandbox walkthrough.
- Error codes.
- Security model.

#### 7.1.3 Dashboard Additions

Add Commerce area to Grantex dashboard:

- Commerce tenants.
- Merchants.
- Merchant registration and onboarding.
- Merchant verification.
- Catalog data hub.
- Inventory data hub.
- Pricing and offers data hub.
- Store/location inventory.
- AI-native publishing status.
- Commerce passports.
- Payment intents.
- Policies.
- Audit ledger.
- Agent registry.
- Webhooks.
- Sandbox tester.

Required dashboard navigation:

- `Commerce Home`
- `Onboarding`
- `Merchants`
- `Catalog`
- `Inventory`
- `Pricing`
- `Offers`
- `Stores`
- `Payments`
- `AI-Native Publishing`
- `Capability Publishing Matrix`
- `Protocol Adapters`
- `Policies`
- `Agent Access`
- `Passports`
- `Orders And Payment Intents`
- `Reservations`
- `Human Approvals`
- `Audit Ledger`
- `Analytics`
- `Developer Settings`
- `Webhooks`
- `Settings`

Each page must implement loading, empty, error, read-only, and permission-denied states.

#### 7.1.4 Merchant Registration And AI-Native Data Hub

This is a required Grantex Commerce surface. Merchant registration, catalog ingestion, inventory sync, pricing, offers, payment configuration, and AI-native publishing must live in Grantex Commerce, not AgenticOrg.

Primary routes:

- `/dashboard/commerce/onboarding`
- `/dashboard/commerce/merchants`
- `/dashboard/commerce/merchants/{merchant_id}`
- `/dashboard/commerce/catalog`
- `/dashboard/commerce/inventory`
- `/dashboard/commerce/pricing`
- `/dashboard/commerce/offers`
- `/dashboard/commerce/stores`
- `/dashboard/commerce/payments`
- `/dashboard/commerce/ai-native`
- `/dashboard/commerce/ai-native/capabilities`
- `/dashboard/commerce/ai-native/protocols`
- `/dashboard/commerce/ai-native/preview`

Merchant onboarding flow:

1. Create merchant account.
2. Create or select Grantex tenant.
3. Enter business profile.
4. Verify business identity.
5. Add store locations and online channels.
6. Connect payment rail.
7. Connect catalog source.
8. Configure inventory source.
9. Configure pricing and offers.
10. Configure fulfillment, returns, warranty, and support policies.
11. Configure agent access and merchant policies.
12. Publish AI-native endpoints.
13. Run sandbox validation.
14. Request live activation.

AI-native publishing setup flow:

1. Select capabilities to publish:
   - catalog
   - inventory
   - pricing
   - offers
   - cart
   - checkout
   - payment
   - booking/reservation
   - pickup/delivery
   - order status
   - cancellation
   - refund
   - returns/exchanges
   - complaints/support
   - warranty/service
   - loyalty/gift cards
   - subscriptions
   - human handoff
2. Select protocols/surfaces:
   - Grantex native API
   - MCP
   - UCP-style
   - ACP-compatible
   - A2A handoff
   - AgenticOrg agents
   - embedded merchant agent
3. Configure visibility per capability:
   - public
   - verified agents only
   - trusted/allowlisted agents only
   - user-grant required
   - merchant-approval required
   - disabled
4. Configure data exposure:
   - product/category filters
   - store/location filters
   - inventory visibility
   - pricing visibility
   - offer visibility
5. Validate all selected capabilities.
6. Preview protocol-specific output.
7. Run sandbox agent simulation.
8. Publish to sandbox.
9. Request live publish.

Catalog ingestion options:

- Shopify connector.
- WooCommerce connector.
- Magento / Adobe Commerce connector.
- Custom REST API connector.
- Merchant inbound webhook connector.
- CSV upload.
- Google Merchant Center feed import.
- Manual product entry for sandbox and early pilots.
- ONDC feed connector in a later release.

Catalog fields:

- Product ID.
- SKU.
- Title.
- Description.
- Brand.
- Category.
- Images.
- Variants.
- Attributes/specifications.
- Dimensions/weight.
- Warranty.
- Return eligibility.
- Related products.
- Substitutes.
- Accessories.
- Product Q&A.
- AI-readable summary.
- UCP/ACP/MCP readiness status.

Inventory ingestion options:

- Real-time API.
- Merchant inbound webhook connector.
- Scheduled sync.
- CSV upload.
- Store/POS connector.
- Manual inventory update for pilots.

Inventory fields:

- SKU.
- Store/location ID.
- Available quantity.
- Reserved quantity.
- Safety stock.
- Availability status.
- Pickup availability.
- Delivery availability.
- Last synced timestamp.
- Inventory confidence score.

Pricing and offers ingestion options:

- Commerce platform connector.
- Custom API.
- Merchant inbound webhook connector.
- CSV upload.
- Plural/Pine offer and affordability sources where available.
- Manual offer rules.

Pricing fields:

- SKU.
- Base price.
- Sale price.
- Currency.
- Tax treatment.
- Store-level price.
- Member price.
- Agent-only offer price.
- Start/end date.
- EMI eligibility.
- Reward/loyalty eligibility.
- Coupon/bundle eligibility.
- Margin guardrail metadata where merchant provides it.

AI-native publishing requirements:

- Generate `/.well-known/grantex-commerce`.
- Generate UCP-style merchant profile.
- Generate MCP tool manifest.
- Generate ACP-compatible checkout metadata where applicable.
- Generate A2A/agent handoff metadata where applicable.
- Generate per-protocol capability matrix.
- Show endpoint health.
- Show catalog readiness score.
- Show inventory freshness.
- Show pricing freshness.
- Show booking/reservation readiness.
- Show refund/support readiness.
- Show missing attributes.
- Show last successful sync.
- Provide "publish/unpublish" control.
- Provide "test as agent" simulator.
- Provide protocol preview before publishing.
- Provide capability-level publish controls.
- Provide public/verified/trusted/user-grant visibility controls.

Acceptance criteria:

- A merchant can register and reach sandbox mode without engineering help.
- A merchant can upload or connect catalog, inventory, and pricing data.
- A merchant can see whether products are AI-ready.
- A merchant can publish AI-native endpoints only after required validation passes.
- A merchant can publish catalog, inventory, pricing, offers, cart, checkout, payment, booking, refund, returns, complaints/support, loyalty, subscriptions, and handoff capabilities where configured and supported.
- A merchant can see exactly which capabilities are exposed through each protocol.
- A merchant can disable one capability across all protocols from one control.
- A merchant can disable one protocol without disabling others.
- AgenticOrg agents consume merchant data from this Grantex Commerce data hub.
- Grantex Commerce remains the source of truth for merchant AI-native configuration.

Import and sync validation requirements:

- Show row-level CSV validation errors.
- Show connector authentication errors.
- Show field mapping preview before import.
- Allow dry-run import.
- Allow rollback of last import where feasible.
- Deduplicate by SKU/source ID.
- Reject products without title, SKU/variant ID, and price when publishing for checkout.
- Warn but do not reject products missing AI enrichment fields.
- Block checkout for products missing valid price.
- Block reservation for products missing valid inventory status unless merchant policy allows manual confirmation.
- Maintain sync job history with started/completed/failed counts.

AI readiness scoring:

- Product readiness score must be computed from required attributes, images, price validity, inventory validity, return policy, warranty/service policy, category mapping, and AI-readable description.
- Merchant readiness score must aggregate catalog readiness, payment readiness, policy readiness, endpoint readiness, and audit readiness.
- Readiness score must be explanatory: show exact missing fields and next action.

#### 7.1.5 API And SDK Additions

Add:

- TypeScript SDK support.
- Python SDK support.
- Express middleware.
- FastAPI middleware.
- MCP server auth integration.

Required SDK methods:

- `commerce.passports.requestConsent()`
- `commerce.passports.issue()`
- `commerce.passports.verify()`
- `commerce.passports.revoke()`
- `commerce.payments.createIntent()`
- `commerce.payments.createCheckoutLink()`
- `commerce.payments.getStatus()`
- `commerce.policies.evaluate()`
- `commerce.audit.listEvents()`

Required merchant/catalog SDK methods:

- `commerce.merchants.create()`
- `commerce.merchants.update()`
- `commerce.merchants.get()`
- `commerce.merchants.requestLiveActivation()`
- `commerce.catalog.upsertProduct()`
- `commerce.catalog.bulkImport()`
- `commerce.catalog.getProduct()`
- `commerce.catalog.search()`
- `commerce.inventory.upsertLevel()`
- `commerce.inventory.bulkImport()`
- `commerce.inventory.checkAvailability()`
- `commerce.pricing.upsertPrice()`
- `commerce.offers.upsertOfferRule()`
- `commerce.aiNative.publish()`
- `commerce.aiNative.unpublish()`
- `commerce.aiNative.getReadiness()`

Required admin/partner SDK methods:

- `commerce.partner.listMerchants()`
- `commerce.partner.getMerchantHealth()`
- `commerce.partner.getPaymentVolume()`
- `commerce.partner.getRiskEvents()`

#### 7.1.6 Playground

Add Commerce sandbox playground:

Flow:

1. Select demo merchant.
2. Select demo product/cart amount.
3. Select demo agent.
4. Request user consent.
5. Issue Commerce Passport.
6. Create sandbox Plural payment intent.
7. Simulate webhook.
8. View audit ledger.

Playground must include both:

- **Merchant setup mode:** connect/upload demo catalog, inventory, pricing, and publish AI-native endpoints.
- **Agent transaction mode:** simulate agent discovery, consent, checkout, payment webhook, and audit.

### 7.2 Work Required On AgenticOrg.ai

#### 7.2.1 New Commerce Solution Page

Create:

- `/solutions/commerce`

Purpose:

- Show merchant AI employees for sales, support, reconciliation, catalog, offers, and store operations.

Required sections:

1. Hero:
   - Headline: "AI employees for agentic commerce."
   - Subcopy: "Deploy governed merchant agents that sell, support, reconcile, and operate across online and offline commerce."
2. Agent cards:
   - Sales Agent.
   - Offer Agent.
   - Catalog Agent.
   - Support Agent.
   - Reconciliation Agent.
   - Store Operations Agent.
3. Trust section:
   - Secured by Grantex Commerce Passport.
4. Payments section:
   - Powered by Pine/Plural rails.
5. Demo flow.
6. Enterprise controls.
7. CTA:
   - "Deploy commerce agents"
   - "Request pilot"

#### 7.2.2 AgenticOrg Product Console Additions

Add Commerce Agent Pack:

- Agent templates.
- Merchant connection settings.
- Grantex tenant connection.
- Plural/Pine connection.
- Human approval queues.
- Agent run logs.
- Failed action queue.
- Reconciliation reports.

AgenticOrg console must show read-only merchant data sourced from Grantex Commerce:

- Merchant profile.
- Catalog readiness.
- Inventory freshness.
- Pricing freshness.
- Payment provider health.
- Allowed agent scopes.
- Active merchant policy version.

If data must be edited, AgenticOrg must deep-link to the corresponding Grantex Commerce page instead of creating a duplicate editor.

#### 7.2.3 Agent Templates

Build reusable templates:

- `commerce-sales-agent`
- `commerce-offer-agent`
- `commerce-catalog-agent`
- `commerce-support-agent`
- `commerce-reconciliation-agent`
- `commerce-store-ops-agent`

Each template must include:

- Tool manifest.
- Required Grantex scopes.
- Prompt/instruction template.
- Escalation rules.
- Test dataset.
- Evaluation suite.
- Sample merchant configuration.

#### 7.2.4 Human-In-Loop Workbench

Required queues:

- Payment approval.
- Refund approval.
- Offer override.
- Stock mismatch.
- Customer complaint.
- High-risk agent action.
- Policy violation review.

#### 7.2.5 Agent Evaluations

Add evals for:

- Does not create payment without consent.
- Does not exceed spending limit.
- Does not hallucinate offers.
- Does not promise unavailable inventory.
- Escalates refund edge cases.
- Uses correct Grantex scope.
- Logs action to audit.

## 8. Data Model

### 8.1 Core Tables / Collections

Required entities:

- `CommerceMerchant`
- `MerchantStore`
- `MerchantIntegration`
- `CommerceAgent`
- `CommercePolicy`
- `CommerceGrant`
- `CommercePassport`
- `CommerceConsentRecord`
- `CommercePaymentIntent`
- `CommerceOrderReference`
- `CommerceReservation`
- `CommerceAuditEvent`
- `CommerceWebhookEvent`
- `CommerceOffer`
- `CommerceAgentSession`
- `CommerceSupportTicket`
- `CommerceProduct`
- `CommerceProductVariant`
- `CommerceInventoryLevel`
- `CommercePrice`
- `CommerceCatalogSyncJob`
- `CommerceInventorySyncJob`
- `CommercePricingSyncJob`
- `CommerceAIProfile`
- `CommerceMCPTool`
- `CommerceHumanApproval`
- `CommerceProviderCapability`
- `CommerceProviderCredential`
- `CommerceIntegrationHealth`
- `CommerceTeamMember`
- `CommerceRoleAssignment`
- `CommerceCategoryPreset`
- `CommerceCapability`
- `CommerceProtocolAdapter`
- `CommerceCart`
- `CommerceBooking`
- `CommerceComplaint`
- `CommerceReturnRequest`
- `CommerceRefundRequest`
- `CommerceLoyaltyAccount`

### 8.2 CommerceMerchant

Fields:

- `id`
- `tenant_id`
- `legal_name`
- `display_name`
- `website`
- `country`
- `currency`
- `business_category`
- `category_preset_key`
- `secondary_category_preset_keys`
- `category_preset_version`
- `tax_identifier`
- `status`
- `agent_access_enabled`
- `ucp_enabled`
- `acp_enabled`
- `mcp_enabled`
- `created_at`
- `updated_at`

### 8.2.1 CommerceCategoryPreset

Fields:

- `id`
- `preset_key`
- `display_name`
- `version`
- `status`
- `required_catalog_fields`
- `recommended_catalog_fields`
- `inventory_rules`
- `pricing_rules`
- `offer_rules`
- `default_capabilities`
- `default_protocol_exposure`
- `default_policy_rules`
- `agent_template_keys`
- `eval_suite_keys`
- `restricted_actions`
- `human_approval_thresholds`
- `created_at`
- `updated_at`

Preset keys:

- `electronics_appliances`
- `fashion_lifestyle`
- `beauty_personal_care`
- `pharmacy_wellness`
- `grocery_convenience`
- `restaurant_qsr`
- `services_bookings`
- `subscriptions_digital`
- `home_furniture`
- `b2b_wholesale`
- `generic_retail`

Category presets must be seed data and versioned. Updating a preset must not silently change live merchant policies; merchants must explicitly review and apply preset upgrades.

### 8.3 CommercePolicy

Fields:

- `id`
- `merchant_id`
- `version`
- `status`
- `rules`
- `created_by`
- `created_at`
- `activated_at`

Rules should be stored as structured JSON with validation.

### 8.4 CommercePassport

Fields:

- `id`
- `grant_id`
- `jti`
- `merchant_id`
- `agent_id`
- `human_principal_id`
- `scopes`
- `max_amount`
- `currency`
- `constraints`
- `expires_at`
- `revoked_at`
- `revocation_reason`
- `created_at`

### 8.5 CommercePaymentIntent

Fields:

- `id`
- `merchant_id`
- `agent_id`
- `human_principal_id`
- `passport_jti`
- `amount`
- `currency`
- `line_items`
- `provider`
- `provider_order_id`
- `provider_payment_id`
- `checkout_url`
- `status`
- `metadata`
- `created_at`
- `updated_at`

### 8.6 CommerceProduct

Fields:

- `id`
- `merchant_id`
- `source_system`
- `source_record_id`
- `title`
- `description`
- `brand`
- `category`
- `status`
- `images`
- `attributes`
- `ai_summary`
- `product_questions`
- `return_eligible`
- `warranty_summary`
- `readiness_score`
- `missing_fields`
- `last_synced_at`
- `created_at`
- `updated_at`

### 8.7 CommerceProductVariant

Fields:

- `id`
- `merchant_id`
- `product_id`
- `sku`
- `source_variant_id`
- `title`
- `attributes`
- `barcode`
- `dimensions`
- `weight`
- `status`
- `created_at`
- `updated_at`

### 8.8 CommerceInventoryLevel

Fields:

- `id`
- `merchant_id`
- `variant_id`
- `sku`
- `store_id`
- `available_quantity`
- `reserved_quantity`
- `availability_status`
- `pickup_available`
- `delivery_available`
- `freshness_status`
- `confidence_score`
- `last_synced_at`
- `created_at`
- `updated_at`

### 8.9 CommercePrice

Fields:

- `id`
- `merchant_id`
- `variant_id`
- `sku`
- `store_id`
- `currency`
- `base_amount`
- `sale_amount`
- `member_amount`
- `agent_offer_amount`
- `tax_inclusive`
- `valid_from`
- `valid_until`
- `freshness_status`
- `last_synced_at`
- `created_at`
- `updated_at`

### 8.10 CommerceAIProfile

Fields:

- `id`
- `merchant_id`
- `environment`
- `grantex_profile_url`
- `ucp_profile_url`
- `mcp_server_url`
- `acp_metadata_url`
- `published`
- `published_at`
- `last_validated_at`
- `validation_errors`
- `capabilities`
- `created_at`
- `updated_at`

### 8.11 CommerceHumanApproval

Fields:

- `id`
- `merchant_id`
- `agent_id`
- `human_principal_id`
- `requested_action`
- `requested_payload`
- `policy_decision_id`
- `status`
- `assigned_to`
- `approval_reason`
- `approved_at`
- `rejected_at`
- `expires_at`
- `created_at`
- `updated_at`

### 8.12 Data Constraints

Required constraints:

- Unique merchant slug per tenant.
- Unique SKU per merchant unless source system allows duplicates; duplicates must be explicitly mapped.
- Unique provider credential per merchant/provider/environment.
- Unique active AI profile per merchant/environment.
- Payment intent idempotency key unique per merchant/action.
- Audit event IDs globally unique.
- Passport JTI globally unique.

Required indexes:

- Merchant by tenant/status.
- Product by merchant/status/category.
- Variant by merchant/SKU.
- Inventory by merchant/SKU/store.
- Price by merchant/SKU/store/current validity.
- Audit by merchant/created_at.
- Audit by passport JTI.
- Payment intent by merchant/status/created_at.
- Policy by merchant/status/version.

### 8.13 CommerceCapability

Fields:

- `id`
- `merchant_id`
- `capability_key`
- `display_name`
- `description`
- `enabled`
- `environment`
- `visibility`
- `required_scopes`
- `required_passport_type`
- `requires_user_consent`
- `requires_merchant_approval`
- `provider_dependency`
- `provider_capability_status`
- `protocol_mappings`
- `input_schema`
- `output_schema`
- `rate_limit`
- `last_validated_at`
- `validation_errors`
- `created_at`
- `updated_at`

Capability keys must include:

- `merchant.profile`
- `store.profile`
- `catalog.search`
- `catalog.product_detail`
- `inventory.availability`
- `inventory.exact_quantity`
- `pricing.read`
- `offers.eligible`
- `cart.create`
- `cart.update`
- `checkout.create`
- `payment.initiate`
- `payment.status`
- `booking.create`
- `booking.update`
- `pickup.create`
- `delivery.options`
- `order.status`
- `order.cancel_request`
- `refund.request`
- `refund.execute`
- `return.request`
- `exchange.request`
- `complaint.create`
- `support.ticket_create`
- `warranty.service_request`
- `loyalty.read`
- `loyalty.redeem`
- `giftcard.read`
- `giftcard.redeem`
- `subscription.create`
- `subscription.manage`
- `human_handoff.create`

### 8.14 CommerceProtocolAdapter

Fields:

- `id`
- `protocol_key`
- `display_name`
- `version`
- `enabled`
- `supported_capability_keys`
- `profile_url`
- `manifest_url`
- `last_generated_at`
- `last_validated_at`
- `validation_errors`
- `created_at`
- `updated_at`

Protocol keys:

- `grantex_native`
- `mcp`
- `ucp_style`
- `acp_compatible`
- `a2a_handoff`

### 8.15 CommerceCart

Fields:

- `id`
- `merchant_id`
- `agent_id`
- `human_principal_id`
- `passport_jti`
- `status`
- `currency`
- `line_items`
- `subtotal_amount`
- `discount_amount`
- `tax_amount`
- `shipping_amount`
- `total_amount`
- `expires_at`
- `created_at`
- `updated_at`

### 8.16 CommerceBooking

Fields:

- `id`
- `merchant_id`
- `store_id`
- `agent_id`
- `human_principal_id`
- `passport_jti`
- `booking_type`
- `status`
- `resource_id`
- `scheduled_start_at`
- `scheduled_end_at`
- `pickup_code`
- `metadata`
- `created_at`
- `updated_at`

### 8.17 CommerceComplaint

Fields:

- `id`
- `merchant_id`
- `agent_id`
- `human_principal_id`
- `passport_jti`
- `order_reference_id`
- `category`
- `priority`
- `status`
- `subject`
- `description`
- `attachments`
- `assigned_to`
- `created_at`
- `updated_at`

### 8.18 CommerceReturnRequest And CommerceRefundRequest

Return request fields:

- `id`
- `merchant_id`
- `agent_id`
- `human_principal_id`
- `passport_jti`
- `order_reference_id`
- `line_items`
- `reason`
- `status`
- `requires_human_approval`
- `created_at`
- `updated_at`

Refund request fields:

- `id`
- `merchant_id`
- `agent_id`
- `human_principal_id`
- `passport_jti`
- `payment_intent_id`
- `amount`
- `currency`
- `reason`
- `status`
- `provider_refund_id`
- `requires_human_approval`
- `created_at`
- `updated_at`

## 9. API Requirements

### 9.1 Authentication

Support:

- Grantex API keys for server-to-server.
- OAuth 2.1/OIDC for dashboard users.
- Grantex grant tokens for agent actions.
- Signed webhooks from payment providers.

### 9.1.1 API Versioning

Requirements:

- All public APIs use `/v1`.
- Breaking changes require `/v2`.
- Response objects include `api_version`.
- Deprecations require dashboard warning and documentation.
- MCP tool schema versions must be explicit.
- UCP/ACP compatibility versions must be recorded in merchant AI profile.

### 9.2 Authorization

Every write/payment/support/order action must evaluate:

1. Agent identity.
2. Passport validity.
3. Scope.
4. Merchant policy.
5. User consent.
6. Amount/category/merchant constraints.
7. Revocation status.
8. Risk/anomaly rules.

### 9.3 Error Model

Errors must be structured:

- `invalid_passport`
- `passport_expired`
- `passport_revoked`
- `scope_denied`
- `amount_limit_exceeded`
- `merchant_mismatch`
- `policy_denied`
- `human_approval_required`
- `provider_error`
- `webhook_verification_failed`
- `payment_failed`
- `rate_limited`

Error response fields:

- `error`
- `message`
- `decision_id`
- `audit_event_id`
- `remediation`

### 9.4 Required REST API Surface

Merchant APIs:

- `POST /v1/commerce/merchants`
- `GET /v1/commerce/merchants`
- `GET /v1/commerce/merchants/{merchant_id}`
- `PATCH /v1/commerce/merchants/{merchant_id}`
- `POST /v1/commerce/merchants/{merchant_id}/verify`
- `POST /v1/commerce/merchants/{merchant_id}/request-live`
- `POST /v1/commerce/merchants/{merchant_id}/disable-agentic-commerce`
- `GET /v1/commerce/category-presets`
- `GET /v1/commerce/category-presets/{preset_key}`
- `POST /v1/commerce/merchants/{merchant_id}/category-presets/apply`
- `POST /v1/commerce/merchants/{merchant_id}/category-presets/preview`

Store APIs:

- `POST /v1/commerce/merchants/{merchant_id}/stores`
- `GET /v1/commerce/merchants/{merchant_id}/stores`
- `PATCH /v1/commerce/stores/{store_id}`
- `DELETE /v1/commerce/stores/{store_id}`

Catalog APIs:

- `POST /v1/commerce/catalog/products`
- `POST /v1/commerce/catalog/products/bulk`
- `GET /v1/commerce/catalog/products`
- `GET /v1/commerce/catalog/products/{product_id}`
- `PATCH /v1/commerce/catalog/products/{product_id}`
- `POST /v1/commerce/catalog/search`
- `POST /v1/commerce/catalog/sync-jobs`
- `GET /v1/commerce/catalog/sync-jobs/{sync_job_id}`

Inventory APIs:

- `POST /v1/commerce/inventory/levels`
- `POST /v1/commerce/inventory/levels/bulk`
- `GET /v1/commerce/inventory/availability`
- `POST /v1/commerce/inventory/reservations`
- `PATCH /v1/commerce/inventory/reservations/{reservation_id}`
- `POST /v1/commerce/inventory/sync-jobs`

Pricing and offer APIs:

- `POST /v1/commerce/pricing/prices`
- `POST /v1/commerce/pricing/prices/bulk`
- `GET /v1/commerce/pricing/prices`
- `POST /v1/commerce/offers`
- `GET /v1/commerce/offers/eligible`
- `PATCH /v1/commerce/offers/{offer_id}`

AI-native publishing APIs:

- `GET /v1/commerce/ai-native/readiness`
- `POST /v1/commerce/ai-native/publish`
- `POST /v1/commerce/ai-native/unpublish`
- `GET /v1/commerce/ai-native/profile`
- `GET /v1/commerce/ai-native/mcp-tools`
- `GET /v1/commerce/ai-native/capabilities`
- `PATCH /v1/commerce/ai-native/capabilities/{capability_id}`
- `GET /v1/commerce/ai-native/protocols`
- `PATCH /v1/commerce/ai-native/protocols/{protocol_key}`
- `GET /v1/commerce/ai-native/preview`
- `POST /v1/commerce/ai-native/validate`

Cart APIs:

- `POST /v1/commerce/carts`
- `GET /v1/commerce/carts/{cart_id}`
- `POST /v1/commerce/carts/{cart_id}/items`
- `PATCH /v1/commerce/carts/{cart_id}/items/{item_id}`
- `DELETE /v1/commerce/carts/{cart_id}/items/{item_id}`
- `POST /v1/commerce/carts/{cart_id}/checkout`

Booking/reservation APIs:

- `POST /v1/commerce/bookings`
- `GET /v1/commerce/bookings/{booking_id}`
- `PATCH /v1/commerce/bookings/{booking_id}`
- `POST /v1/commerce/bookings/{booking_id}/cancel`
- `POST /v1/commerce/bookings/{booking_id}/confirm`

Order, return, refund, and complaint APIs:

- `GET /v1/commerce/orders/{order_id}`
- `POST /v1/commerce/orders/{order_id}/cancel-request`
- `POST /v1/commerce/returns`
- `GET /v1/commerce/returns/{return_request_id}`
- `POST /v1/commerce/exchanges`
- `POST /v1/commerce/refunds/request`
- `GET /v1/commerce/refunds/{refund_request_id}`
- `POST /v1/commerce/complaints`
- `GET /v1/commerce/complaints/{complaint_id}`
- `POST /v1/commerce/support/tickets`
- `POST /v1/commerce/warranty/service-requests`

Loyalty, gift card, and subscription APIs:

- `GET /v1/commerce/loyalty/accounts/{account_id}`
- `POST /v1/commerce/loyalty/redeem`
- `GET /v1/commerce/giftcards/{giftcard_id}`
- `POST /v1/commerce/giftcards/redeem`
- `POST /v1/commerce/subscriptions`
- `GET /v1/commerce/subscriptions/{subscription_id}`
- `PATCH /v1/commerce/subscriptions/{subscription_id}`

Policy APIs:

- `POST /v1/commerce/policies`
- `GET /v1/commerce/policies`
- `GET /v1/commerce/policies/{policy_id}`
- `POST /v1/commerce/policies/{policy_id}/activate`
- `POST /v1/commerce/policies/simulate`
- `POST /v1/commerce/policies/evaluate`

Passport APIs:

- `POST /v1/commerce/passports/consent-requests`
- `POST /v1/commerce/passports/exchange`
- `POST /v1/commerce/passports/verify`
- `POST /v1/commerce/passports/revoke`
- `GET /v1/commerce/passports`

Payment APIs are defined in Section 6.3 and must follow the same auth/error/idempotency model.

### 9.5 Pagination, Filtering, And Sorting

List endpoints must support:

- `limit`
- `cursor`
- `sort`
- `created_after`
- `created_before`
- Relevant status filters.

Large bulk endpoints must be asynchronous and return a sync/import job ID.

### 9.6 Idempotency

Required for:

- Payment intent creation.
- Checkout link creation.
- Refund requests.
- Subscription creation.
- Inventory reservation.
- Bulk imports.
- Webhook processing.

Idempotency keys must be scoped by merchant, endpoint, and environment.

### 9.7 Webhook Requirements

Grantex Commerce outbound webhooks:

- `commerce.passport.issued`
- `commerce.passport.revoked`
- `commerce.payment_intent.created`
- `commerce.payment_intent.paid`
- `commerce.payment_intent.failed`
- `commerce.refund.requested`
- `commerce.reservation.created`
- `commerce.policy.denied`
- `commerce.human_approval.required`
- `commerce.ai_profile.published`

Outbound webhook requirements:

- Signed payload.
- Retry with backoff.
- Delivery log.
- Manual replay.
- Tenant-level webhook secrets.
- Event schema documentation.

### 9.8 Merchant Inbound Webhook Requirements

Merchants and commerce platforms must be able to push operational changes into Grantex Commerce through signed inbound webhooks. This is required for enterprise-grade freshness and cannot be replaced only by polling or UI uploads.

Inbound webhook endpoint pattern:

- `POST /v1/webhooks/merchant/{merchant_id}/{source_key}`

Required inbound event types:

- `merchant.profile.updated`
- `store.created`
- `store.updated`
- `catalog.product.created`
- `catalog.product.updated`
- `catalog.product.deleted`
- `catalog.variant.created`
- `catalog.variant.updated`
- `catalog.variant.deleted`
- `inventory.level.updated`
- `inventory.reservation.updated`
- `pricing.price.updated`
- `offers.offer.created`
- `offers.offer.updated`
- `offers.offer.deleted`
- `cart.updated`
- `order.created`
- `order.updated`
- `order.cancelled`
- `booking.created`
- `booking.updated`
- `booking.cancelled`
- `payment.status.updated`
- `refund.created`
- `refund.updated`
- `return.created`
- `return.updated`
- `complaint.created`
- `complaint.updated`
- `support.ticket.updated`
- `loyalty.account.updated`
- `subscription.created`
- `subscription.updated`
- `subscription.cancelled`

Inbound webhook requirements:

- Merchant-specific signing secret.
- Signature verification before processing.
- Idempotency using provider event ID or event hash.
- Event timestamp validation.
- Replay protection.
- Schema validation per event type.
- Mapping to normalized Grantex data models.
- Dead-letter queue for failed events.
- Manual replay from dashboard.
- Sync job or event processing log visible to merchant.
- Ability to pause one inbound source without disabling all agentic commerce.

Inbound webhook behavior:

- Catalog, inventory, pricing, offer, booking, refund, complaint, support, loyalty, and subscription changes must update the normalized Grantex read model used by AI agents.
- If an inbound event invalidates a published capability, Grantex must mark that capability unhealthy and optionally unpublish it based on merchant policy.
- If price or inventory changes affect an active cart/payment intent, Grantex must re-evaluate policy and require new user consent if the total amount increases.
- If a product becomes unavailable, Grantex must block new checkout/reservation and notify active agent sessions where possible.

### 9.9 API-First Product Requirement

Every dashboard action must be backed by an API or typed server action that can be documented, tested, authorized, and audited.

No UI-only implementation is acceptable for:

- Merchant registration.
- Category preset selection.
- Catalog/inventory/pricing ingestion.
- Capability publishing.
- Protocol enablement.
- Policy creation/evaluation.
- Agent access configuration.
- Payment intent creation.
- Booking/reservation.
- Refund/return/complaint/support actions.
- Webhook configuration.
- Audit export.
- Emergency disable.

Enterprise merchants must be able to operate Grantex Commerce primarily through APIs, SDKs, and webhooks without relying on manual dashboard workflows.

## 10. Security And Compliance

### 10.1 Security Requirements

- Offline JWT verification via JWKS.
- Online revocation check.
- Short-lived commerce passports.
- Strict scope enforcement.
- Merchant-level rate limits.
- Webhook signature verification.
- Idempotency keys on payment/order APIs.
- PII minimization.
- Encryption at rest.
- Secrets manager for provider credentials.
- RBAC for merchant console.
- Audit log immutability/tamper evidence.

### 10.2 Compliance Requirements

Support compliance evidence for:

- DPDP Act readiness.
- SOC 2 controls.
- PCI-sensitive boundary avoidance by relying on Plural/Pine for payment data.
- Consumer consent evidence.
- Merchant policy evidence.
- AI agent accountability.

### 10.3 Risk Controls

Required:

- Anomaly detection for unusual agent actions.
- High-value payment approval.
- New agent trust scoring.
- Merchant emergency kill switch.
- User revoke-all function.
- Admin fraud review queue.

### 10.4 Threat Model

The implementation must defend against:

- Rogue agent attempting payment without user consent.
- Agent replaying an old passport.
- Agent using passport for wrong merchant.
- Agent exceeding amount/category/payment constraints.
- Prompt-injected agent attempting unauthorized tool call.
- Merchant misconfiguration exposing private inventory or customer data.
- Webhook spoofing.
- Provider callback replay.
- Cross-tenant data access.
- API key leakage.
- Admin abuse.
- Stale inventory causing false availability promises.
- Stale pricing causing incorrect checkout amount.

Required mitigations:

- Signed short-lived passports.
- JTI replay detection for sensitive actions.
- Merchant and amount binding in passport.
- Scope enforcement on every tool/API.
- Webhook signature verification and idempotent processing.
- Tenant-scoped RBAC and API keys.
- Audit logs for admin actions.
- Stale data gates.
- Policy simulator and safe defaults.

### 10.5 Privacy Requirements

Requirements:

- Collect minimum user data needed for consent and audit.
- Do not store raw card data or payment credentials.
- Tokenize provider references where possible.
- Redact PII in logs.
- Allow user to view and revoke active commerce grants.
- Allow merchant to export consent/audit evidence without exposing unrelated user data.
- Support data deletion workflows subject to legal/audit retention requirements.
- Separate conversation transcripts from payment/audit records; store transcript references, not full transcripts, unless explicitly enabled.

### 10.6 RBAC Requirements

Required merchant roles:

- `owner`: full merchant control.
- `admin`: manage integrations, policies, team, and live mode.
- `developer`: manage API keys, webhooks, sandbox, docs.
- `operations`: manage orders, reservations, approvals, support.
- `analyst`: read analytics and audit.
- `viewer`: read-only.

Sensitive actions requiring owner/admin:

- Enable live mode.
- Add live payment credentials.
- Disable audit export.
- Change high-risk policy rules.
- Emergency disable.
- Revoke all passports.
- Invite admin/owner.

### 10.7 Regulatory And Payment-Network Requirements

Agentic commerce involving payments must be treated as regulated payment-adjacent infrastructure. Legal and compliance review is required before live payment delegation.

India/RBI requirements:

- Grantex must not assume autonomous agent payments are permitted without user confirmation.
- Default live payment mode in India must require final user confirmation unless a legally valid mandate exists.
- Commerce Passport must distinguish between:
  - user-confirmed checkout;
  - delegated checkout preparation;
  - recurring/mandated payments;
  - merchant-side operational actions.
- RBI AFA requirements must be mapped to each passport type.
- UPI AutoPay/e-mandate flows must be modeled separately from one-time checkout.
- Recurring payments must store mandate reference, amount cap, frequency, expiry, cancellation method, and user consent evidence.
- High-risk categories, pharmacy/wellness, financial products, and regulated goods must require category-specific legal guardrails.

Network/protocol requirements:

- AP2, MPP, and other payment-network agent authorization protocols must be tracked as strategic compatibility targets.
- Grantex should support AP2/MPP-style mandate evidence where specifications and partner access allow.
- Grantex must not claim full AP2, MPP, UCP, ACP, or A2A compliance unless validated against the relevant public or partner specification.
- Until validated, product copy must use "compatible", "adapter", or "profile" language rather than "certified" or "compliant".

Required compliance outputs:

- Consent evidence export.
- Passport verification record.
- Policy decision record.
- Payment provider reference.
- Mandate reference where applicable.
- User revocation/cancellation history.
- Merchant terms and refund policy version.

Live launch blocker:

- No live delegated payment flow may launch in India until legal review confirms the flow satisfies RBI/AFA/mandate requirements.

## 11. Analytics

### 11.1 Merchant Analytics

Dashboards:

- Agent-driven revenue.
- Agent sessions.
- Conversion funnel.
- Payments created/paid/failed.
- Top agents.
- Top products.
- Rejected policy actions.
- Consent conversion.
- Failed checkout reasons.
- Refund/return rates.
- Offer performance.

### 11.2 Partner Analytics

For Pine/Plural:

- Agentic payment volume.
- Merchant adoption.
- Success rate by payment method.
- Offer/EMI attach rate.
- Sandbox-to-live conversion.
- Risk events.
- Merchant categories.

### 11.3 Grantex Analytics

- Passports issued.
- Passports verified.
- Revocations.
- Scope denials.
- Policy denials.
- Agent trust scores.
- API usage.
- Webhook latency.

## 12. User Journeys

### 12.1 Online Checkout With AI Agent

1. Merchant connects Plural and catalog.
2. Agent discovers merchant via UCP/MCP/profile.
3. User asks agent to buy product.
4. Agent creates cart draft.
5. Agent requests Grantex consent.
6. User approves.
7. Commerce Passport issued.
8. Agent creates payment intent.
9. Plural checkout link generated.
10. User pays.
11. Plural webhook confirms payment.
12. Merchant dashboard shows payment and audit.
13. AgenticOrg support/reconciliation agents continue post-payment workflow.

### 12.2 Support Agent Refund Request

1. User asks support agent for refund.
2. Support agent requests order read and refund request scope.
3. User approves.
4. Agent checks merchant refund policy.
5. Policy requires human approval if above threshold.
6. Refund request enters workbench.
7. Merchant approves.
8. Plural refund API called where available.
9. Audit log records entire chain.

### 12.3 Offline Store Reservation

1. User asks agent for nearby product.
2. Agent checks store inventory/reservation availability.
3. User grants reservation/payment permission.
4. Agent creates store reservation.
5. Pickup code generated.
6. Staff receives notification.
7. Customer visits store and pays via Pine POS or already-paid Plural checkout.
8. Store marks fulfilled.
9. Audit and reconciliation complete.

## 13. Implementation Plan

This is a complete working product plan, not only an MVP. Build in releases to reduce risk.

### Release 1: Grantex Commerce Foundation

Must include:

- Commerce scopes.
- Commerce Passport.
- Consent UX.
- Passport verification.
- Revocation.
- Audit events.
- Merchant entity.
- Basic merchant console.
- Sandbox merchant.
- Commerce docs.

Exit criteria:

- Agent can request consent and receive a signed Commerce Passport.
- Merchant can view passport and audit event.
- Revocation blocks future usage.

### Release 2: Plural Agentic Checkout

Must include:

- Plural sandbox integration.
- Payment intent API.
- Checkout link/order creation.
- Webhook handling.
- Payment status.
- Audit timeline.
- SDK helpers.
- Playground demo.

Exit criteria:

- End-to-end sandbox payment flow works.
- Payment cannot be created without valid passport.
- Webhook updates audit timeline.

### Release 3: Merchant Policy Console

Must include:

- Policy rules UI.
- Scope controls.
- Amount limits.
- Agent allowlist/blocklist.
- Human approval requirement.
- Emergency disable.
- Policy simulator.
- Policy decision logs.

Exit criteria:

- Merchant can configure and test policies.
- Policy denial blocks API actions.
- Every decision is auditable.

### Release 4: AI-Native Gateway

Must include:

- `/.well-known/grantex-commerce`.
- UCP-style profile.
- MCP tools.
- Catalog/search API.
- Cart/checkout API skeleton.
- ACP-compatible checkout metadata where feasible.
- External agent sandbox.
- Universal capability publishing matrix.
- Protocol adapter interface.
- Capability-level publish/unpublish controls.
- Protocol preview UI.
- Booking, refund, return, complaint/support, loyalty, gift card, subscription, and human handoff capability definitions.

Exit criteria:

- External MCP client can discover and call merchant tools.
- Payment/write tools require Commerce Passport.
- Merchant can see and control every exposed capability per protocol.
- Unsupported protocol/provider capabilities show explicit fallback and reason.

### Release 5: AgenticOrg Commerce Agent Pack

Must include:

- Sales Agent.
- Offer Agent.
- Support Agent.
- Reconciliation Agent.
- Catalog Agent.
- Human-in-loop queues.
- Evals.
- Agent run logs.

Exit criteria:

- AgenticOrg can run an end-to-end commerce conversation.
- Agents enforce Grantex permissions.
- Failed/high-risk actions enter human queue.

### Release 6: Pine POS / Offline Bridge

Must include:

- Store profile.
- Reservation model.
- Pickup code.
- POS bridge sandbox.
- Staff notification.
- Offline reconciliation.

Exit criteria:

- Offline reservation and pickup demo works.
- Merchant can view reservation lifecycle.

### Release 7: Production Hardening

Must include:

- RBAC.
- Rate limits.
- Observability.
- Audit exports.
- Compliance reports.
- Error dashboards.
- Webhook retries.
- Inbound merchant webhooks.
- Idempotency.
- Load testing.
- Security review.

Exit criteria:

- Production readiness checklist passed.
- Pilot merchants can go live.

### Release 8: GA Product Completeness

Must include:

- Complete merchant self-serve onboarding.
- Category preset system for launch categories.
- Complete catalog, inventory, pricing, and offer data hub.
- Live Plural integration behind feature flag.
- Partner-ready Pine/POS sandbox bridge.
- AgenticOrg Commerce Agent Pack enabled for pilot merchants.
- UCP-style, ACP-compatible, and MCP interoperability docs.
- Merchant analytics and partner analytics.
- Compliance export package.
- Support runbooks.
- Admin operations console.
- Billing/pricing hooks or internal usage metering.

Exit criteria:

- A new merchant can self-serve from signup to sandbox transaction without engineering assistance.
- An approved merchant can move from sandbox to live using documented checks.
- Launch category merchants receive category-specific required fields, policies, capabilities, and agent evals.
- At least one AgenticOrg commerce agent can complete a live or live-simulated commerce workflow.
- All release sign-off checklist items pass.

### 13.1 Engineering Workstreams

Claude Code should split implementation into these workstreams:

1. **Core schema and migrations**
   - All commerce tables/entities.
   - Indexes and constraints.
   - Tenant/environment isolation.
2. **Commerce Passport and consent**
   - Consent requests.
   - Passport claims.
   - Verification and revocation.
   - Consent UI.
3. **Merchant control plane**
   - Registration.
   - Verification.
   - Dashboard.
   - Team/RBAC.
4. **Commerce data hub**
   - Catalog.
   - Inventory.
   - Pricing.
   - Offers.
   - Sync jobs.
   - CSV import.
   - Inbound merchant webhooks.
5. **Provider adapters**
   - Mock provider.
   - Plural sandbox.
   - Plural live behind flag.
   - Pine POS mock/sandbox bridge.
6. **AI-native gateway**
   - Well-known endpoints.
   - UCP-style profile.
   - MCP tools.
   - ACP metadata.
7. **Policies and approvals**
   - Policy engine.
   - Simulator.
   - Human approval queue.
   - Emergency disable.
8. **AgenticOrg integration**
   - Tool manifests.
   - Agent templates.
   - Agent run logs.
   - Safety evals.
9. **Audit, analytics, observability**
   - Audit ledger.
   - Dashboards.
   - Exports.
   - Metrics/traces/logs.
10. **Docs, playground, demos**
   - Developer docs.
   - Commerce playground.
   - Demo merchants and demo agents.

### 13.2 Testing Requirements

Required test suites:

- Unit tests for passport claims and policy decisions.
- Unit tests for amount/currency constraints.
- Unit tests for lifecycle transitions.
- Unit tests for payment state machine.
- Integration tests for merchant onboarding.
- Integration tests for catalog/inventory/pricing import.
- Integration tests for merchant inbound webhooks.
- Integration tests for Plural mock/sandbox provider.
- Integration tests for webhook signature verification and replay.
- Integration tests for UCP/MCP profile generation.
- End-to-end test for agent discovery -> consent -> checkout -> webhook -> audit.
- End-to-end test for revocation blocking checkout.
- End-to-end test for policy denial and human approval.
- Agent evals for each AgenticOrg commerce agent.
- RBAC tests for merchant dashboard.
- Multi-tenant isolation tests.
- Rate-limit tests.
- Security tests for token tampering, expired passports, revoked passports, and merchant mismatch.

Minimum quality gates:

- Core commerce unit tests: 90%+ coverage.
- Security-critical modules: 95%+ coverage.
- All payment state transitions tested.
- All policy default rules tested.
- All launch category presets tested.
- Category-specific readiness scoring tested.
- Category-specific agent evals tested for launch categories.
- No production route without auth/tenant checks.
- No live provider action without idempotency key.

### 13.3 Observability Requirements

Metrics:

- Passport issuance latency.
- Passport verification latency.
- Policy evaluation latency.
- Payment intent creation latency.
- Provider API latency/error rate.
- Webhook processing latency.
- Catalog sync duration.
- Inventory freshness.
- Pricing freshness.
- Agent tool call success/failure.
- Human approval SLA.

Logs:

- Structured JSON logs.
- Correlation ID per agent session.
- Request ID per API call.
- Provider request ID where available.
- Audit event ID where available.

Traces:

- End-to-end trace from agent request to Grantex policy to provider call to webhook.

Alerts:

- Provider failure spike.
- Webhook verification failure.
- Payment stuck in pending.
- Inventory sync stale.
- Pricing sync stale.
- High policy denial spike.
- Unusual agent activity.
- Audit write failure.

### 13.4 Admin Operations Requirements

Internal admins must be able to:

- Search merchants.
- View merchant health.
- Suspend merchant.
- Suspend agent.
- Revoke passports.
- Replay webhooks.
- Retry sync jobs.
- Inspect provider capabilities.
- Export audit evidence.
- View failed policy decisions.
- View system alerts.
- Toggle tenant feature flags.

All admin actions must be audited.

## 14. Demo Requirements

Build a polished demo that shows:

> A user asks an AI agent to find a product, approve a bounded payment, create a Plural checkout, complete payment, and view audit trail.

Required demo scenario:

- Merchant: ABC Electronics.
- Product: washing machine or smartphone.
- Amount: INR 35,000 or lower.
- Offer: EMI or reward option if available.
- Agent: AgenticOrg Sales Agent.
- Consent: Grantex Commerce Passport.
- Payment: Plural sandbox checkout/payment link.
- Audit: full event timeline.

The demo must be repeatable from:

- Grantex playground.
- AgenticOrg commerce agent page.
- API/SDK quickstart.

## 15. Success Metrics

### Product Metrics

- Time to onboard merchant.
- Time to create first agentic payment.
- Consent completion rate.
- Payment success rate.
- Policy denial correctness.
- Audit completeness.
- Agent action failure rate.

### Business Metrics

- Number of live merchants.
- Agentic GMV.
- Plural/Pine payment volume influenced.
- Agent-driven conversion.
- Merchant retention.
- Revenue per merchant.
- Number of partner integrations.

### Trust Metrics

- Revocation latency.
- Passport verification latency.
- Policy evaluation latency.
- Audit event completeness.
- Fraud/anomaly detection rate.
- Human approval SLA.

### 15.4 GA Readiness Targets

Target thresholds before GA:

- Merchant self-serve sandbox onboarding: under 30 minutes for CSV/manual setup.
- Commerce Passport verification latency: p95 under 100 ms online, under 10 ms offline where cached JWKS is available.
- Policy evaluation latency: p95 under 150 ms.
- Payment intent creation latency excluding provider time: p95 under 500 ms.
- Webhook processing latency: p95 under 2 seconds.
- Audit event write success: 99.99% or fail-closed for protected actions.
- Catalog import success for valid CSV: 99%+.
- Payment state reconciliation: pending payments reconciled within 15 minutes.
- Revocation effectiveness: new protected calls blocked within 60 seconds, immediate for online verification.
- Agent eval pass rate: 95%+ on required commerce safety evals before pilot.

### 15.5 North Star Metric

Primary north star:

- **Trusted agentic GMV:** total successful payment volume initiated by AI agents with valid Grantex Commerce Passport and complete audit trail.

Supporting metrics:

- AI-native merchants live.
- Agentic payment success rate.
- Consent-to-payment conversion.
- Agent-driven revenue per merchant.
- Policy-safe action completion rate.
- Merchant retained after 90 days.

## 16. Pricing Direction

Recommended pricing:

1. Platform fee per merchant/month.
2. Usage fee per Commerce Passport issued or verified.
3. Usage fee per agentic payment intent.
4. Premium fee for AgenticOrg Commerce Agent Pack.
5. Enterprise fee for custom policies, self-hosting, compliance exports, and partner analytics.
6. Potential transaction revenue share with Pine/Plural where contractually possible.

Do not price only as a percentage of payment volume. The product creates value through trust, consent, compliance, and operations, not only transaction processing.

## 17. Open Questions

1. Which Plural APIs are available in partner sandbox for order/payment/refund/subscription/offer flows?
2. What Pine POS APIs can be used for reservation/payment intent/offline pickup?
3. Does Pine want co-branded product packaging or white-label integration?
4. Should UCP profile be generated per merchant domain or hosted under Grantex Commerce?
5. Which commerce platforms should be first connectors: Shopify, WooCommerce, Magento, custom API?
6. What legal language is required for agentic payment consent in India?
7. What merchant categories should be excluded from first launch?
8. Should Grantex Trust Registry include external commerce agents from day one?
9. What data can Pine/Plural share for partner analytics?
10. What is the exact division of support responsibility among merchant, Pine/Plural, Grantex, and AgenticOrg?

## 18. Recommended Build Order For Claude Code

When implementing in codebases, proceed in this order:

1. Add Grantex Commerce feature flags, tenant/environment boundaries, and RBAC primitives.
2. Add Grantex Commerce data models, migrations, indexes, and constraints.
3. Add commerce scopes and tool/action manifest.
4. Add Commerce Passport consent request, issuance, verification, revocation, and consent evidence.
5. Add audit event taxonomy, append-only event writer, and timeline APIs.
6. Add merchant registration, merchant lifecycle states, and merchant dashboard shell.
7. Add category presets for launch categories and wire presets into onboarding, readiness, policies, capabilities, and evals.
8. Add catalog, inventory, pricing, offers, stores, sync jobs, CSV import, validation, and readiness scoring.
9. Add mocked payment provider adapter and payment state machine.
10. Add Plural sandbox adapter, payment intent APIs, checkout link creation, webhooks, and reconciliation.
11. Add Merchant Policy Console, policy defaults, simulator, evaluation API, and human approval queue.
12. Add AI-native publishing: `/.well-known/grantex-commerce`, UCP-style profile, MCP tools, ACP metadata.
13. Add Commerce playground with merchant setup mode and agent transaction mode.
14. Add `/commerce` landing page and `/docs/commerce` documentation.
15. Add AgenticOrg Commerce Agent Pack, tool manifests, guardrails, run logs, and evals.
16. Add AgenticOrg console pages that consume Grantex merchant data and deep-link edits to Grantex.
17. Add Pine POS bridge mocked/sandbox flow for reservations and pickup.
18. Add merchant, partner, Grantex, and admin analytics.
19. Add observability, alerts, runbooks, operational admin console, compliance exports, and security hardening.
20. Run full test suite, E2E sandbox flow, threat model tests, and release sign-off checklist.

## 19. Release Sign-Off Checklist

Before production launch:

- Commerce Passport verified offline and online.
- Revocation tested.
- Scope enforcement tested.
- Amount/category/merchant constraints tested.
- Plural sandbox and live test complete.
- Webhook signature verification complete.
- Idempotency complete.
- Merchant emergency disable tested.
- Audit exports tested.
- AgenticOrg agents pass safety evals.
- Payment cannot be created without consent.
- Refund cannot be executed without proper scope and merchant policy.
- Sensitive payment data is not stored by Grantex.
- Security review complete.
- Developer docs complete.
- Demo works reliably.

### 19.1 Merchant Control Plane Sign-Off

- Merchant can register.
- Merchant can verify or enter sandbox verification.
- Merchant can select category preset.
- Merchant category preset applies required fields.
- Merchant category preset applies default policies.
- Merchant category preset applies default capability publishing settings.
- Category-specific readiness score works.
- Merchant can connect catalog.
- Merchant can import CSV catalog.
- Merchant can connect or upload inventory.
- Merchant can connect or upload pricing.
- Merchant can configure offers.
- Merchant can connect Plural sandbox.
- Merchant can validate provider credentials.
- Merchant can validate webhooks.
- Merchant can publish AI-native profile.
- Merchant can unpublish AI-native profile.
- Merchant can disable all agentic commerce.
- Merchant can invite team members and assign roles.

### 19.2 AI-Native Gateway Sign-Off

- `/.well-known/grantex-commerce` works.
- UCP-style profile works.
- MCP server/tools work.
- ACP-compatible metadata works or returns explicit unsupported state.
- A2A/agent handoff metadata works or returns explicit unsupported state.
- External agent discovery works.
- Read-only and protected tools enforce correct auth mode.
- Rate limits work.
- Tool schemas are documented.
- Capability Publishing Matrix is visible and accurate.
- Merchant can publish/unpublish each capability.
- Merchant can enable/disable each protocol independently.
- Catalog publishing works.
- Inventory publishing works.
- Pricing publishing works.
- Offer publishing works.
- Cart publishing works.
- Checkout/payment publishing works.
- Booking/reservation publishing works.
- Order status publishing works.
- Refund/return publishing works.
- Complaint/support publishing works.
- Loyalty/gift card publishing works or returns explicit unsupported state.
- Subscription publishing works or returns explicit unsupported state.
- Human handoff publishing works.

### 19.3 Payment And Provider Sign-Off

- Mock provider E2E passes.
- Plural sandbox E2E passes.
- Payment intent state machine rejects invalid transitions.
- Checkout link expiry works.
- Provider errors normalize correctly.
- Webhook replay is idempotent.
- Payment reconciliation job works.
- Refund request flow works in supported mode or returns explicit capability error.
- Subscription flow works in supported mode or returns explicit capability error.

### 19.4 AgenticOrg Sign-Off

- Sales Agent passes evals.
- Offer Agent passes evals.
- Catalog Agent passes evals.
- Support Agent passes evals.
- Reconciliation Agent passes evals.
- Store Operations Agent passes evals or is feature-flagged off.
- Agents cannot bypass Grantex tools.
- Agents cannot create checkout without consent.
- Agents cannot hallucinate offers in eval suite.
- Agents escalate human approvals correctly.

### 19.5 Security And Compliance Sign-Off

- Tenant isolation tests pass.
- RBAC tests pass.
- Passport tampering tests pass.
- Expired/revoked passport tests pass.
- Webhook spoofing tests pass.
- Merchant inbound webhook signature, replay, and schema tests pass.
- Audit write failure handling works.
- PII redaction verified.
- Secrets are stored only in approved secret storage.
- Admin actions are audited.
- Compliance export generated.

### 19.6 Operational Sign-Off

- Metrics dashboards live.
- Alerts configured.
- Runbooks written.
- Support escalation path documented.
- Feature flags configured.
- Backup and restore tested for critical data.
- Load test completed for expected pilot traffic.
- Rollback plan documented.
- Pilot merchant onboarding guide complete.

## 20. Final Product Statement

Grantex Commerce is a new product line that makes merchants safely usable by AI agents. It is not merely UCP, ACP, MCP, or checkout integration. It is the trust and control layer where agents get permission, merchants set policy, payments execute through Pine/Plural, AgenticOrg agents perform commerce work, and every action is auditable.

The product should make this sentence true:

> Any merchant using Pine/Plural can safely accept AI-agent-led commerce with verifiable consent, scoped payment authority, merchant policy controls, UCP/ACP/MCP interoperability, AgenticOrg merchant agents, and complete auditability.
