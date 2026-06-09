# Commerce V1 Current Product Gap Brutal Analysis

Status: internal product gap analysis only.

Data cutoff: 2026-06-09.

Implementation baseline:

- Grantex `origin/main`: `1c3d99cf449ec7fb1a6feff151d5fd6cd9b28231`
- AgenticOrg `origin/main`: `d02657be67c4be256cd1f0b3d52d46e20c5de891`
- Grantex draft PR #543, `codex/commerce-c6tc-public-safe-example-corpus`, is open and not counted as landed implementation.

This document is not production approval, public discovery approval, checkout/payment approval, live provider approval, public protocol publication, IETF submission, NIST submission, certification, or compliance evidence. It is a blunt gap register for deciding what must be built before the product can be responsibly called live.

## Executive Verdict

The current Agentic Commerce work has a serious foundation, but it is still mostly a sandbox, preview, dry-run, and internal governance product. It is not a live agentic commerce network yet.

What exists is valuable:

- Grantex has the seller control-plane backbone for sandbox merchant onboarding, category/catalog readiness, public-safe preview, review request, operator decision, rollout proposal dry run, AgenticOrg sandbox handoff, connector registry, connector dry-run review, remediation evidence, standards previews, and internal conformance gates.
- AgenticOrg has Grantex-only commerce connector aliases and channel-neutral read-only buyer discovery/session orchestration.
- The architecture correctly keeps merchant systems, payment providers, consent, policy, Commerce Passports, and audit inside Grantex.
- Standards packaging is moving in the right direction: schema.org JSON-LD preview, UCP-style preview, ACP-style preview, AP2-style evidence preview, IETF draft skeleton, and NIST reference-architecture skeleton.

The hard truth:

- A real merchant cannot self-serve all the way to production launch yet.
- A buyer cannot reliably start from ChatGPT, Claude, Gemini, WhatsApp, Telegram, web, or mobile and complete a real agentic purchase yet.
- Existing merchant systems are represented, reviewed, and dry-run tested, but real credentials, outbound sync, scheduled sync, conflict resolution, and production connector execution remain blocked.
- Public discovery is still fail-closed.
- Checkout/payment creation is not approved for production.
- Live Plural/live provider use is blocked.
- Order, fulfillment, returns, refunds, settlement, and payout reporting are not production-ready.
- The open protocol work is internal draft preparation, not a public standard, not an IETF submission, not NIST guidance, and not conformance certification.

In plain English: the product can demonstrate how agentic commerce should work, but it cannot yet safely operate as a live commerce rail for real buyers and real merchants.

## Readiness Snapshot

| Area | Current readiness | Brutal assessment |
| --- | --- | --- |
| Sandbox merchant onboarding | High | Good for controlled sandbox review. Not enough for real merchant launch. |
| Public-safe merchant preview | High | Useful and well-guarded. Still not public publication. |
| Connector registry and dry-run evidence | Medium | Good governance shell. No real sync yet. |
| Real merchant self-serve onboarding | Low to medium | Profile/checklist exists, but KYB/KYC, role model, evidence handling, and production approval are not complete. |
| Read-only public discovery | Medium | Review and dry-run workflow exists. Production enablement remains intentionally blocked. |
| AgenticOrg buyer discovery | Medium | Channel-neutral and Grantex-only foundations exist. Real channel launch is missing. |
| Buyer agent creation from common chat surfaces | Low | No production-grade ChatGPT, Claude, Gemini, WhatsApp, Telegram, web/mobile launch path proven end to end. |
| Catalog APIs | Medium to high | Product/variant foundation exists. Scale, async import, connector sync, and operational quality remain gaps. |
| Inventory | Low to medium | Availability buckets exist. Quantity, reservation, location, SLA, and stock hold semantics are missing. |
| Pricing/offers/tax | Low to medium | Basic price fields exist. Real offer, discount, tax/GST, coupon, EMI, and stale-price controls need hardening. |
| Cart/checkout | Medium | Cart/payment intent foundation exists, but production checkout is still gated. |
| Live payments | Low | Provider-neutral design exists. Live provider approval, credentials, signatures, legal, ops, and settlement are not ready. |
| Order/fulfillment | Low | This is a major missing product pillar. |
| Returns/refunds | Low | Mostly deferred/manual. Cannot support credible post-purchase automation yet. |
| Settlement/payout reporting | Low | Sellers still cannot answer "when do I get paid?" from Grantex. |
| Open protocol publication | Low to medium | Internal drafts and previews exist. Public submission/conformance remains blocked. |
| Production operations | Medium | Audit and guardrails are strong. Live SLOs, incident drills, rollback, support, and real-pilot monitoring need more proof. |

## What Is Actually Implemented

### Grantex

Implemented or substantially present:

- Seller sandbox onboarding foundation.
- Category readiness and catalog readiness checks.
- Public-safe agent-facing preview payload.
- Read-only discovery review request.
- Operator review and decision flow.
- Rollout proposal dry-run.
- AgenticOrg sandbox buyer-discovery handoff.
- Product/variant APIs and catalog read surfaces.
- Cart draft and payment-intent foundations behind guardrails.
- Commerce Passport consent, verification, revocation, and policy concepts.
- Provider-neutral payment abstraction with mock/sandbox posture.
- Merchant webhook source concepts for catalog updates.
- Connector metadata registry and source precedence.
- Connector dry-run, review request, portal review, evidence packet, remediation loop, operator triage, timeline, reconciliation, and closure/gap assessment.
- schema.org JSON-LD preview.
- UCP-style capability profile preview.
- ACP-style cart/checkout shape preview.
- AP2-style evidence preview.
- Preview conformance fixtures, validators, status rendering, CI gate, and release-review runbook.
- IETF and NIST internal draft-preparation materials.

Not implemented as production capability:

