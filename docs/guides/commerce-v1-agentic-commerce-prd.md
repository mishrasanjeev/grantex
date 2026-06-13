---
title: Agentic Commerce PRD
description: Canonical product requirements document for Grantex Commerce and AgenticOrg agentic commerce implementation.
---

# Agentic Commerce PRD

This is the canonical consolidated PRD for Grantex Commerce and AgenticOrg
agentic commerce. It brings the seller journey, buyer journey, existing merchant
systems, buyer-agent channels, standards fit, safety gates, implementation gaps,
and fast-track roadmap into one place.

This document is planning and documentation only. It does not deploy, create
cloud resources, change production configuration, touch secrets, approve a real
merchant, enable public discovery, enable production Commerce V1, enable
checkout/payment creation, enable live payments, enable live Plural, or set a
production allowlist.

## 1. Product Thesis

Agentic commerce should let a buyer ask an AI agent to discover, compare, and
buy from a real merchant without the merchant rebuilding their business and
without the agent inventing commerce facts.

The corrected product boundary is:

> AgenticOrg is the buyer and seller AI-agent runtime. Grantex is the trust,
> protocol, policy, and canonical-artifact authority. Merchant systems remain
> the operational source of record. Provider and fintech rails own mandate and
> payment execution. Grantex must not become a toll booth for every buyer and
> seller agent interaction.

The finished product should allow:

- Sellers to self-serve from an AgenticOrg Seller Commerce Agent.
- Sellers to connect systems they already use through AgenticOrg seller-agent
  connector workflows, merchant-owned connector platforms, or approved external
  integration providers.
- Grantex to validate, govern, and sign canonical public-safe commerce
  artifacts derived from merchant-approved sources.
- Buyers to start from familiar chat or agent surfaces.
- AgenticOrg to run buyer-agent and seller-agent sessions from cached signed
  artifacts whenever TTL, revocation, and risk rules allow.
- Grantex to define and enforce policy, source/freshness, public-safe fact, and
  protocol-adapter rules without routing every non-binding interaction.
- Provider-owned mandate and payment systems to execute mandates and payments;
  Grantex stores only non-sensitive evidence references when artifact lineage or
  policy requires them.
- Standards-facing views to be generated from canonical OACP artifacts, not
  hand-maintained per platform.

## 2. Non-Negotiable Safety Boundary

An AI agent can initiate a commerce checkout through a payment provider only
when Grantex can verify:

- buyer consent;
- scope;
- merchant policy;
- revocation status;
- tenant boundary;
- agent identity;
- channel capability;
- amount cap;
- product/cart hash or equivalent cart evidence;
- idempotency;
- provider readiness;
- audit evidence;
- rollback readiness.

AgenticOrg must not:

- hold provider credentials;
- call Plural, Stripe, Pine, Razorpay, Cashfree, Adyen, PhonePe, or another
  payment provider directly for payment execution;
- call Shopify, WooCommerce, Magento, ERP, OMS, WMS, logistics, CRM/support, or
  merchant private APIs outside merchant-approved seller-agent connector sync
  jobs, approved external connector systems, or explicit human-authorized
  integration workflows;
- become the catalog, inventory, order, refund, settlement, or payout source of
  truth;
- store raw Commerce Passport values, JWTs, tokens, idempotency key values,
  webhook secrets, DB/Redis URLs, private keys, raw payloads, private merchant
  artifacts, pricing terms, contracts, or customer data;
- invent sellers, products, prices, discounts, stock, delivery promises, return
  eligibility, order status, payment status, settlement state, payout state, or
  refund outcomes.

## 3. Ownership Model

| Area | Grantex owns | AgenticOrg owns |
| --- | --- | --- |
| Merchant onboarding | Authority-side merchant identity, review state, category policy, canonical artifact issuance, and approval gates. | Seller Commerce Agent self-serve onboarding, merchant education, seller agent cards, connector setup workflow, and launch rehearsal. |
| Existing merchant systems | Source/freshness policy, accepted evidence refs, canonical fact validation, artifact signing, and connector risk rules. | Merchant-approved connector sync initiation, connector UX, credential-custody routing, source evidence capture, and seller-agent status. |
| Catalog and inventory | Buyer-safe canonical facts, source/freshness artifacts, policy constraints, TTLs, and refusal semantics. | Seller-agent sync, buyer-agent presentation, local cache across buyer agent, seller agent, tenant, and merchant, and stale/unknown UX. |
| Policy and consent | Policy rules, artifact authority, revocation snapshots, Commerce Passport posture, and audit evidence requirements. | Buyer-facing explanation, session state, cached artifact use within TTL, and refusal/refresh handoff. |
| Payment and mandates | Non-sensitive mandate capability evidence refs only when needed for policy/artifact lineage. Grantex does not own provider mandate setup or execution. | Provider-owned mandate capability verification where approved, buyer/seller UX, and handoff to provider or fintech rails. |
| Checkout/order execution | Future eligibility/audit contract checks only. Grantex must not be the default live transaction toll booth. | Future execution-controller handoff orchestration only after separate approval; no execution in current OACP slices. |
| Order and fulfillment | Canonical public-safe status artifacts when merchant systems provide evidence. | Buyer-facing status, support handoff, and refusal when facts are missing or stale. |
| Agent channels | Capability approval and channel limits. | ChatGPT, Claude, Gemini, WhatsApp, Telegram, web/mobile, and future channel adapters. |
| Standards and OACP | OACP artifact families, protocol adapter previews, detached-signature posture, TTLs, source/freshness rules, and non-publication guardrails. | Consume OACP artifacts, expose seller cards and channel bridges, and never treat adapters as transaction authority. |
| Audit and ops | Canonical evidence rules and future production audit contracts. | Local redacted session evidence, cache telemetry, refusal evals, and seller/buyer support workflow. |

## 4. Current Implementation Snapshot

Status as of 2026-06-13:

- Grantex and AgenticOrg have merged the internal OACP foundation through C6W9.
  The implementation is internal, non-publication, non-certifying,
  non-production, non-executing, and fail-closed.
- C6W3 defines the OACP artifact family and public-safe fixture corpus.
- C6W4 defines internal adapter previews for schema.org, UCP-style,
  ACP-style, AP2-style, A2A-style, and MCP-style targets without publication.