- Real public discovery enablement.
- Real merchant approval and live rollout approval.
- Production checkout/payment creation.
- Live Plural/live provider execution.
- Real connector credential entry and outbound sync.
- Production merchant private API calls from Grantex connector workers.
- AgenticOrg public commerce discovery.
- Order, fulfillment, return, refund, settlement, and payout execution.
- Public protocol publication or certification.

### AgenticOrg

Implemented or substantially present:

- Grantex-only commerce connector aliases for merchant profile, catalog search/detail, inventory, cart, consent, payment intent, checkout, and payment status.
- Read-only buyer discovery consumer foundation.
- Channel-neutral buyer session orchestration.
- Refusal behavior for missing consent, disabled merchant/agent, policy denial, stale/unsupported claims, and no direct provider path.
- Guardrail posture that AgenticOrg must call Grantex only for commerce.

Not implemented as production capability:

- Production ChatGPT, Claude, Gemini, WhatsApp, Telegram, web, or mobile channel adapters for launching buyer agents.
- Real buyer account/session linking across those surfaces.
- Channel-specific consent handoff UX.
- Real public discovery from Grantex-approved merchants.
- Write-capable buyer flows beyond guarded Grantex calls.
- Post-purchase order/fulfillment/return/refund/status experiences, because Grantex does not expose production-ready APIs for them yet.

## P0 Gaps Before Any Real Public Pilot

P0 means the product should not launch to real buyers or real merchants without solving it or explicitly approving a constrained exception.

| Gap | Owner | Current state | Why this is a blocker | Required exit criteria |
| --- | --- | --- | --- | --- |
| Real merchant approval path | Grantex | Sandbox/review states exist; real approval remains blocked. | Without real KYB/KYC and approval evidence, any public merchant can be fake, unsafe, or legally unapproved. | Non-secret evidence references, reviewer roles, approval decision, expiry/review cadence, rollback owner, and audit evidence exist for a named merchant. |
| Self-serve seller onboarding to production readiness | Grantex | Seller sandbox workflow exists. | Merchants still cannot go from signup to launch without heavy operator intervention. | Merchant can create workspace, fill profile, connect/import data, view blockers, request review, assign owners, and see exact launch blockers without engineering help. |
| Real connector credential and sync path | Grantex | Metadata registry, dry-run, remediation, and fake/test-data paths exist. | Merchants will not maintain duplicate catalog/inventory/pricing data manually at scale. | At least one approved connector or approved manual maintenance path can sync catalog/price/inventory safely with credential isolation, retries, idempotency, redaction, health, and rollback. |
| Existing-system source-of-truth enforcement | Grantex | Source precedence is modeled, but real sync enforcement is not live. | Conflicting ERP/PIM/POS/OMS data can produce wrong prices, stock, or delivery promises. | Source precedence is stored, enforced, displayed, audited, and used by preview/discovery/checkout decisions. |
| Public discovery production gate | Grantex + AgenticOrg | Fail-closed with review/dry-run evidence. | If enabled prematurely, agents can expose unapproved merchants or stale data. | Real merchant approval, connector health, public-safe payload, rollout owner, rollback plan, allowlist change, AgenticOrg gate, smoke test, and monitoring evidence are complete. |
| Buyer channel launch | AgenticOrg | Channel-neutral model exists. | Buyers do not start from architecture diagrams; they start from chat apps and websites. | At least one real buyer channel, preferably web first, can launch a Grantex-approved read-only buyer session with auth/session linking, labels, refusal behavior, and smoke tests. |
| Channel adapters for ChatGPT, Claude, Gemini, WhatsApp, Telegram | AgenticOrg + platform approvals | Not production-proven. | The core promise is easy agent creation from the surfaces buyers already use. | Each channel has adapter architecture, auth model, tool/capability mapping, consent handoff, limitations, safety labels, rate limits, and golden evals. |
| Real order lifecycle | Grantex | Gap. | Payment without a durable order record is not a commerce product; it is a payment demo. | Order creation, order status, line item snapshot, payment reference, support reference, cancellation policy, audit, and merchant dashboard/API exist. |
| Fulfillment and delivery status | Grantex | Gap. | Buyers ask "when will it arrive?" and agents must not invent delivery. | Fulfillment status, shipment tracking, pickup/delivery method, delivery SLA, serviceability, partial fulfillment, and failure states exist or are explicitly blocked before checkout. |
| Returns and refund request workflow | Grantex | Refund execution and request APIs are deferred. | Post-purchase trust collapses if refunds are manual and invisible. | Return/refund request intake, eligibility preview, manual approval, provider handoff reference, status, and refusal text exist. Execution can remain manually gated. |
| Live payment provider readiness | Grantex | Mock/sandbox/provider-neutral path exists; live remains blocked. | Live payments require legal, provider, security, webhook, reconciliation, and operations readiness. | Plural/live provider approval, credential storage/rotation, webhook signature validation, replay/idempotency, settlement model, incident runbook, and live-mode feature flags are approved. |
| Production consent challenge delivery | Grantex + AgenticOrg | Consent/passport foundation exists. | A consent record is not enough if real users cannot understand and authorize safely in their channel. | Production challenge UX, authentication method, consent copy, expiry, revocation, evidence, and channel-specific fallback are implemented and tested. |
| AgenticOrg direct-call ban regression coverage | AgenticOrg | Guardrails exist. | As new connectors and channels are added, a shortcut can silently bypass Grantex. | Every commerce-capable channel/tool path has tests proving no direct provider call and no direct merchant private API call. |
| Operations and incident response | Both | Audit/guardrail posture is good; live ops proof is incomplete. | Real commerce fails in boring ways: stale stock, provider outage, bad webhook, duplicate payment, support ticket, refund dispute. | Runbooks, dashboards, alerts, SLOs, rollback drills, stuck-payment handling, webhook replay, and support ownership are validated with a real pilot rehearsal. |

## P1 Gaps Before Paid Checkout Pilot

P1 means a limited read-only pilot might proceed without it, but paid checkout should not.

| Gap | Owner | Current state | Brutal risk | Required exit criteria |
| --- | --- | --- | --- | --- |
| Cart update/cancel/expire lifecycle | Grantex | Cart draft exists. | Stale carts and stale prices can create buyer disputes. | Update, remove item, recalc, cancel, expire, stale-price invalidation, and audit are implemented. |
| Fulfillment option selection | Grantex | Not production-ready. | Agents cannot quote shipping, pickup, or delivery. | Fulfillment choices, fees, ETA, serviceability, and stale/unknown handling exist. |
| Quantity/location inventory | Grantex | Availability buckets exist. | "In stock" without quantity/location/reservation can oversell or mislead. | Quantity/location/reservation model or explicit product policy blocks checkout when not available. |
| Stock reservation/hold | Grantex | Gap. | Checkout may pay for unavailable items. | Reservation TTL, release, failure states, and payment linkage exist or checkout remains blocked. |
| Price, tax, GST, discount, coupon, EMI model | Grantex | Basic price fields exist. | Real buyers care about final payable amount; merchants need tax correctness. | Final price calculation, tax/GST metadata, discount/coupon/offer expiry, EMI/payment method constraints, and evidence are implemented. |
| Payment reconciliation and settlement read model | Grantex | Payment status/reconciliation concepts exist. | Seller finance teams cannot operate from raw provider dashboards alone. | Provider-neutral reconciliation, payout/settlement status, fee/tax exports, and mismatch handling exist. |
| Provider webhook chaos handling | Grantex | Webhook intake/replay controls exist conceptually. | Payment status drift is common. | Duplicate/out-of-order/missing webhook tests, replay workflow, dead-letter handling, and operator dashboard exist. |
| Buyer support handoff | Both | Gap. | Agents will be asked about support after purchase. | Support case handoff, merchant support metadata, allowed statements, and refusal fallback exist. |
| Fraud/risk controls | Grantex | Policy engine foundation exists. | Agent-driven commerce creates new abuse patterns. | Velocity limits, suspicious-agent detection, amount/channel caps, merchant disable, and audit reports exist. |
| Buyer identity/account linking | AgenticOrg + Grantex | Channel-neutral but not production-proven. | Consent and order status cannot be bound safely to a real buyer. | Buyer identity linking, privacy limits, channel account binding, revocation, and session expiry are implemented. |

## P2 Gaps Before Broad Productization

P2 means not required for a tiny pilot, but required for durable product-market fit.

| Gap | Owner | Why it matters |
| --- | --- | --- |
| Large async catalog import jobs | Grantex | Real sellers have thousands or millions of SKUs; synchronous CSV/API paths will break. |
| Bulk error UX and rollback | Grantex | Merchants need row-level errors and safe rollback after bad imports. |
| Multi-merchant discovery/ranking | Grantex + AgenticOrg | Buyers will compare merchants; ranking must be policy-safe and auditable. |
| Product matching and deduplication | Grantex | Agent comparison needs canonical products, not just merchant-specific strings. |
| Rich warranty/return policy normalization | Grantex | Agents must not simplify or invent policy terms. |
| Promotion and campaign attribution | Both | Merchants need to measure ROI from agentic channels. |
| Merchant billing for agentic commerce | Grantex | The platform needs pricing, usage, invoices, and dispute handling. |
| Developer portal and SDK polish | Grantex | Merchants and partners need stable APIs, SDKs, examples, and migration notes. |
| Public docs and landing pages | Both | The story must be clear without overclaiming standards or live readiness. |
| External conformance program | Grantex | A protocol claim needs test suites, versioning, change control, and public artifacts. |
| Cross-region/data residency proof | Grantex | India payment mode and production data obligations need evidence. |
| Backup/RPO/RTO proof | Grantex | Commerce records must survive operational failure. |
| Accessibility and localization | Both | Merchant and buyer flows must work for real users, not just engineers. |

## Seller Journey Gaps

### One-Time Seller Setup

The desired seller one-time journey is:

1. Sign up.
2. Create merchant workspace.
3. Enter public merchant profile.
4. Provide private verification evidence outside repo.
5. Connect or upload catalog, price, inventory, warranty, return, tax, and support data.
6. Declare source of truth for each data class.
7. Review public-safe agent preview.
8. Fix blocker list.
9. Assign owners for legal, product, security, ops, rollback, smoke, and evidence retention.
10. Request read-only discovery review.
11. Pass operator review.
12. Pass rollout dry run.
13. Approve AgenticOrg handoff.
14. Enable controlled public discovery for one approved scope.
15. Later request checkout/payment approval.

Current brutal gap:

- Steps 1 to 3 are partly supported for sandbox.
- Steps 4, 6, 9, 14, and 15 are still not production-grade.
- Step 5 is dry-run/review/remediation oriented; real connector sync is not live.
- Steps 10 to 13 exist as sandbox-only governance, not production launch.

### Regular Seller Operations

The desired recurring seller operation is:

1. Keep catalog current from existing systems.
2. Keep price/tax/offer current.
3. Keep inventory and delivery availability current.
4. Monitor agent-facing preview.
5. Review refusals and buyer questions.
6. Handle orders and fulfillment.
7. Handle returns/refunds/support.
8. Reconcile payment and payout.
9. Disable merchant/capability quickly during incidents.

Current brutal gap:

- Catalog/currentness is partly handled, but real sync is not implemented.
- Inventory is too shallow for paid commerce.
- Order/fulfillment/returns/refunds/settlement are major product holes.
- Incident controls exist conceptually, but real operational drills and dashboards need expansion.

## Buyer Journey Gaps

### One-Time Buyer Setup

The desired buyer one-time journey is:

1. Open a familiar interface: ChatGPT, Claude, Gemini, WhatsApp, Telegram, web, or mobile.
2. Start or select a buyer agent.
3. Link account/session safely.
4. Understand what the agent can and cannot do.
5. Set default consent preferences or spending guardrails.
6. Revoke or inspect authorizations.

Current brutal gap:

- AgenticOrg has a channel-neutral session model, but the actual channel launch paths are not production-proven.
- Buyer account/session linking is not proven across the named surfaces.
- Consent UX is not yet channel-specific.
- There is no clear production self-serve flow where a non-technical buyer creates a commerce-capable buyer agent from each major chat interface.

### Regular Buyer Transaction

The desired regular transaction is:

1. Buyer asks an agent for a product.
2. Agent discovers only approved merchants and approved public-safe catalog data.
3. Agent compares grounded product facts.
4. Agent checks availability, freshness, price, warranty, return policy, shipping/pickup, and final payable amount.
5. Agent creates a cart draft.
6. Buyer reviews merchant, items, price, delivery, policy, spending limit, and expiry.
7. Grantex issues Commerce Passport after consent.
8. Agent requests checkout/payment through Grantex only.
9. Provider handles payment authentication.
10. Grantex records payment status and creates/updates order.
11. Agent reports order/fulfillment/refund/support status only from Grantex.

Current brutal gap:

- Steps 1 to 3 are partially available in read-only/sandbox form.
- Step 4 is not reliable enough because inventory, fulfillment, and final-price evidence are incomplete.
- Steps 5 to 9 have foundations but are not production-enabled.
- Steps 10 to 11 are materially incomplete because order/fulfillment/refund/support APIs are missing or deferred.

## Existing Merchant Systems Gap

The product thesis says merchants should use their existing systems. Today that is only partially true.

Supported today:

- Metadata-only connector registry.
- Source precedence documentation and state.
- Dry-run with test doubles.
- Review request and operator decision.
- Remediation, triage, follow-up, closure, and evidence exports.
- Guardrail that AgenticOrg cannot call merchant private APIs directly.

Missing:

- Credential intake and storage for real merchant connectors.
- Connector-specific adapters for Shopify, WooCommerce, Magento, custom ERP/PIM/POS/OMS/WMS/logistics/support systems.
- Scheduled sync jobs.
- Webhook subscriptions to merchant systems.
- Retry, backoff, idempotency, quarantine, and dead-letter behavior for real connector calls.
- Data mapping UI for non-engineers.
- Conflict resolution UI and APIs.
- Rollback to previous import/sync snapshot.
- Connector health score that gates public discovery and checkout.
- Production-safe logs that prove no raw payload or credential leakage.

Brutal conclusion: the connector governance shell is good, but the product does not yet let a normal merchant plug in their real stack and go live without engineering involvement.

## Protocol And Standards Gap

The strategic idea is sound: Grantex should expose one canonical agentic commerce protocol and adapt outward to schema.org, UCP-style profiles, ACP-style checkout shapes, AP2-style evidence, MCP/native APIs, and future channels.

What exists:

- Internal preview adapters.
- Internal conformance fixtures and validator.
- Internal report/status/gate/runbook.
- Internal IETF skeleton.
- Internal NIST reference architecture skeleton.

What is missing:

- Public protocol specification with stable versioning.
- Public JSON schemas.
- Public example corpus that contains no private or production-sensitive data.
- Public conformance test suite.
- Public compatibility matrix for schema.org, UCP, ACP, AP2, MCP, A2A, and merchant connector metadata.
- Change control, deprecation policy, security considerations, privacy considerations, and IANA or registry posture if pursuing IETF.
- NIST/NCCoE engagement package, mapping to AI RMF/CSF/privacy controls, and public-comment strategy.
- Legal approval to publish.
- External review from merchants, agent platforms, payment partners, and standards people.
- Independent conformance or certification basis before making any claim.

Brutal conclusion: it can become an Open Agentic Commerce Protocol, but today it is an internal draft and implementation experience package. Calling it a standard now would be overclaiming.

## Grantex Gaps By Product Surface

| Surface | Gap | Severity |
| --- | --- | --- |
| Merchant workspace | Production KYB/KYC, role assignment, approval expiry, and private evidence reference model need hardening. | P0 |
| Merchant dashboard | Needs non-engineer self-serve flow from setup to launch blockers, not just operator/admin pathways. | P0 |
| Catalog | Large import jobs, rollback, async status, and field mapping are missing. | P1 |
| Inventory | Quantity, location, reservation, hold, and fulfillment serviceability are missing. | P0/P1 |
| Pricing | Final payable price, tax/GST, offers, coupons, EMI, and stale-price policy need hardening. | P1 |
| Connector framework | Real credentials, outbound sync, schedules, retries, source conflicts, and adapter implementations are missing. | P0 |
| Public discovery | Production enablement and allowlist workflow remain blocked. | P0 |
| Cart | Update/cancel/expire and fulfillment selection are incomplete. | P1 |
| Consent/passport | Production channel challenge, signed evidence, and channel-specific UX are incomplete. | P0/P1 |
| Payment provider | Live provider contracts, credentials, webhook proof, reconciliation, and legal approval are missing. | P0 |
| Order | No production order lifecycle. | P0 |
| Fulfillment | No production fulfillment/shipping/pickup lifecycle. | P0 |
| Return/refund | Request workflow, eligibility, approval, and provider handoff are missing. | P0/P1 |
| Settlement/payout | Seller finance reporting is missing. | P1 |
| Ops | Stuck-payment, stale-sync, webhook, rollback, incident, and support dashboards need production proof. | P0/P1 |
| Analytics | Merchant ROI and buyer funnel attribution are missing. | P2 |
| Public docs | Must explain capabilities without implying live/certified status. | P1 |

## AgenticOrg Gaps By Product Surface