- C6W5 classifies non-binding preview, commitment-adjacent,
  commitment-bound, and always-blocked actions over cached signed artifacts.
- C6W6 prepares non-executing commitment request envelopes for human/source
  confirmation handoff.
- C6W7 reconciles local/cached response evidence with prepared envelopes.
- C6W8 prepares eligibility and audit-readiness packets over reconciliations.
- C6W9 performs dry-run verification that a future execution controller could
  read the packet contract. It still does not execute, approve, publish, create
  orders, create checkout/payment, call providers, call merchant private APIs,
  or enable public discovery.
- Public discovery, production Commerce V1, checkout/payment enablement, live
  payments, live Plural, production allowlists, certification claims, provider
  execution, and merchant private API execution remain blocked.

### 4.1 Grantex Foundation

| Capability | Current state | Gap |
| --- | --- | --- |
| Merchant/tenant control plane | Seller sandbox onboarding, category readiness, catalog readiness, public-safe agent preview, review request, operator decision, rollout proposal dry run, and AgenticOrg sandbox handoff are implemented through C6G. | Full self-serve production onboarding, KYB/KYC, live approval, and public discovery rollout remain blocked. |
| Category presets | `electronics_appliances` readiness checklist and scoring exist for the sandbox path. | Multi-category presets and policy/eval defaults remain future work. |
| Catalog and variants | Product/variant APIs, search/detail, bulk dry-run/upsert, patch/archive, CSV/JSON-oriented portal support, catalog readiness preview, and public-safe sample preview exist. | Large async imports, connector sync, conflict handling, rollback, richer price/offer models, and quantity inventory remain pending. |
| Inventory | Variant availability and freshness exist. | Quantity, location, confidence, reservations, stock holds, and delivery feasibility are missing. |
| Consent and Commerce Passport | Consent request/exchange/verify/revoke/challenge foundation exists. C6M AP2-style deterministic unsigned evidence preview is merged. | Production challenge delivery, signed mandate evidence, independent AP2 conformance, and live payment approval are pending. |
| Cart/payment intent | Cart draft and provider-neutral payment intent foundation exists. C6L ACP-style cart/checkout shape preview is merged. | Cart update/cancel/expire, fulfillment selection, ACP conformance, and broad live checkout readiness are pending. |
| Provider/webhooks | Provider credential and webhook intake/replay/reconciliation foundations exist. | Live Plural/provider approval, signature evidence, outage handling, and rollback proof remain gated. |
| Merchant webhooks | Signed merchant webhook source and catalog update intake exist. | Inventory-only, price-only, order, fulfillment, support, return, and refund webhooks are pending. |
| Existing-system connectors | C6N metadata-only connector registry, source precedence, sync health, stale/conflict blockers, and no-credential/no-execution guardrails are merged. | Real Shopify/WooCommerce/Magento/ERP/OMS/WMS/logistics/support/payment sync adapters remain pending. |
| Standards adapters | C6J schema.org JSON-LD preview, C6K UCP-style capability profile preview, C6L ACP-style checkout shape preview, and C6M AP2-style evidence preview are merged. | Public publication, certification, conformance suites, live capability negotiation, and public discovery remain blocked. |
| MCP/native surface | Read and checkout-oriented tools exist behind Grantex; C6G adds sandbox AgenticOrg buyer discovery handoff. | Public discovery remains fail-closed; public standards conformance is not complete. |
| Docs and CI | Commerce docs, docs-only workflow guard, and internal open-protocol packaging draft exist. | Keep consolidated PRD, overview, guides, manifests, and nav current as stacked PRs merge. |

### 4.2 AgenticOrg Foundation

| Capability | Current state | Gap |
| --- | --- | --- |
| Grantex-only connector aliases | Merchant profile, catalog search/detail, inventory, cart, consent, payment intent, checkout, payment status, and read-only buyer discovery preview aliases exist. | Order, fulfillment, support, return, refund, settlement, and payout aliases wait on Grantex APIs. |
| Buyer discovery workflow | C6H read-only consumer foundation is merged. C6I channel-neutral buyer-session orchestration is merged. | Live channel adapters and write-capable buyer flows remain blocked. |
| Sales agent guardrails | Missing consent/passport, amount-cap breach, disabled merchant/agent, policy denial, no-direct-provider, and read-only buyer discovery refusal protections exist or are merged in C6I. | Guardrails must expand as Grantex adds order, fulfillment, support, return, refund, settlement, and payout capabilities. |
| Demo/evals | Demo, golden evals, hosted smoke, no-direct-provider regressions, and focused buyer discovery tests exist. | Channel-specific smoke and live buyer UX evals are pending. |
| Public discovery | Fail-closed behind AgenticOrg public discovery flag. | Real merchant public discovery requires Grantex approval and AgenticOrg gating. |
| Docs-only CI guard | Docs-only changes skip build/push/deploy-adjacent jobs. | Keep guard current, especially for workflow changes. |
| Buyer channel launch | Channel-neutral response model is merged in C6I. | ChatGPT, Claude, Gemini, WhatsApp, Telegram, web/mobile, and future live adapters are not launch-ready yet. |

### 4.3 OACP Pending Work Register

The current C6W9 state proves internal contract shape only. It is not a public
protocol, not a transaction engine, and not a live commerce launch. Pending work
before any public or production OACP claim:

| Pending area | Why it matters | Correct owner | First acceptable output |
| --- | --- | --- | --- |
| Seller Commerce Agent onboarding | Merchants expect to start in AgenticOrg, not in a protocol console. | AgenticOrg runtime + Grantex authority | Seller agent creates onboarding packet, connector plan, artifact authority request, and blocked-path explanation. |
| Persistent artifact cache | Buyer and seller agents need continuity without Grantex in every non-binding turn. | AgenticOrg | Cache scoped by buyer agent, seller agent, tenant, and merchant with TTL, revocation snapshot, risk tier, and audit-safe telemetry. |
| Artifact issuance runtime | C6W3-C6W9 are helper/test foundations, not production issuance services. | Grantex | Internal artifact issuer/verifier service with key lifecycle, detached signature profile, revocation lookup, and no public endpoint until approved. |
| Connector credential custody | Merchants will choose where credentials live. | AgenticOrg + merchant/external connector provider + Grantex policy | Credential-custody matrix, OAuth/app install flow, source evidence refs, no raw secrets in Grantex by default. |
| Shopify/WooCommerce/ERP sync | Manual/CSV is not enough for real merchants. | AgenticOrg seller connectors + Grantex validation | First real connector sync dry-run with public-safe normalized evidence and rollback. |
| Price/inventory freshness | Agents must not promise stale stock or price. | Merchant systems + AgenticOrg cache + Grantex policy | TTL defaults, source timestamps, stale refusal, and refresh request UX per risk tier. |
| Provider-owned mandate verification | Mandates belong to fintech rails, not Grantex. | Provider/fintech + AgenticOrg verifier | First provider capability verifier with non-sensitive evidence refs only. |
| Execution controller ownership | C6W9 only dry-runs a future contract. | Product decision across AgenticOrg, merchant systems, and providers | Explicit owner, handoff contract, human approval gates, and stop conditions before any execution slice. |
| Third-party agent cards | Other agents should consume seller cards safely. | AgenticOrg + Grantex artifacts | Full or reduced seller cards with risk filters, artifact refs, and no transaction authority. |
| Public landing and blogs | Market needs clarity; overclaiming would damage trust. | Product/web/docs | Approved public-safe pages and visual explainers after this PRD is approved. |
| Public OACP governance | A protocol needs neutral stewardship. | Founder/legal/product decision | Separate repo/site, license, IPR posture, versioning, contribution model, and no standards claims until actually submitted/accepted. |

## 5. End-To-End Architecture

```mermaid
flowchart TB
  seller["Seller / merchant"]
  selleragent["AgenticOrg Seller Commerce Agent"]
  systems["Existing merchant systems"]
  connector["Merchant-approved connector sync"]
  grantex["Grantex trust, protocol, policy, and artifact authority"]
  artifacts["Signed OACP artifacts and adapter previews"]
  agenticorg["AgenticOrg buyer-agent runtime and cache"]
  channels["ChatGPT / Claude / Gemini / WhatsApp / Telegram / web / mobile"]
  provider["Provider and fintech mandate/payment rails"]
  buyer["Buyer"]

  seller --> selleragent
  selleragent --> connector
  systems --> connector
  connector --> grantex
  grantex --> artifacts
  artifacts --> agenticorg
  agenticorg --> channels
  channels --> buyer
  buyer --> provider
  agenticorg -. "provider capability verification, when approved" .-> provider
  provider -. "non-sensitive evidence refs only when needed" .-> grantex
```

Existing merchant systems may include:

- Shopify;
- WooCommerce;
- Magento;
- custom storefront;
- marketplace backend;
- ERP;
- PIM;
- inventory system;
- WMS;
- OMS;
- logistics provider;
- payment provider;
- CRM;
- support desk;
- finance/reconciliation system;
- CSV/API/manual maintenance process.

Those systems do not all have to connect directly to Grantex. The preferred
merchant experience is:

- AgenticOrg Seller Commerce Agent starts onboarding and connector setup.
- Connector credentials live where merchants are most comfortable: merchant
  system native app authorization, merchant-owned connector platform, external
  integration provider, or AgenticOrg vault only when explicitly selected and
  approved.
- AgenticOrg seller agents may initiate connector sync jobs when merchant
  policy allows it.
- Grantex receives public-safe normalized facts, hashes, source timestamps, and
  non-sensitive evidence references for artifact validation.
- Grantex does not store raw connector credentials by default and must not be
  required in every non-binding buyer/seller agent interaction.

## 6. One-Time Seller Setup

The seller setup must be self-serve for preparation, but not self-approval for
live commerce.

| Step | Seller action | Grantex requirement | Status/gate |
| --- | --- | --- | --- |
| 1. Create workspace | Sign up and create commerce tenant. | Tenant boundary, merchant shell, owner role, sandbox/live split. | Required before any data import. |
| 2. Complete profile | Enter legal name, display name, category, country, currency, support info, public description. | Separate public-safe metadata from private artifacts. | Public fields must pass review. |
| 3. Verify merchant | Provide legal/compliance/KYB/KYC evidence outside repos. | Store only non-secret evidence references and decision state. | No live mode without approval. |
| 4. Choose category preset | Select category such as home goods, electronics, fashion, grocery, pharmacy, services, B2B. | Apply required fields, policy defaults, tax, return, warranty, and safety expectations. | Missing critical fields block readiness. |
| 5. Connect systems | Use AgenticOrg Seller Commerce Agent, merchant-owned connectors, external integration providers, or approved CSV/API flow to connect storefront, ERP/PIM, inventory/WMS, OMS, logistics, payment, support, or CSV/API. | Define accepted source evidence, credential-custody rules, stale/conflict policy, and artifact validation requirements. | Connector health required before use; Grantex does not need raw connector credentials by default. |
| 6. Declare source of truth | Decide which source wins for catalog, price, inventory, order, fulfillment, support, refund, settlement. | Record precedence, timestamps, conflict handling, and rollback. | No silent conflict resolution. |
| 7. Prepare catalog | Fix title, description, image, brand, SKU, variants, category, price, tax, warranty, return summary. | Normalize to CommerceProduct and CommerceProductVariant. | Public-safe preview required. |
| 8. Prepare inventory/delivery | Configure stock state, freshness, delivery/pickup, shipping, serviceability, logistics source. | Block guarantees when stale, unknown, or unsupported. | Checkout blocked if evidence is insufficient. |
| 9. Configure agent permissions | Choose browse, compare, cart draft, checkout consent request, order status, support handoff, return/refund request. | Convert to policy, scopes, channel capabilities, amount caps, audit rules. | Each capability separately approved. |
| 10. Configure mandates/payment | Configure provider-owned mandate or payment rails outside Grantex first; share only capability/evidence references required for policy and OACP artifacts. | Validate non-sensitive mandate capability evidence references when needed for artifact lineage. | Live remains blocked until separate provider, merchant, and product approval. |
| 11. Review previews | See AI-agent-facing profile, catalog, policy, schema.org, and channel labels. | Render exact public-safe payload and blocked paths. | Product wording and security review required. |
| 12. Run scans | Run secret/private-detail, overclaim, synthetic-ID, production-ID, config/allowlist, stale-data scans. | Produce redacted evidence and blocker codes. | Clean scans required for readiness. |
| 13. Assign owners | Merchant owner, legal, product, security, ops, backup/RPO, rollback, smoke, evidence retention, AgenticOrg dependency. | Store non-secret owner references and approval state. | Missing owners block rollout. |
| 14. Rehearse launch | Run sandbox/demo buyer journey and rollback drill. | Generate smoke evidence and rollback checklist. | Required before rollout proposal. |
| 15. Request rollout | Ask for smallest approved surface, usually read-only discovery first. | Keep fail-closed until explicit approval. | Separate rollout approval required. |