| Surface | Gap | Severity |
| --- | --- | --- |
| Buyer agent creation | Users cannot yet create/launch commerce buyer agents from every target channel without friction. | P0 |
| ChatGPT channel | No production-ready connector/action/MCP/app flow proven for buyer commerce. | P0 |
| Claude channel | No production-ready MCP/desktop/web flow proven for buyer commerce. | P0 |
| Gemini channel | No production-ready Gemini/function-calling flow proven for buyer commerce. | P0 |
| WhatsApp channel | No production-ready bot/webhook/session/consent flow proven. | P0 |
| Telegram channel | No production-ready bot/session/consent flow proven. | P0 |
| Web/mobile channel | A controlled first-party buyer experience is still needed as the lowest-risk launch surface. | P0 |
| Session linking | Buyer identity, session continuity, consent binding, and revocation across channels need proof. | P0 |
| Capability labels | Each channel must show what the agent can/cannot do in plain language. | P1 |
| Refusal UX | Refusals exist, but channel-specific UX and copy need evaluation. | P1 |
| Checkout UX | Write-capable checkout/payment UX remains blocked until Grantex is ready. | P0 |
| Post-purchase UX | Order, fulfillment, support, return, refund, settlement states wait on Grantex APIs. | P1 |
| Evals | Need channel-specific golden tests and no-invention tests for every new capability. | P0/P1 |

## Documentation And Workflow Gaps

The docs are stronger than the product in several places. That is useful for planning, but dangerous if the docs sound like launch readiness.

Needed documentation hardening:

- Keep one canonical PRD status table current after every C6 slice.
- Add a public/merchant-facing "what is sandbox vs live" page before any merchant demo.
- Add a buyer-facing "what agents can and cannot do" page before any buyer demo.
- Add connector setup guides only after real connector execution exists.
- Add order/fulfillment/refund docs only when APIs exist or clearly label them future.
- Add protocol docs only as draft/internal until publication approval.
- Add docs.json or landing-page links only for safe public content.
- Keep internal-only gap, standards, and guardrail docs out of public marketing claims.

## No-Go Conditions

Do not go live if any of these are true:

- The merchant is synthetic, demo-only, unverified, or missing approval evidence.
- Public discovery is enabled without a named approved merchant, approved payload, rollback owner, and smoke evidence.
- AgenticOrg can see or execute a capability not approved by Grantex.
- AgenticOrg calls a payment provider or merchant private API directly.
- Catalog, price, tax, inventory, delivery, warranty, return, or payment status is stale or unverifiable but presented as guaranteed.
- Checkout/payment is enabled before order, fulfillment, support, return/refund handoff, and ops runbooks exist.
- Live payment provider credentials or webhook paths are used without partner/legal/security approval.
- A channel launches without buyer identity/session/consent/revocation proof.
- A standards/protocol page claims IETF, NIST, UCP, ACP, AP2, schema.org, A2A, MPP, provider, or certification status without external basis.
- Secrets, raw payloads, private merchant details, production allowlists, or provider credentials enter the repo.

## Fast-Track Recommendation

Do not jump straight to live payments. The fastest credible route is a narrow read-only pilot, then a sandbox checkout pilot, then a paid pilot.

### Track 1 - Finish The Current Standards/Protocol Prep Without Overclaiming

1. Review and merge C6Tc public-safe example corpus if clean.
2. Add public-safe protocol manifest and schema draft only after examples are clean.
3. Keep IETF/NIST work internal until legal/product/security approve external submission.
4. Create a public conformance package only after the internal validator is stable and examples are safe.

### Track 2 - Real Merchant Read-Only Pilot

1. Choose one real merchant and one category.
2. Create a private approval packet outside repo.
3. Add repo-safe approval references only.
4. Prove one data path: approved manual CSV maintenance or one real connector dry-run.
5. Resolve connector stale/conflict blockers.
6. Approve public-safe merchant preview.
7. Enable only read-only discovery for one merchant through an allowlist change in a separate approved task.
8. Run AgenticOrg read-only buyer smoke through one controlled channel.

### Track 3 - First Buyer Channel

1. Build web/mobile buyer channel first because it is easiest to control.
2. Add ChatGPT/Claude/Gemini/WhatsApp/Telegram only after the first-party channel has stable session, consent, labels, and refusals.
3. For every channel, prove: launch, identity/session, Grantex-only calls, capability labels, stale-data refusal, no direct provider call, no direct merchant API call, and audit linkage.

### Track 4 - Checkout/Payment Sandbox

1. Complete cart update/cancel/expire and stale-price handling.
2. Add order record before payment pilot.
3. Add fulfillment/support/return-refund handoff before paid pilot.
4. Validate Plural sandbox credentials, webhook signatures, replay, reconciliation, and failure handling.
5. Keep live payments blocked until partner/legal/security/ops approval.

### Track 5 - Existing Merchant Systems

1. Implement first real connector in sandbox only.
2. Add credential references, not credential values, with vault integration.
3. Add scheduled dry-run sync and row-level mapping.
4. Add conflict resolution and rollback.
5. Promote to production only after a real merchant's data owners approve source-of-truth behavior.

## Suggested Next Implementation Slices

The next slices should be ordered to remove the largest live blockers, not to add more demos.

1. C6Tc readiness and merge: public-safe standards example corpus.
2. C6U real merchant pilot readiness packet: private evidence references, owners, approval states, launch blockers, and no live enablement.
3. C6V real connector credential-reference design: vault-backed references, no raw secrets, no outbound sync yet.
4. C6W first real connector sandbox dry-run: one connector, one merchant, one category, no public discovery.
5. C6X read-only public discovery allowlist proposal: named merchant only, docs plus guarded config proposal, no automatic enablement.
6. C6Y AgenticOrg first-party web buyer channel smoke: read-only, Grantex-only, no checkout.
7. C6Z channel adapter matrix: ChatGPT, Claude, Gemini, WhatsApp, Telegram with exact launch constraints and tests.
8. C7A order backbone foundation: order record, status, audit, dashboard/API.
9. C7B fulfillment/status foundation: delivery/pickup/shipment status, serviceability, and refusal behavior.
10. C7C return/refund request foundation: request, eligibility, manual approval, status, audit, no auto-refund execution.
11. C7D sandbox checkout E2E: consent, passport, cart, payment intent, provider sandbox, order, fulfillment handoff, support fallback.
12. C7E live provider readiness review: legal/security/provider/ops approval, not automatic enablement.

## Second-Pass Brutal Addendum

The first pass correctly identified the obvious product gaps. The second pass adds the gaps that usually get missed because they are not a shiny feature, but they are exactly what breaks real launches.

### Hidden P0 Gaps

| Gap | Owner | Why it is P0 | Required exit criteria |
| --- | --- | --- | --- |
| Contract versioning and compatibility | Grantex + AgenticOrg | If OpenAPI, MCP schemas, SDKs, AgenticOrg connector aliases, and protocol previews drift, agents will break or misread merchant state. | Versioned commerce contracts, compatibility matrix, generated SDK/API parity checks, deprecation policy, and cross-repo contract tests. |
| Public claim governance | Grantex + AgenticOrg | A landing page or docs page can accidentally claim "live", "certified", or "standard" before the product is ready. | Claim audit across `README`, `web/**`, docs nav, docs guides, case studies, OpenAPI descriptions, launch posts, and AgenticOrg docs before any public push. |
| Docs/navigation completeness | Grantex | Internal docs can exist but be invisible to real operators and developers. | Public-safe docs are linked in the correct nav; internal-only docs stay internal; docs.json/mint-style nav or equivalent docs index is updated when pages become public. |
| Grantex docs-only CI guard | Grantex | Previous Grantex merges automatically started deploy workflows. That may be acceptable for code, but it is noisy and unsafe for docs-only planning. | Path-based workflow guards or admin policy so docs-only/internal planning changes do not trigger cloud deploy/build unless explicitly approved. |
| Environment and flag governance | Grantex + AgenticOrg | One bad environment flag can bypass months of safety gates. | Change-control checklist for `COMMERCE_V1_ENABLED`, public discovery, allowlists, live mode, reconciliation worker, provider keys, AgenticOrg discovery flags, and channel adapters. |
| Merchant/operator RBAC | Grantex | Sandbox workflows are powerful; wrong roles can approve, disable, or expose merchants incorrectly. | Explicit roles for submitter, merchant owner, operator reviewer, security reviewer, legal reviewer, ops owner, rollback owner, and read-only auditor with tests. |
| Real tenant identity and account lifecycle | Grantex | Test tenants are not real merchant organizations. | Tenant creation, owner verification, role invitation, offboarding, disabled tenant behavior, and cross-tenant isolation proven in production-like tests. |
| Evidence lifecycle | Grantex | Approval references and audit evidence become stale, expire, or become legally sensitive. | Evidence retention policy, expiry/re-review, redacted export, immutable audit, deletion/hold rules, and reviewer revalidation cadence. |
| Data residency and regulated data boundary | Grantex | India live payments require data residency and payment-data handling proof. | Region architecture, data classification, storage location evidence, backup location proof, logging redaction, and legal signoff before live payment mode. |
| Dependency/security backlog | Both | A product cannot claim production hardness while known dependency/security issues are ignored. | Dependency review, security scan triage, vulnerability acceptance/patch plan, and no critical unowned dependency risk before launch. |
| Staging/live parity | Both | A green sandbox can still fail in production because auth, URLs, secrets, regions, CORS, callbacks, and webhooks differ. | Staging environment that mirrors production enough for full read-only and sandbox checkout smoke, with no synthetic shortcut hidden in config. |
| Real rollback drill | Both | "We can turn it off" is not a rollback plan. | Timed rollback rehearsal for public discovery, AgenticOrg channel exposure, connector sync, payment provider errors, bad catalog import, and stale inventory. |

### Underweighted Product Gaps

| Area | Current risk | Brutal detail |
| --- | --- | --- |
| Category expansion | `electronics_appliances` has readiness logic, but real commerce needs category-specific fields. | Food, fashion, pharmacy, services, subscriptions, digital goods, regulated products, and high-value goods need different warranty, return, safety, tax, inventory, and delivery rules. |
| Product content safety | Merchant catalog text can be prompt-injection or policy-bypass content. | Product descriptions, warranty copy, support text, and connector rows must be scanned/sanitized before becoming agent-visible context. |
| Merchant content moderation | Public discovery can surface prohibited or sensitive products. | Need category policy, restricted goods handling, age-gated items, counterfeit claims, medical/financial/legal claims, and takedown process. |
| Search/ranking fairness | AgenticOrg discovery can influence merchant revenue. | Need explainable ranking, sponsored-result separation if ads ever exist, deterministic fallback, and no hidden merchant favoritism without disclosure. |
| Multi-merchant comparison | Current work is merchant-centric. | Buyers will ask "best option"; cross-merchant compare needs normalized product facts, price freshness, delivery, return policy, and anti-invention guardrails. |
| Final price truth | Basic price is not final payable amount. | Taxes, fees, shipping, COD charges, discounts, coupons, EMI, payment-method surcharges, and region-specific charges must be grounded before checkout. |
| Delivery promise truth | Delivery is currently a gap, not just an extra feature. | Discovery can show products, but checkout should not proceed unless delivery/serviceability evidence is explicit or the UX says delivery is unknown and checkout is blocked. |
| Warranty/return policy normalization | Summaries are not enough for dispute-prone categories. | Need canonical policy fields, source reference, date/version, exceptions, region, product-category applicability, and refusal behavior when ambiguous. |
| Support escalation | Agentic commerce needs human fallback. | Buyer and merchant need support ticket handoff, ownership, SLA, allowed language, privacy-safe transcript, and no automated promise beyond source data. |
| Fraud and abuse | Agentic buying changes fraud surface. | Need velocity limits, merchant risk holds, buyer identity checks, suspicious agent behavior, repeated failed payments, bot/channel abuse, and audit alerts. |
| Consent fatigue and dark patterns | Buyer consent copy can become rubber-stamp UX. | Need readable consent, amount/currency/merchant/channel/item clarity, expiry, revocation, no pre-checked approvals, and localized copy. |
| Accessibility and localization | Real users are not all English-speaking developers. | Merchant dashboard and buyer consent need accessibility, mobile layout, local language support, timezone/currency formatting, and screen-reader-safe status labels. |
| Offline and intermittent channels | WhatsApp/Telegram/mobile may be asynchronous. | Consent expiry, cart expiry, payment pending state, and user response timing need channel-specific handling. |
| Privacy and transcript retention | Buyer-agent conversations can contain personal data. | Need transcript minimization, retention period, redaction, export/delete policy, and support-safe evidence references. |
| Metering and commercial model | Running commerce costs money and creates value. | Need merchant billing/usage, per-channel attribution, transaction or discovery metrics, refund of platform fees, and invoice/reporting posture. |