## 7. One-Time Buyer Setup

The buyer setup should feel like normal chat/app account linking.

| Step | Buyer action | AgenticOrg requirement | Grantex requirement |
| --- | --- | --- | --- |
| 1. Choose channel | Use ChatGPT, Claude, Gemini, WhatsApp, Telegram, web/mobile, or future approved channel. | Start the correct channel adapter. | Publish approved channel capability metadata. |
| 2. Link or sign in | Connect account if needed. | Create or resume buyer-agent session and bind channel identity. | Avoid exposing private merchant/provider data. |
| 3. Set preferences | Locale, currency, delivery region, notification path, accessibility, optional spend comfort. | Store only safe preferences for conversation and handoff. | Use preferences for policy and consent copy where needed. |
| 4. Understand actions | See browse, compare, draft cart, request checkout, read status, support handoff, blocked actions. | Render channel-specific capability labels. | Return approved capabilities and blocker reasons. |
| 5. Consent when needed | Approve or deny payment-affecting actions. | Never bypass consent or present it as already granted. | Issue scoped Commerce Passport only after consent and policy pass. |
| 6. Manage history | Ask what happened or revoke permission. | Show redacted agent session/evidence status. | Own revocation, protected action history, and audit. |

Buyer setup is not a standing payment approval. Every payment-affecting action
still needs valid consent, policy, revocation, source/freshness, provider-owned
mandate/payment capability, idempotency, and audit evidence. Grantex owns the
policy/artifact evidence rules, not the provider-owned mandate setup itself.

## 8. Regular Agentic Commerce Transaction

```mermaid
sequenceDiagram
  participant B as Buyer
  participant C as Buyer channel
  participant A as AgenticOrg
  participant G as Grantex
  participant S as Merchant system or connector
  participant P as Provider or fintech rail

  B->>C: Ask to discover, compare, or prepare
  C->>A: Start or resume buyer-agent session
  A->>A: Use cached OACP artifacts if TTL and risk allow
  alt cache absent, stale, revoked, or high risk
    A->>G: Refresh or verify signed artifacts
    G-->>A: Public-safe artifacts, TTLs, blocker codes
  end
  A-->>B: Grounded options, source/freshness, caveats
  B->>A: Ask for commitment-bound action
  A->>G: Boundary/envelope/reconciliation/eligibility/dry-run checks
  G-->>A: Non-executing eligibility or blocker result
  A->>S: Request source confirmation through approved connector handoff
  S-->>A: Confirmation evidence or refusal
  A->>P: Verify provider-owned mandate capability when approved
  P-->>A: Provider-owned evidence or refusal
  A-->>B: Prepared handoff, consent request, or safe refusal
```

Plain-English rules:

1. Buyer asks an agent to discover, compare, or prepare.
2. AgenticOrg starts or resumes the buyer session.
3. AgenticOrg reads valid cached OACP artifacts when TTL, revocation, and risk
   rules allow; otherwise it asks Grantex to refresh or verify artifacts.
4. AgenticOrg explains product, price, inventory, policy, and source/freshness
   caveats without inventing facts.
5. Non-binding discovery does not require routing every message through
   Grantex.
6. Commitment-bound actions require C6W5-C6W9 boundary, envelope,
   reconciliation, eligibility, and dry-run checks before any future handoff.
7. Merchant-system confirmation happens through approved seller-agent connector
   handoff or merchant-owned integration systems, not by raw private API calls.
8. Provider-owned mandate and payment capability verification stays with the
   provider/fintech rail; AgenticOrg may verify capability directly where
   approved.
9. Grantex stores only non-sensitive evidence references when needed for policy,
   artifact lineage, or later audit.
10. Current OACP implementation stops before execution. It does not create
    orders, holds, checkout/payment intents, mandates, refunds, returns,
    shipments, settlement, or payout actions.

## 9. Exception And Recovery Flows

| Situation | Buyer experience | Seller experience | Required behavior |
| --- | --- | --- | --- |
| Merchant not approved | Agent says merchant is not available for agentic commerce yet. | Seller sees missing approval state. | Grantex remains fail-closed. |
| Channel is read-only | Buyer can browse and gets safe handoff or unsupported-action copy. | Seller sees channel capability limit. | AgenticOrg cannot pretend write actions are available. |
| Product not found | Agent asks clarifying question or says unavailable. | Seller may see missing catalog coverage. | No guessed products. |
| Product data incomplete | Agent says it cannot verify enough detail. | Seller sees missing required fields. | Readiness score blocks launch or capability. |
| Price changed | Buyer sees updated total and must confirm again. | Seller sees audit and source timestamp. | Grantex invalidates stale cart totals. |
| Inventory stale/unknown | Buyer gets warning or checkout refusal. | Seller sees stale inventory blocker. | No stock or delivery guarantee. |
| Delivery unavailable | Buyer gets no delivery promise. | Seller sees logistics/serviceability blocker. | Checkout blocked if fulfillment proof required. |
| Consent denied/expired | Checkout stops. | Seller sees no payment attempt. | No passport issued or stale passport revoked. |
| Policy denied | Buyer sees safe reason without private policy. | Seller sees blocker code. | Audit written, private policy not leaked. |
| Payment failed/pending | Buyer sees status and next supported step. | Seller sees reconciliation state. | Provider webhook/replay remains Grantex-owned. |
| Order API missing | Buyer cannot get order promise. | Seller sees launch gap. | Broad paid rollout blocked. |
| Refund/return requested | Buyer gets manual support handoff now; future request/status later. | Seller handles in approved system. | No automatic refund execution until separately approved. |
| Settlement/payout question | Buyer usually does not see it; seller sees payout status when available. | Seller sees payout/reconciliation report. | No raw provider payload exposure. |

## 10. Existing Merchant APIs And Systems