### Cross-Repo Integration Gaps

| Integration point | Current state | Missing proof |
| --- | --- | --- |
| AgenticOrg agent creation | Agent creation and Grantex registration paths exist broadly, but commerce-specific buyer-agent creation is not a polished self-serve flow. | Non-technical buyer can create/select a commerce buyer agent, link session, and start read-only shopping from each target channel. |
| AgenticOrg commerce tools | Grantex-only aliases exist. | Cross-repo tests prove every alias maps to current Grantex contracts and fails closed on schema mismatch. |
| AgenticOrg public discovery gate | Fail-closed. | Real approved merchant handoff from Grantex flips only the intended read-only capability in AgenticOrg, with no write/payment/provider capability exposed. |
| A2A/MCP/external discovery | AgenticOrg has A2A-style discovery surfaces. | Commerce agent card/tool metadata must reflect Grantex-approved commerce capabilities, not generic AgenticOrg capabilities. |
| Channel-specific tool limits | Not fully proven. | ChatGPT/Claude/Gemini/WhatsApp/Telegram each need exact tool availability, auth, rate limits, consent UX, refusal copy, and smoke tests. |
| Error translation | Guardrails normalize some Grantex errors. | Buyer-facing responses must preserve safety and not leak raw Grantex/provider/merchant details. |
| Session and revocation propagation | Foundations exist. | Revoking a consent/passport/merchant/channel must take effect across active AgenticOrg sessions without stale cache exposure. |
| Cross-repo release ordering | Many slices were stacked and merged carefully. | A permanent release checklist is needed so AgenticOrg never consumes a capability before Grantex has published and approved it. |

### API, SDK, And Developer Experience Gaps

| Gap | Risk | Required outcome |
| --- | --- | --- |
| OpenAPI vs implementation drift | Developers integrate against stale docs. | CI validates implemented route surface, OpenAPI, examples, and portal API clients together. |
| SDK coverage for commerce | Merchant developers need SDK methods, not raw HTTP. | TypeScript SDK, Python SDK, and examples cover merchant profile, catalog, inventory, connector dry-run, review, consent/passport, cart, payment status, and future order APIs. |
| Idempotency guide | Payment and connector retries can duplicate actions. | Public-safe idempotency docs, examples, error codes, retry windows, and replay behavior for every state-changing endpoint. |
| Rate-limit contract | Channels and merchants need predictable throttling. | Per-role rate limits documented for merchant API, agent API, public discovery, connector dry-runs, consent, cart, checkout, and payment. |
| Error taxonomy | Agents need machine-actionable refusals. | Stable error codes with retryability, remediation text, user-safe message, and internal support code. |
| Example data policy | Examples can accidentally become production-looking. | Synthetic-only example policy, scanner, and test fixture rules for every example corpus. |
| Developer sandbox | Merchants need safe experimentation. | Seeded sandbox tenant, fake connector, mock payment, buyer-agent simulator, and reset workflow without production flags. |

### Operations, Reliability, And Support Gaps

| Gap | Why it matters | Exit criteria |
| --- | --- | --- |
| SLOs and SLIs | Commerce needs measurable reliability. | Availability, latency, error rate, stale-data rate, payment-pending age, webhook lag, connector sync lag, and refusal-rate metrics are defined. |
| Alert routing | Metrics without humans are decoration. | Alerts map to owners and runbooks for provider outage, stale catalog, public discovery failure, consent failure, audit write failure, and AgenticOrg channel outage. |
| Audit write failure handling | Protected actions cannot silently proceed without audit. | Tests prove payment-affecting actions fail closed if required audit evidence cannot be written. |
| Backup and restore | Commerce records need durable recovery. | Restore drill for commerce tenant, merchant, catalog, policy, consent, passport, cart, payment, audit, connector evidence, and config state. |
| Migration rollback | Commerce schemas are growing quickly. | Every migration has rollback/forward-fix notes and production backfill safety plan. |
| Stale cache handling | Agents may use cached catalog or passport state. | Cache TTLs, revocation invalidation, and stale-read labels are tested across Grantex and AgenticOrg. |
| Incident communications | Merchants and buyers need timely truth. | Status templates, merchant notifications, buyer-safe outage/refusal messages, and support escalation are ready. |
| Post-merge deploy controls | Main merges can trigger workflows. | Deploy jobs are either intentionally approved or path-guarded; docs-only analysis must not accidentally ship infrastructure. |

### Legal, Compliance, And Trust Gaps

| Gap | Brutal assessment |
| --- | --- |
| Payment legal approval | Live payment mode needs partner, legal, AFA, consent, chargeback, refund, settlement, and data-residency approval. |
| Merchant terms | Sellers need terms covering agent visibility, catalog accuracy, pricing accuracy, fulfillment responsibility, returns, support, and data sharing. |
| Buyer terms | Buyers need terms explaining agent limitations, consent, payment handoff, data use, refunds, and support. |
| Privacy policy updates | Agentic commerce changes data categories: buyer intent, cart content, consent, agent transcript, payment references, merchant catalog exposure. |
| DPDP/privacy operations | Data access, deletion, correction, retention, and grievance processes need commerce-specific handling. |
| Standards/IP posture | Publishing an open protocol needs license, contribution, patent/IP, governance, and trademark posture. |
| Regulated categories | Pharmacy, financial products, alcohol, age-restricted goods, medical claims, and high-risk products need explicit exclusion or controls. |
| Tax/GST obligations | Tax display, invoices, merchant responsibility, and jurisdiction-specific disclaimers need legal/accounting review. |

### Standards And Open Protocol Reality Check

The architecture can evolve into an open protocol, but a protocol people can rely on needs more than adapter previews.

Missing protocol work:

- Normative language split from implementation examples.
- Stable core object model independent of Grantex table names.
- Canonical JSON schemas for merchant, capability, catalog item, offer, inventory, cart, consent, mandate evidence, order, fulfillment, return/refund, settlement, connector source, and audit reference.
- Version negotiation and backward compatibility.
- Threat model and security considerations written for third-party implementers, not just Grantex/AgenticOrg.
- Privacy considerations with data minimization and transcript handling.
- Registry story for capability names, error codes, evidence types, connector types, and refusal reasons.
- Test vectors with no real merchant data.
- Reference implementation boundaries: Grantex and AgenticOrg as examples, not required participants.
- Conformance levels: read-only discovery, cart draft, consent/passport, checkout handoff, order status, refund request, settlement report.
- Adapter mapping tables to schema.org, UCP-style, ACP-style, AP2-style, MCP, A2A, and merchant connector metadata.
- Independent interoperability tests against at least one non-Grantex mock implementation before any serious public claim.

Brutal conclusion: do not pitch this as "ignore UCP/ACP/AP2/schema.org" yet. The credible pitch is: "Use one canonical agentic commerce trust architecture with adapters to existing surfaces." The "you do not need to worry about other protocols" claim becomes safe only after adapters are complete, tested, versioned, and externally reviewed.

### Launch Stages That Should Not Be Collapsed

| Stage | What can be true | What must stay false |
| --- | --- | --- |
| Internal sandbox | Synthetic/demo merchant and fake connector data exercise workflows. | No real merchant approval, no public discovery, no live payment. |
| Real merchant private readiness | A named merchant provides private approval evidence and repo-safe references. | Still no public discovery or checkout unless separately approved. |
| Read-only public pilot | One approved merchant is visible through one approved read-only channel. | No cart/checkout/payment, no delivery guarantee, no standards certification claim. |
| Sandbox checkout pilot | Buyer can exercise cart, consent, passport, mock/sandbox provider, order handoff. | No live money movement, no live provider, no production settlement. |
| Paid limited pilot | One merchant, one geography, one provider, one channel, small caps, support staffed. | No broad merchant onboarding, no autonomous delegated payments, no unreviewed channel expansion. |
| Broader launch | Repeatable merchant onboarding, connectors, order/fulfillment/refund/settlement, ops, docs, and compliance exist. | No unsupported category/channel/provider claims. |

### What Must Be Audited Before Any Next "Go Live" Claim

1. Public web pages and landing pages.
2. README and marketplace/package pages.
3. Docs navigation and public docs index.
4. OpenAPI descriptions and examples.
5. SDK examples and generated docs.
6. AgenticOrg UI copy and agent templates.
7. AgenticOrg A2A/MCP public discovery metadata.
8. Commerce demo fixtures and example corpora.
9. CI/deploy workflow path filters.
10. Environment variable examples and deployment docs.
11. Compliance/privacy/terms pages.
12. Release notes and launch posts.

The audit must prove the words match the product state. If the product is sandbox-only, every public surface must say so or avoid the claim entirely.

### Stronger Fast-Track Order

The previous fast-track list was reasonable but still too broad. A more disciplined sequence is:

1. Merge C6Tc only after confirming public-safe examples do not imply publication or certification.
2. Add this gap analysis to the PRD status section or link it from the internal Commerce V1 docs index.
3. Add Grantex docs-only CI/deploy guard so future planning docs do not trigger deploy-adjacent workflows.
4. Build contract parity checks between Grantex OpenAPI, portal client, MCP tool schemas, SDKs, and AgenticOrg aliases.
5. Build real merchant readiness packet with private evidence references and reviewer RBAC, still no public discovery.
6. Build first real connector credential-reference design with vault-only references, still no outbound sync.
7. Build first real connector sandbox dry-run against a merchant-approved non-production source.
8. Build first-party web buyer channel read-only smoke before attempting ChatGPT/Claude/Gemini/WhatsApp/Telegram.
9. Build order foundation before any paid checkout pilot.
10. Build fulfillment/support/return-refund handoff before live payment pilot.
11. Build sandbox checkout E2E with order handoff and rollback drill.
12. Only then ask for live provider readiness review.

### Things That Would Be Reckless To Fast-Track

- Scraping a "test merchant from web" and treating it as real approval.
- Turning on public discovery for demo/synthetic merchant IDs.
- Letting AgenticOrg call merchant private APIs directly "just for testing".
- Using live provider credentials before legal/provider/security approval.
- Launching checkout without order/fulfillment/support/return-refund handoff.
- Publishing standards pages that imply IETF/NIST/UCP/ACP/AP2/schema.org certification.
- Adding a channel adapter without channel-specific consent and refusal tests.
- Assuming a green CI run proves live readiness.
- Assuming a docs walkthrough is an operational runbook.
- Assuming mock payment success means payment operations are ready.

## Bottom Line

The architecture is directionally right. Grantex as seller control plane and AgenticOrg as buyer-agent layer is the right split. The protocol-adapter strategy is also right: one canonical Grantex commerce model, adapters to schema.org, UCP-style, ACP-style, AP2-style, MCP/native API, and future agent channels.

But the product is not live-ready. The current implementation is strongest at safety, preview, and governance; weakest at real merchant integration, buyer channels, post-purchase commerce, and live payment operations.

The fastest path is not "remove all blockers." The fastest safe path is to convert blockers into narrow, approved, evidence-backed gates:

- first real merchant;
- first real data source;
- first read-only public discovery;
- first buyer channel;
- first sandbox checkout;
- first order/fulfillment handoff;
- then, and only then, a paid live pilot.