Merchants should not rebuild for agents. They should connect the systems they
already run.

| System | Grantex should ingest | Canonical Grantex target | Notes |
| --- | --- | --- | --- |
| Shopify/WooCommerce/Magento/custom storefront | Products, variants, media, collections, availability, pricing. | CommerceProduct, CommerceProductVariant, catalog readiness, schema.org feed. | Start read-only; writeback only after approval. |
| ERP/PIM | Product master, attributes, tax codes, SKU hierarchy, category truth. | Catalog/category/policy mapping. | Merchant declares source-of-truth precedence. |
| Inventory/WMS | Stock state, quantity, location, reservation, confidence, reorder state. | Availability now; future inventory levels/reservations. | Browse can use buckets; checkout needs stronger freshness. |
| OMS | Order creation, order ID, status, cancellation, fulfillment, return status. | Future CommerceOrder and timeline. | Required before broad checkout. |
| Logistics | Delivery promise, shipping price, pickup slot, tracking, failed delivery. | Fulfillment options and tracking events. | Needed for buyer trust and UCP order capability. |
| Payment or mandate provider | Provider-owned mandate capability, payment intent/order, hosted checkout, status webhook, settlement, refunds. | Non-sensitive capability/evidence refs and future provider-neutral status artifacts where approved. | Credentials and mandate setup stay provider/fintech-owned; Grantex does not mediate every payment action. |
| CRM/support | Ticket, support status, return/refund escalation, customer communication. | Support/return/refund request timeline. | Start manual/reference, automate later. |
| CSV/manual/API | Bootstrap catalog, policy, inventory, and approval metadata. | Same canonical objects. | Must include dry-run, validation, history, and rollback. |

Connector rule:

> A connector imports or syncs data. It does not make a merchant live for
> agents. Live agent access requires readiness checks, policy activation,
> consent, human approval, audit, and rollback ownership.

## 11. Buyer Channel Requirements

Buyers should be able to launch from familiar surfaces, but no channel is
launch-ready until its platform-specific constraints and approval gates pass.

| Channel | Intended launch | Required work |
| --- | --- | --- |
| Web/mobile | AgenticOrg-hosted buyer session or merchant-embedded widget. | First controllable launch path, session resume, Grantex merchant selector, consent redirect, analytics attribution. |
| ChatGPT | Remote MCP-backed custom app/package where available. | App manifest, OAuth/account linking, action labels, confirmation copy, app review, fallback to read-only when writes unavailable. |
| Claude | Remote MCP connector. | Endpoint, auth, tool descriptions, least-privilege scopes, test harness, refusal behavior. |
| Gemini | Gemini API/function-calling or hosted wrapper. | Function declarations, tool execution loop, consent handoff, clear label for native support status. |
| WhatsApp | WhatsApp Business Platform bot/webhook adapter. | WABA setup, templates, session window, identity binding, consent link, rate limits, opt-out, human escalation. |
| Telegram | Telegram Bot API adapter. | Bot setup, webhook receiver, secret validation, identity mapping, inline buttons, consent link, rate limits. |
| Other channels | MCP, A2A, REST, webhook, or hosted handoff depending on platform. | Capability matrix, auth, consent, fallback, telemetry, smoke tests. |

Launch-ready acceptance:

- real user starts without developer setup;
- account/channel identity is bound safely;
- merchant discovery comes from Grantex;
- actions are labeled read-only, consent-required, checkout-capable, or blocked;
- OACP artifacts and authority-checked tools preserve refusal semantics;
- consent and checkout copy is clear;
- platform write-action limitations are respected;
- redacted telemetry and audit evidence exist;
- smoke tests and refusal tests pass;
- fallback exists for unsupported actions.

## 12. Standards And Protocol Fit

The strategy is one internal OACP artifact model with protocol views generated
from it. Grantex is the artifact and policy authority; AgenticOrg is the
runtime consumer and channel bridge.

| Surface | Purpose | Requirement |
| --- | --- | --- |
| OACP artifacts | Internal trust and interoperability profile across buyer/seller agents, Grantex policy, merchant systems, and provider rails. | Implemented internally through C6W9; not public, not standardized, not certified. |
| Native Grantex API | First-party authority APIs for canonical artifacts and policy. | Must not be required for every non-binding cached interaction. |
| MCP | Agent tool transport. | Use as one bridge for ChatGPT/Claude-style surfaces; tools consume artifacts and must preserve refusal semantics. |
| UCP-style profile | Capability discovery and shopping capabilities. | Publish only approved merchant/channel capability state. |
| ACP-style checkout | Agentic checkout/session/order/refund shapes. | Map Grantex cart/payment/order state where provider and merchant support it. |
| AP2-style evidence | Signed authorization/mandate evidence for agent payments. | Map provider-owned mandate evidence references and Grantex policy/artifact lineage without claiming AP2 conformance. |
| schema.org | Public product/offer/shipping/return metadata. | Generate public-safe JSON-LD/feed from approved fields only. |
| A2A or future agent surfaces | Agent-to-agent discovery/handoff. | Use only Grantex-approved capability metadata and AgenticOrg channel guardrails. |

Do not claim certified UCP, ACP, AP2, A2A, MPP, schema.org production, or live
provider readiness until implementation, conformance tests, approvals, and
release evidence exist.

### 12.1 IETF And NIST Publication Tracks

The external standards strategy is split into two preparation tracks:

| Track | Intended artifact | Current posture | Required before external submission |
| --- | --- | --- | --- |
| IETF | Individual Internet-Draft candidate for an agentic commerce trust architecture. | C6T internal outline only; not submitted, not adopted, not an RFC, and not a standard. | Public-safe draft text, IPR/legal review, security/privacy considerations, non-Grantex-specific examples, and explicit approval to submit. |
| NIST | Security and risk reference-architecture whitepaper candidate. | C6T internal outline only; not submitted to NIST, not accepted by NCCoE, and not NIST-approved. | Threat model, NIST AI RMF/CSF control mapping, public-safe architecture, collaborator/project path, and explicit approval to engage. |

The IETF track should focus on protocol engineering: roles, message envelopes,
capability profiles, consent, policy, evidence, refusal semantics, and
interoperability with existing protocol surfaces.

The NIST track should focus on risk management: threat model, trust boundaries,
AI RMF mapping, cybersecurity controls, payment-provider boundary controls,
connector governance, audit evidence, privacy, incident response, and rollback.

Both tracks must describe Grantex and AgenticOrg as implementation experience
only. They must not make Grantex-specific APIs mandatory, must not claim
external certification, and must not describe sandbox evidence as production
approval.

## 13. Conceptual Data Model

The implementation should preserve these conceptual records. Some already exist
in V1 form; others are future gaps.

| Record | Owner | Purpose | Current posture |
| --- | --- | --- | --- |
| CommerceTenant | Grantex | Tenant boundary. | Foundation exists. |
| CommerceMerchant | Grantex | Seller identity and policy anchor. | Foundation exists. |
| CommerceCategoryPreset | Grantex | Category-required fields and defaults. | `electronics_appliances` readiness foundation exists. |
| CommerceConnectorSource | Grantex | Existing-system connection and health. | C6N metadata-only registry merged; no credentials or outbound sync. |
| CommerceImportJob | Grantex | Async import, dry-run, errors, rollback. | Gap. |
| CommerceProduct | Grantex | Product truth. | Foundation exists. |
| CommerceProductVariant | Grantex | SKU/variant/price/inventory anchor. | Foundation exists. |
| CommerceInventoryLevel | Grantex | Quantity/location/freshness/reservation. | Gap beyond availability buckets. |
| CommercePrice/Offer | Grantex | Tax, discount, EMI, coupon, offer freshness. | Gap beyond basic price fields. |
| CommercePolicy | Grantex | Merchant permissions and amount caps. | Foundation exists. |
| CommerceConsentRecord | Grantex | Buyer consent record. | Foundation exists. |
| CommercePassport | Grantex | Scoped checkout authorization. | Foundation exists. |
| CommerceCart | Grantex | Cart draft/update/cancel/expire. | Foundation exists; lifecycle gaps remain. |
| CommercePaymentIntent | Grantex | Provider-neutral payment intent. | Foundation exists. |
| CommerceOrder | Grantex | Post-payment order record. | Gap. |
| CommerceFulfillmentEvent | Grantex | Shipment/pickup/delivery status. | Gap. |
| CommerceReturnRequest | Grantex | Return workflow. | Gap. |
| CommerceRefundRequest | Grantex | Refund request and approval. | Gap. |
| CommerceSettlement/Payout | Grantex | Seller payment reporting. | Gap. |
| CommerceAuditEvent | Grantex | Append-only evidence. | Foundation exists. |
| CommerceAgentSession | AgenticOrg/Grantex boundary | Buyer-agent session attribution and channel state. | C6I channel-neutral session orchestration merged; live channels pending. |
| OacpArtifact | Grantex authority, AgenticOrg cache | Signed or signature-ready public-safe artifact scoped to tenant, merchant, seller agent, and buyer agent. | Internal C6W3-C6W9 foundation merged; persistent runtime issuance/cache pending. |
| OacpProtocolAdapterPreview | Grantex authority, AgenticOrg consumer | schema.org/UCP-style/ACP-style/AP2-style/A2A/MCP preview derived from artifacts. | Internal C6W4 foundation merged; public adapter publication pending. |
| OacpPreparedEnvelope | Grantex authority, AgenticOrg consumer | Prepared-only request envelope for buyer/source/merchant/provider confirmation. | Internal C6W6 foundation merged; runtime handoff pending. |
| OacpReconciliation | AgenticOrg local runtime, Grantex rules | Local/cached response-evidence reconciliation result. | Internal C6W7 foundation merged; production persistence pending. |
| OacpEligibilityPacket | AgenticOrg local runtime, Grantex rules | Non-executing eligibility/audit packet. | Internal C6W8 foundation merged; execution controller still absent. |
| OacpDryRunVerification | Grantex rules, AgenticOrg consumer | Contract dry-run over eligibility packet. | Internal C6W9 foundation merged; execution remains blocked. |
| ChannelAdapterConfig | AgenticOrg | Platform launch and capability limits. | Gap. |

## 14. Product Requirements By Surface

| Surface | Requirement | Acceptance |
| --- | --- | --- |
| Merchant dashboard | Checklist, profile, category, systems, readiness score, preview, approvals, rollout, rollback. | Non-engineer can see what is missing and why launch is blocked. |
| Merchant API | Tenant-safe create/read/update for profile, catalog, inventory, policy, connector source, webhook source, readiness. | Every UI action has API equivalent or is explicitly operator-only. |
| Connector framework | Source type, credential reference, sync status, last run, stale state, row errors, retry, disable. | Failed sync cannot silently publish stale facts. |
| Catalog | Product, variant, media, category, price, tax, warranty, return, source, freshness. | Agent answers grounded in exact IDs. |
| Inventory | Availability now; future quantity, location, reservation, confidence, TTL. | Unknown/stale inventory warns or blocks, never guarantees. |
| Cart/checkout | Cart draft/update/cancel, fulfillment option, consent, passport, payment intent, checkout link. | Checkout cannot progress without consent, policy, idempotency, audit. |
| Order | Order reference, status, line items, payment reference, fulfillment status, cancellation, support link. | Paid checkout has an operational record. |
| Returns/refunds | Request, eligibility, manual approval, provider handoff, status, audit. | Execution blocked until separate provider approval. |
| Settlement | Payout/read model, fees, taxes, reconciliation, export. | Seller can answer "when do I get paid?" without raw provider payloads. |
| Protocol adapters | UCP-style, MCP, ACP-style, schema.org, AP2 evidence draft. | Generated from canonical objects with tests and no unsupported claims. |
| Buyer channels | Web/mobile, ChatGPT, Claude, Gemini, WhatsApp, Telegram, future adapters. | Each has launch, auth, consent, fallback, smoke evidence. |
| Audit/ops | Append-only audit, redacted logs, metrics, runbooks, replay, incident severity. | No protected action acknowledged without durable evidence. |
| Security/privacy | Credential isolation, secret redaction, tenant filtering, role checks, webhook signatures, rate limits. | Cross-tenant and secret-exposure tests fail closed. |

## 15. Comprehensive Gap Register

| Gap | Impact | Owner | Fast-track output | Blocker if skipped |
| --- | --- | --- | --- | --- |
| Self-serve merchant signup | Merchants need to join without engineering tickets. | AgenticOrg seller runtime + Grantex authority | AgenticOrg Seller Commerce Agent onboarding, Grantex authority review, roles, category, checklist. | Operator-only onboarding does not scale. |
| Merchant verification | Real merchant identity must be trusted. | Grantex + reviewers | Private evidence refs and review workflow. | No live approval. |
| Existing-system connectors | Merchants will not duplicate data manually. | AgenticOrg seller runtime + merchant/external connector custody + Grantex artifact policy | C6N metadata-only registry exists; real sync adapters and credential-custody flow next. | Stale or manual-only launch. |
| Large catalog imports | Real sellers have many SKUs. | AgenticOrg connector workflow + Grantex validation | Async import, dry-run, row errors, rollback, artifact issuance. | Timeouts and silent data loss. |
| Source-of-truth precedence | Systems can disagree. | Grantex policy + AgenticOrg seller connector workflow | Conflict rules, sync timestamps, and source evidence. | Wrong price/stock/order facts. |
| Inventory depth | Agents must not promise stock incorrectly. | Grantex | Quantity/location/freshness/reservation model. | Unsafe checkout promises. |
| Delivery/pickup | Buyers need fulfillment confidence. | Grantex | Serviceability, slots, fees, ETA, carrier data. | False delivery promises. |
| Pricing/tax/offers/EMI | Agents need correct totals. | Grantex | Fresh price, tax, coupons, discounts, EMI metadata. | Invented discounts or totals. |
| Cart lifecycle | Checkout needs update/cancel/expire. | AgenticOrg runtime handoff + Grantex policy/artifact rules | Cart preparation, recalc evidence, fulfillment selection, expire. | Stale cart risk. |
| Order lifecycle | Payment without order ops is incomplete. | Merchant OMS + AgenticOrg runtime + Grantex artifact policy | Order create/read/status/cancel evidence without making Grantex the default order engine. | Paid launch unsafe. |
| Fulfillment lifecycle | Buyers ask where items are. | Merchant OMS/WMS/logistics + AgenticOrg runtime + Grantex artifact policy | Shipment, pickup, partial fulfillment, failed delivery evidence. | Agent invents delivery. |
| Returns/refunds | Post-purchase trust. | Merchant support/OMS/provider rails + AgenticOrg runtime + Grantex artifact policy | Request, eligibility, manual approval, evidence refs. | Unsafe refund claims. |
| Settlement/payouts | Sellers need money visibility. | Provider/fintech rails + merchant finance + Grantex evidence refs only if needed | Payout/settlement status artifacts without raw provider payloads. | Merchant ops blind spot. |
| Live provider readiness | Payments need approval. | Provider/fintech owner + AgenticOrg verification + Grantex evidence policy | Provider-owned capability verification, non-sensitive evidence refs, rollback rules. | Live provider risk. |
| Commerce Passport production delivery | Real consent needs delivery. | Grantex | Email/SMS/passkey challenge, revocation, signed evidence. | Weak authorization. |
| Policy simulator | Merchants need confidence. | Grantex | Preview policy by product/category/channel/amount. | Accidental capability exposure. |
| OACP and standards adapters | Major platforms need standard surfaces. | Grantex defines artifacts; AgenticOrg consumes and bridges | C6W3-C6W9 internal artifact, adapter, boundary, envelope, reconciliation, eligibility, and dry-run verifier foundations are merged; external publication remains blocked. | Fragmented protocol state or premature external claims. |
| Buyer channel launch | Buyers need easy entry. | AgenticOrg + Grantex approval | C6I channel-neutral response merged; live channel adapters next. | Agentic commerce hard to use. |
| Buyer UX | Buyers need understandable flow. | AgenticOrg | C6I read-only buyer session merged; cart/consent/checkout UX remains future. | Confusing or unsafe agent behavior. |
| Merchant demo UX | Sellers need education. | AgenticOrg | Demo walkthroughs and blocked-path examples. | Misunderstanding production readiness. |
| Evals/regressions | Guardrails must remain true. | AgenticOrg | No invention, no direct-provider, stale/refusal tests. | Regression risk. |
| Ops/support dashboards | Teams need recovery. | Both | Policy denial, stale sync, stuck payment, webhook replay, support handoff. | Incidents are hard to resolve. |
| Analytics/attribution | Sellers need value proof. | Grantex source + AgenticOrg contribution | Channel attribution, conversion, refusal reasons. | No ROI visibility. |
| Docs and workflows | Teams need shared truth. | Both | This consolidated PRD, guides, runbooks, docs nav. | Drift and duplicated plans. |
| CI/deploy safety | Docs-only changes should not deploy. | Both | Path guards and docs-only checks. | Planning merges create cloud/build side effects. |

## 16. Fast-Track Roadmap

| Phase | Goal | Deliverables | Guardrail |
| --- | --- | --- | --- |
| 1. Consolidated PRD and docs alignment | One source of truth. | This PRD, docs nav, overview links, AgenticOrg pointers. Status: merged. | Docs-only. |
| 2. Seller sandbox onboarding | Merchant can prepare without engineers. | AgenticOrg Seller Commerce Agent workflow plus Grantex authority review. Status: planning/docs/runtime foundations exist; full self-serve runtime remains pending. | No live enablement. |
| 3. Catalog connector MVP | Merchant data enters the OACP artifact path. | CSV/manual readiness and C6N connector registry foundation merged; AgenticOrg seller-agent sync initiation and real adapters pending. | No automatic live publish. |
| 4. Public-safe preview | Merchant sees what agents can see. | Catalog/profile preview, schema.org draft, readiness score, and protocol previews merged through C6J-C6M. | Fail-closed until approved. |
| 5. Buyer web/mobile channel | First controllable buyer launch. | C6H and C6I merged for channel-neutral read-only session; hosted widget/app pending. | Read-only first. |
| 6. ChatGPT/Claude MCP | Major AI chat surfaces. | Channel-neutral response model merged; remote MCP/app connector pending. | Respect platform write limits. |
| 7. WhatsApp/Telegram | Messaging channels. | Channel-neutral response model merged; bot/webhook adapters pending. | Secrets outside Git. |
| 8. Gemini channel | Gemini-powered buyer sessions. | Channel-neutral response model merged; function-calling wrapper pending. | Label native support accurately. |
| 9. Inventory freshness and cart | Safe product selection. | Freshness TTL, stale refusal, exact-ID cart draft. | No checkout promise if stale. |
| 10. Sandbox consent/checkout | Full rehearsal. | Consent, Passport, mock/provider-neutral checkout. | No live provider. |
| 11. Order/fulfillment backbone | Operational paid flow. | Order, shipment, pickup/delivery, cancellation. | Required before broad checkout. |
| 12. Return/refund request | Safe post-purchase support. | Request, eligibility, manual approval, audit. | No automatic refund execution. |
| 13. Settlement/payout reporting | Seller finance visibility. | Reconciliation and payout read model. | No raw provider payloads. |
| 14. OACP hardening | Platform interoperability. | C6W3-C6W9 internal artifact, adapter, commitment-boundary, envelope, reconciliation, eligibility, and dry-run verifier foundations are merged. | No submission, publication, certification, or execution claims without explicit approval and evidence. |
| 15. Controlled pilot | Minimal real launch. | One merchant, category, channel, provider, geography, rollback owner. | Separate explicit approval. |

Current sequencing decision:

1. C6I-C6N are merged in dependency order across AgenticOrg and Grantex.
2. The open-protocol packaging draft is refreshed on the actual merged commits
   and remains internal, preview-only, non-publication, and non-certifying.
3. C6O conformance and C6P-C6Si connector dry-run/remediation foundations are
   the current runtime-hardening chain.
4. C6T starts the standards-publication preparation track for IETF and NIST
   without external submission, public publication, or certification claims.

## 17. Release Acceptance Criteria

Before a real merchant pilot:

- Merchant workspace, identity, category, and owners are approved.
- Existing-system connector or approved manual maintenance path is healthy.
- Catalog, price, tax, warranty, return, inventory, delivery, and support data
  pass category requirements.
- AgenticOrg can only expose Grantex-authorized artifact capabilities and
  explicitly approved provider/connector verification states.
- Buyer channel has auth, account/session linking, capability labels, consent
  handoff, fallback behavior, telemetry, and smoke evidence.
- Checkout/payment creation remains blocked until Commerce Passport consent,
  policy, audit, idempotency, provider readiness, and rollback checks pass.
- Paid flow has order, fulfillment, support, and return/refund handoff.
- Live provider approval, webhook signature evidence, outage handling, and
  rollback are complete for any live checkout scope.
- UCP/ACP/AP2/schema.org/A2A language is backed by implementation and tests, or
  clearly marked future/planned.
- Docs-only changes do not trigger cloud auth, image build, image push, deploy,
  e2e, or indexing jobs.
- No private merchant artifacts, secrets, raw payloads, tokens, JWTs, DB/Redis
  URLs, provider credentials, production config values, or concrete allowlist
  values are committed.

## 18. Stop Conditions

Stop implementation or rollout if any of these occur:

- real merchant identity is missing or unapproved;
- private artifacts, customer data, secrets, raw payloads, tokens, JWTs, DB/Redis
  URLs, private keys, provider credentials, or production config values appear
  in Git or public docs;
- AgenticOrg adds a direct provider payment-execution path or unapproved
  private merchant-system execution path. Approved provider capability
  verification and approved connector sync must stay separated from execution;
- checkout can happen without consent, Commerce Passport, policy, idempotency,
  audit, and amount-cap checks;
- catalog, price, tax, inventory, delivery, return, warranty, order, payment,
  or refund data is stale or unverifiable but presented as guaranteed;
- paid checkout is enabled before order, fulfillment, support, return/refund
  handoff, and rollback are ready for the pilot scope;
- synthetic/demo data is treated as production approval;
- public discovery, production Commerce V1, checkout/payment creation, live
  payments, live Plural, or allowlist values are enabled without separate
  approval;
- certification or compliance with UCP, ACP, AP2, A2A, MPP, schema.org, or a
  provider program is claimed before evidence exists;
- docs-only changes trigger cloud build/push/deploy-adjacent work without an
  explicit policy decision.

## 19. Documentation And Workflow Updates

| Surface | Requirement |
| --- | --- |
| This PRD | Canonical cross-repo product truth. |
| Grantex overview | Link to this PRD as the source of truth. |
| Grantex implementation PRD and end-to-end guide | Keep as supporting summaries, not divergent product truth. |
| Grantex docs.json | Keep this PRD discoverable in Agentic Commerce V1 nav. |
| AgenticOrg overview and implementation PRD | Point back to this PRD and preserve AgenticOrg-specific responsibilities. |
| AgenticOrg developer guide | Keep payment-execution bans, channel adapter rules, OACP artifact consumption, and approved provider/connector verifier rules current. |
| Merchant/operator guide | Explain seller one-time setup, approval gates, existing-system connectors, and rollback. |
| Operations guide | Explain stale sync, webhook replay, payment reconciliation, support handoff, rollback, and incidents. |
| Landing pages | Use public-safe copy: connect existing systems, preview agent-ready commerce, request approval. No live/certification claims. |
| GitHub workflows | Preserve docs-only guard and treat workflow changes as non-docs-only. |

## 20. End-To-End Review Checklist

This PRD has been reviewed against the requested coverage:

- seller one-time setup covered;
- buyer one-time setup covered;
- regular transaction flow covered;
- failure and recovery paths covered;
- Grantex and AgenticOrg responsibilities covered;
- existing merchant APIs and systems covered;
- ChatGPT, Claude, Gemini, WhatsApp, Telegram, web/mobile, and future channels
  covered as launch surfaces;
- MCP, UCP-style, ACP-style, AP2-style, schema.org, and future agent surfaces
  covered without unsupported certification claims;
- catalog, inventory, pricing, tax, delivery, order, fulfillment, support,
  return, refund, settlement, payout, audit, analytics, and ops gaps covered;
- self-serve onboarding, scans, review gates, smoke evidence, and rollout gates
  covered;
- safety boundaries, stop conditions, and production gates covered;
- documentation/navigation/workflow coverage covered;
- next implementation sequencing covered.

Remaining decision for the team: continue the C6P-C6Si connector
dry-run/remediation chain for real merchant readiness while C6T prepares
public-safe IETF and NIST draft materials. The next implementation chain should
avoid external submission, public protocol publication, certification claims,
public discovery, and live checkout until explicit approvals and evidence exist.
