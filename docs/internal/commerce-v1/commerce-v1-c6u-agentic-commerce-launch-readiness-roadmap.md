# Commerce V1 C6U Agentic Commerce Launch Readiness Roadmap

Status: internal planning roadmap only.

Data cutoff: 2026-06-09.

Source baseline:

- Grantex PR #544 merged at `710b0cb327e1c2992c3750a638c9b8ff5ab55e1c`.
- Baseline gap file: `docs/internal/commerce-v1/commerce-v1-current-product-gap-brutal-analysis.md`.
- AgenticOrg baseline: `origin/main` at `d02657be67c4be256cd1f0b3d52d46e20c5de891`.

This roadmap is not production approval, real merchant approval, public discovery approval, checkout/payment approval, live provider approval, live Plural approval, production allowlist approval, protocol publication, external standards submission, certification, conformance evidence, compliance evidence, or a production-ready claim. It approves no real merchant, public discovery, checkout/payment, live provider, live Plural, production config, allowlist, cloud resource, provider call, merchant private API call, protocol publication, external submission, certification, compliance, conformance, standardization, or production launch.

## Executive Summary

The merged brutal gap analysis is now converted into an executable launch-readiness roadmap. The safe path is not to remove every blocker at once. The safe path is to turn each blocker into a narrow implementation slice with an owner, dependency chain, acceptance criteria, validation gates, and stop conditions.

The current product remains strongest at internal preview, governance, connector dry-run evidence, public-safe examples, and standards preparation. It remains weakest at real merchant integration, buyer channel launch, post-purchase commerce, live payment operations, and external protocol readiness.

The roadmap sequence is:

1. Harden internal planning and release controls.
2. Prove contract parity across Grantex APIs, MCP tools, SDKs, portal clients, and AgenticOrg aliases.
3. Build real merchant readiness packets without public discovery.
4. Build credential-reference and connector sandbox dry-run paths without production sync.
5. Launch a first-party web read-only buyer channel before chat platform adapters.
6. Build order, fulfillment, support, returns, refunds, reconciliation, and incident operations before paid checkout.
7. Run sandbox checkout with mock or sandbox provider only.
8. Request live provider readiness review only after legal, security, ops, payment, and support gates are complete.
9. Package open protocol artifacts only after adapters, schemas, examples, privacy, security, and governance are complete.

## Current Go-Live Verdict

Agentic Commerce is not live-ready. It is not ready for real merchant launch, broad public discovery, checkout/payment enablement, live Plural, live provider use, production allowlists, or public protocol publication.

What is safe now:

- Internal planning.
- Internal docs.
- Synthetic examples.
- Sandbox previews.
- Dry-run evidence.
- Read-only contract validation.
- Guardrail and conformance tests.
- Non-enabling standards preparation.

What is not safe now:

- Real merchant production approval.
- Public discovery for real or synthetic merchants.
- Checkout/payment creation for production buyers.
- Live provider credentials or live Plural execution.
- Production connector sync against merchant private APIs.
- Public standards, certification, compliance, conformance, or production-ready claims.

## P0/P1/P2 Backlog Table

| Priority | Workstream | Owner | Dependencies | Acceptance criteria | Validation gates |
| --- | --- | --- | --- | --- | --- |
| P0 | Release control and docs-only workflow guard | Grantex | Current CI/deploy inventory | Internal planning docs do not accidentally trigger deploy-adjacent workflows; release owners can tell docs-only changes from runtime changes. | Workflow path review, docs-only dry run, no cloud command evidence. |
| P0 | Contract parity across APIs, MCP, SDKs, portal, and AgenticOrg aliases | Grantex + AgenticOrg | Existing OpenAPI, MCP tools, connector aliases, SDKs | Every advertised commerce method maps to one current contract and fails closed on mismatch. | Schema diff, alias mapping test, error taxonomy check, no direct provider call test. |
| P0 | Real merchant readiness packet | Grantex | Merchant RBAC, evidence references, reviewer roles | A named merchant can be reviewed with public-safe summaries and private non-secret evidence references; no launch is implied. | Secret scan, approval wording scan, RBAC test, evidence retention review. |
| P0 | Buyer web read-only channel | AgenticOrg + Grantex | Grantex read-only preview, session model, gate checks | One first-party web buyer session can browse only approved read-only data and refuse unsafe actions. | Grantex-only call test, public discovery gate test, channel smoke, refusal evals. |
| P0 | Existing-system connector credential-reference design | Grantex | Vault/reference model, connector registry | Merchant connector credentials are represented only by safe references; no secret values appear in docs, payloads, logs, or scans. | Secret/private scan, redaction tests, credential display tests, no outbound sync. |
| P0 | Connector sandbox dry-run against merchant-approved non-production source | Grantex | Credential-reference design, source precedence | One connector can dry-run catalog/price/inventory mapping in sandbox with remediation evidence and rollback notes. | Dry-run test, no production API call test, source precedence audit, remediation packet. |
| P0 | Order foundation | Grantex | Cart/payment intent contract, catalog snapshot | Durable order record, line item snapshot, status, audit, and support reference exist before paid checkout. | State-machine tests, audit tests, tenant isolation tests, no live payment. |
| P0 | Fulfillment/support/return-refund handoff | Grantex + AgenticOrg | Order foundation | Buyers and sellers can see allowed statuses and safe support paths; agents do not invent delivery, warranty, return, refund, or support promises. | Refusal evals, support handoff test, policy wording scan. |
| P0 | Payment/live provider readiness packet | Grantex | Order, fulfillment, provider boundary, legal review | Live mode remains blocked until provider, legal, security, webhook, reconciliation, settlement, incident, and support evidence exists. | Mock/sandbox E2E, webhook replay tests, settlement model review, live flag scan. |
| P0 | Consent/passport/session/revocation hardening | Grantex + AgenticOrg | Buyer channel, cart/order contracts | Protected actions require user-bound consent, scoped authority, online revocation, and audit evidence across Grantex and AgenticOrg sessions. | Revocation propagation test, passport validation tests, channel cache invalidation. |
| P1 | Catalog/inventory/pricing/tax/warranty/returns data completeness | Grantex | Connector source precedence | Catalog facts include enough final-price, tax, warranty, return, and inventory freshness data to prevent misleading buyer answers. | Stale-data tests, tax/price fixtures, public-safe preview validation. |
| P1 | Refunds, disputes, settlement, payout, reconciliation | Grantex | Order/payment state model | Sellers can answer payment and payout status; buyers can request support/refund through guarded workflows. | Reconciliation tests, mismatch handling, dashboard/API parity. |
| P1 | Security/privacy/KYC/KYB/fraud/moderation | Grantex + AgenticOrg | Merchant readiness packet, buyer channel | Real launch blockers for identity, abuse, fraud, prohibited goods, privacy, retention, and moderation are explicit and testable. | Threat model, abuse tests, privacy review, merchant content moderation checks. |
| P1 | Observability and incident response | Both | Runtime paths under test | Metrics, alerts, runbooks, rollback drills, and support ownership exist for every live-adjacent stage. | Alert route test, rollback rehearsal, incident runbook review. |
| P2 | Open protocol packaging and adapter readiness | Grantex + AgenticOrg | Stable product contracts, example corpus | schema.org, UCP-style, ACP-style, AP2-style, MCP, A2A, and connector mappings are documented as adapters, not certification. | Schema validation, example scan, overclaim scan, non-normative wording review. |

## Grantex-Owned Workstreams

| Workstream | Implementation responsibility | Dependencies | Exit criteria |
| --- | --- | --- | --- |
| Merchant control plane | Seller onboarding, RBAC, review states, evidence references, launch blocker view. | Release control, evidence policy, tenant model. | Merchant can self-serve sandbox readiness and request review without production approval. |
| Connector and source-of-truth governance | Connector registry, credential references, dry-run, remediation, source precedence, sync health. | Credential-reference design, source precedence schema. | Sandbox dry-run proves mapping and remediation; production sync remains blocked until approval. |
| Catalog, inventory, pricing, tax, warranty, returns | Product/variant APIs, import, availability, final-price facts, tax/GST metadata, warranty and return policy facts. | Connector governance, data quality checks. | Agent-facing previews can refuse stale or incomplete facts before public discovery. |
| Cart, checkout, payment safety | Cart lifecycle, idempotency, payment intent guardrails, provider-neutral interface, mock/sandbox provider. | Consent/passport, order foundation, provider packet. | Sandbox checkout E2E passes; live checkout remains blocked. |
| Order and post-purchase lifecycle | Order, fulfillment, delivery status, support, return/refund requests, disputes. | Cart/payment contracts, catalog snapshots. | Buyers and sellers can track status without agents inventing post-purchase facts. |
| Audit, evidence, observability, incident response | Append-only audit, metrics, alerts, runbooks, rollback, evidence retention. | Runtime slices and operator portal. | Protected actions fail closed when required audit cannot be written. |
| Public discovery and allowlist readiness | Narrow gates, approval packet, public-safe preview, rollback and smoke evidence. | Merchant readiness, AgenticOrg dependency. | Read-only discovery can be proposed for one approved scope without checkout/payment. |
| Open protocol packaging | Internal schemas, adapter tables, examples, security/privacy, governance plan. | Stable product contracts and public-safe corpus. | Drafts stay internal until external publication is separately approved. |

## AgenticOrg-Owned Workstreams

| Workstream | Implementation responsibility | Dependencies | Exit criteria |
| --- | --- | --- | --- |
| Buyer-agent creation | Buyer can create or select a commerce buyer agent with clear Grantex-only capability labels. | Grantex read-only contracts, AgenticOrg identity/session model. | One first-party web flow works before chat platform expansion. |
| Buyer channel adapters | Web first, then ChatGPT, Claude, Gemini, WhatsApp, Telegram, API, MCP, and A2A as separate slices. | Buyer-agent creation, consent handoff, channel limits. | Each channel has exact tool list, refusal copy, auth/session linking, rate limits, and smoke tests. |
| Grantex commerce connector/client | Maintain aliases, error translation, refusal behavior, and no-provider-call boundary. | Grantex contract parity. | Tests prove every commerce path calls Grantex only. |
| Buyer consent/session/revocation | Present consent prompts, preserve session context, propagate revocation, avoid stale cache exposure. | Grantex consent/passport lifecycle. | Revocation blocks active AgenticOrg sessions and cached actions. |
| Buyer-facing discovery and grounded answers | Read-only merchant/product answers grounded in Grantex data. | Approved Grantex public-safe payloads. | No unsupported price, inventory, delivery, warranty, tax, refund, or support claims. |
| Error translation and support handoff | Convert Grantex errors into buyer-safe messages without leaking private details. | Grantex error taxonomy and support model. | Stable buyer-safe messages for consent, policy, stale inventory, disabled merchant, provider boundary, and support paths. |
| Cross-repo release ordering | Do not consume or advertise Grantex capability before Grantex has approved it. | Grantex release checklist. | Release checklist blocks AgenticOrg exposure when Grantex dependency is missing. |

## Cross-Repo Dependencies

| Dependency | Grantex must provide | AgenticOrg must provide | Safe sequencing rule |
| --- | --- | --- | --- |
| Read-only buyer discovery | Approved read-only preview contract, public-safe payload, gate state, smoke evidence. | Hidden-by-default commerce discovery, buyer-safe rendering, Grantex-only connector. | Grantex approval and smoke precede AgenticOrg exposure. |
| Buyer session | Session envelope, merchant capability profile, refusal/error taxonomy. | Buyer session orchestration, channel binding, cache invalidation. | Read-only session precedes cart/checkout work. |
| Consent/passport | Consent request, passport exchange, verify, revoke, audit. | Consent handoff UX, session-bound storage, revocation propagation. | Checkout/payment cannot precede consent/passport hardening. |
| Checkout/payment | Cart, idempotency, payment intent, provider-neutral mock/sandbox path, audit. | Grantex-only tool calls, final user confirmation, safe refusal. | Sandbox checkout precedes any live provider review. |
| Order lifecycle | Order, fulfillment, support, return/refund status APIs. | Buyer-facing status and support messages. | Paid checkout cannot precede post-purchase minimum viable lifecycle. |
| Open protocol adapters | Canonical objects, schemas, examples, mapping tables. | A2A/MCP mapping and buyer-agent limitations. | Adapter readiness precedes any external publication request. |

## Buyer-Agent Creation Workstream

Owner: AgenticOrg, with Grantex contract dependencies.

Goal: let a buyer create or select a commerce buyer agent that can browse only approved Grantex-controlled merchant facts and refuse write/payment actions until the matching Grantex gates exist.

Dependencies:

- Grantex read-only discovery contract.
- AgenticOrg session model.
- Buyer-safe error taxonomy.
- Commerce connector alias parity.
- Public discovery gate remains disabled until separate approval.

Acceptance criteria:

- First-party web flow can start a read-only buyer session with a synthetic or approved sandbox merchant.
- Agent shows no direct provider, direct merchant private API, checkout, live payment, live Plural, or certification language.
- Buyer sees clear limitations for inventory, final price, delivery, returns, refunds, and support when source data is missing.
- Revocation or merchant disable blocks active sessions.

Validation gates:

- Grantex-only connector test.
- Channel session smoke.
- Refusal evals for missing consent, public discovery disabled, checkout disabled, provider call blocked, merchant private API blocked, and stale inventory.
- Overclaim and private-detail scan.

## Seller Self-Serve Onboarding Workstream

Owner: Grantex.

Goal: move merchants from operator-heavy sandbox setup to a controlled self-serve readiness workflow without approving production launch.

Dependencies:

- Merchant RBAC.
- Evidence reference policy.
- Connector source governance.
- Launch blocker matrix.
- Review and rollback owner model.

Acceptance criteria:

- Merchant can create workspace, complete public profile, declare sources, upload or connect data in sandbox, review public-safe preview, see blockers, assign owners, and request review.
- Reviewer can approve or reject sandbox readiness without setting production allowlists or public discovery.
- All decisions are audited.

Validation gates:

- Tenant isolation tests.
- Role tests for submitter, merchant owner, operator reviewer, security reviewer, legal reviewer, ops owner, rollback owner, and auditor.
- Secret/private scan on evidence references.
- Launch-negative wording scan.

## Merchant Existing-System Connector Workstream

Owner: Grantex.

Goal: support merchant ERP/PIM/POS/OMS/ecommerce data sources through safe references, dry-runs, remediation, and later approved sync.

Dependencies:

- Credential-reference model.
- Connector registry.
- Source precedence.
- Dry-run evidence packet.
- Retry/idempotency and rollback design.

Acceptance criteria:

- Credentials are never stored, logged, or displayed as plaintext in roadmap docs, payloads, logs, or review artifacts.
- Connector dry-run can classify catalog, price, inventory, warranty, return, and support data quality.
- Production outbound sync remains blocked until a separate approval.

Validation gates:

- No secret value scan.
- No merchant private API call scan.
- Dry-run fixture validation.
- Remediation evidence review.

## Catalog, Inventory, Pricing, Tax, Warranty, And Returns Workstream

Owner: Grantex.

Goal: prevent agents from misleading buyers about product facts.

Dependencies:

- Source precedence.
- Connector quality checks.
- Public-safe preview payload.
- Error/refusal taxonomy.

Acceptance criteria:

- Catalog items have variant snapshots, images, brand/model, category, price amount, currency, tax-inclusive marker, tax/GST/HSN data when required, availability, warranty summary, return policy summary, source system, and last-synced timestamp.
- Inventory uses quantity, location, serviceability, reservation/hold status, and stale data markers before checkout.
- Pricing can represent final payable amount inputs, offers, discounts, coupons, EMI constraints, shipping fees, and tax limits or refuse when unknown.

Validation gates:

- Stale inventory tests.
- Final price consistency tests.
- Preview payload scan.
- Buyer-safe refusal evals.

## Fulfillment, Delivery, And Order Lifecycle Workstream

Owner: Grantex, with AgenticOrg buyer-facing consumption.

Goal: make payment-adjacent commerce safe by creating a durable order and post-purchase status model before live checkout.

Dependencies:

- Cart/payment intent foundation.
- Catalog line item snapshot.
- Merchant support metadata.
- Audit/evidence model.

Acceptance criteria:

- Order record captures merchant, buyer reference, cart, line items, price snapshot, payment reference, fulfillment method, status, timestamps, and audit references.
- Delivery/serviceability is explicit or checkout refuses.
- AgenticOrg can present buyer-safe order status without raw provider or merchant private details.

Validation gates:

- Order state-machine tests.
- Tenant isolation tests.
- Audit write tests.
- Buyer-safe status translation tests.

## Refunds, Disputes, And Support Workstream

Owner: Grantex for system of record; AgenticOrg for buyer-facing handoff.

Goal: avoid a payment-only demo by supporting post-purchase problems.

Dependencies:

- Order foundation.
- Merchant return policy fields.
- Payment state model.
- Support ownership.

Acceptance criteria:

- Buyer can request support, return, refund, or dispute handoff through a guarded path.
- Grantex records request status, eligibility basis, merchant policy reference, reviewer owner, and audit event.
- Provider refund execution can remain manually gated, but status must be visible.

Validation gates:

- Support/refund request tests.
- Policy ambiguity refusal evals.
- Privacy-safe transcript retention review.

## Payments, Live Provider, And Plural Readiness Workstream

Owner: Grantex.

Goal: keep provider operations blocked until the surrounding product and operations are ready.

Dependencies:

- Consent/passport.
- Order and fulfillment handoff.
- Provider-neutral interface.
- Webhook signature and replay handling.
- Legal, security, ops, and support review.

Acceptance criteria:

- Mock/sandbox checkout works with idempotency, audit, payment state machine, provider-neutral errors, webhook replay, reconciliation, and rollback.
- Live provider request has explicit legal approval, provider approval, credential storage/rotation, data residency review, settlement model, incident runbook, and support owner.
- Live Plural remains blocked until separate live-mode approval.

Validation gates:

- Mock/sandbox E2E.
- Webhook signature/replay/idempotency tests.
- Reconciliation tests.
- Live flag and provider credential scans.

## Consent, Passport, Session, And Revocation Workstream

Owner: Grantex for consent/passport authority; AgenticOrg for buyer session propagation.

Goal: ensure every protected action has user-bound, scoped authority and immediate revocation behavior.

Dependencies:

- Buyer-agent session envelope.
- Policy engine.
- Audit/evidence store.
- Channel-specific consent UX.

Acceptance criteria:

- Browse and checkout scopes are separate.
- Checkout/payment actions require active, unexpired, unrevoked passport with amount, currency, merchant, tenant, agent, and scope checks.
- Revocation blocks active Grantex protected actions and AgenticOrg cached sessions.
- Consent copy is readable and channel-specific.

Validation gates:

- Passport verify/revoke tests.
- Cross-tenant negative tests.
- Channel cache invalidation tests.
- Consent wording review.

## Audit, Evidence, Observability, And Incident Response Workstream

Owner: Grantex + AgenticOrg.

Goal: make launch stages operable, reversible, and inspectable.

Dependencies:

- Audit ledger.
- Metrics and logs.
- Runbooks.
- Rollback owners.
- Evidence retention policy.

Acceptance criteria:

- Protected actions fail closed if required audit evidence cannot be written.
- Metrics exist for public discovery, connector sync lag, stale data, consent failure, payment pending age, webhook lag, refusal rate, and AgenticOrg channel failures.
- Rollback drills exist for public discovery, buyer channel exposure, connector sync, bad import, stale inventory, sandbox checkout, and provider outage.

Validation gates:

- Audit write failure tests.
- Alert route review.
- Rollback rehearsal.
- Evidence redaction scan.

## Security, Privacy, Compliance, KYC/KYB, Fraud, And Moderation Workstream

Owner: Grantex + AgenticOrg, with legal/security review before any live stage.

Goal: turn launch blockers into explicit control objectives and human-review gates.

Dependencies:

- Merchant readiness packet.
- Buyer identity/session model.
- Data classification.
- Moderation and restricted-goods policy.

Acceptance criteria:

- KYB/KYC evidence references exist for real merchants without storing private raw documents in repo.
- Buyer and merchant terms, privacy, consent, retention, support, dispute, and refund obligations are mapped.
- Fraud controls cover velocity, suspicious agents, repeated failed payments, merchant risk holds, public discovery abuse, and channel abuse.
- Product content moderation blocks prohibited goods and prompt-injection content from agent-visible context.

Validation gates:

- Threat model review.
- Privacy review.
- Fraud/abuse test cases.
- Real merchant/private-detail scan.
- Overclaim scan.

## Public Discovery And Production Allowlist Readiness Workstream

Owner: Grantex controls merchant approval and allowlist; AgenticOrg controls buyer-channel exposure.

Goal: make public discovery an audited, reversible, read-only stage.

Dependencies:

- Real merchant readiness packet.
- Public-safe preview.
- Grantex read-only smoke.
- AgenticOrg dependency approval.
- Rollback plan.

Acceptance criteria:

- One approved merchant scope can be proposed for read-only discovery without checkout/payment, live provider, or live Plural.
- Allowlist values are reviewed and applied only in a separately approved rollout.
- AgenticOrg remains hidden until Grantex approval and a separate AgenticOrg approval exist.

Validation gates:

- Public payload secret scan.
- Production-looking ID review.
- Gate-state smoke.
- Rollback smoke.
- Wording scan.

## Open Protocol Packaging And Adapter-Readiness Workstream

Owner: Grantex + AgenticOrg.

Goal: prepare protocol materials without publishing or claiming certification.

Dependencies:

- Stable product contracts.
- Public-safe example corpus.
- Adapter mappings.
- Security and privacy considerations.
- Governance and versioning plan.

Acceptance criteria:

- Canonical internal schemas exist for merchant, capability, catalog item, offer, inventory, cart, consent, mandate evidence, order, fulfillment, return/refund, settlement, connector source, and audit reference.
- Adapter mappings explain how the architecture maps to existing surfaces through adapters.
- Grantex and AgenticOrg appear only as implementation examples.
- External publication, standards submission, certification, conformance, and compliance claims remain blocked.

Validation gates:

- JSON/schema validation.
- Public-safe example scan.
- Standards overclaim scan.
- Legal/IP/governance review.

## schema.org/UCP/ACP/AP2/MCP/A2A Adapter Dependency Map

| Surface | Dependency | Adapter posture | Blocker before public claim |
| --- | --- | --- | --- |
| schema.org JSON-LD | Public-safe product and offer facts | Read-only product/offer preview adapter. | Final price, availability, warranty, return, delivery, and source freshness proof. |
| UCP-style capability profile | Merchant capability and policy profile | Capability profile adapter for supported scopes and refusal reasons. | Versioning, capability registry, policy semantics, and third-party review. |
| ACP-style checkout shape | Cart and checkout safety model | Blocked checkout shape until consent/passport/payment gates pass. | Order, fulfillment, final price, idempotency, and payment safety gates. |
| AP2-style evidence | Consent, mandate, policy, audit evidence | Unsigned/internal evidence preview. | Signature model, evidence registry, privacy review, retention policy. |
| MCP/native API | Grantex MCP tools and REST APIs | Grantex-controlled tool/API adapter. | Contract parity, auth, tenant boundary, and SDK docs. |
| A2A | AgenticOrg agent discovery and channel metadata | Buyer-agent capability adapter. | Public discovery approval, channel-specific limits, no-provider-call proof. |
| Merchant connector metadata | Connector registry and source precedence | Source-of-truth adapter. | Credential-reference design, dry-run evidence, production sync approval. |

## What Must Happen Before Sandbox Pilot

- Docs-only release control is understood.
- Synthetic or sandbox merchant data is clearly labeled.
- Grantex and AgenticOrg contracts are aligned for read-only flows.
- Secret/private scans pass.
- Public discovery remains disabled.
- Checkout/payment remains disabled or mock/sandbox-only.
- No live provider, live Plural, production allowlist, or merchant private API call is used.
- Runbook identifies support, incident, evidence, and rollback owners.

## What Must Happen Before Limited Real Merchant Pilot

- Real merchant readiness packet exists with non-secret evidence references.
- KYB/KYC, legal, security, product, ops, support, and rollback owners are assigned.
- Connector source-of-truth is declared and dry-run validated.
- Public-safe preview passes review.
- Merchant terms, privacy, refund/support policy, and restricted-goods posture are reviewed.
- AgenticOrg dependency approval exists if any buyer-facing channel is involved.
- Public discovery and checkout/payment are still separately gated.

## What Must Happen Before Public Discovery

- One merchant and one read-only scope are approved.
- Grantex read-only discovery smoke passes.
- Public payload contains no private merchant data, secrets, provider details, raw payloads, production config values, or overclaims.
- AgenticOrg public commerce metadata remains hidden unless separately approved.
- Rollback owner and rollback smoke are recorded.
- No checkout/payment, live provider, live Plural, or production Commerce V1 broad enablement is included.

## What Must Happen Before Checkout/Payment Enablement

- Order foundation is implemented.
- Fulfillment, delivery, support, return/refund handoff, and buyer status paths exist.
- Consent/passport/session/revocation is hardened.
- Final price, tax, inventory, and stale-data controls are implemented.
- Idempotency, audit, payment state machine, webhook replay, reconciliation, and incident runbooks pass tests.
- Checkout/payment request remains sandbox or limited pilot until separately approved.

## What Must Happen Before Live Plural/Live Provider Enablement

- Live provider legal and provider approvals exist outside the repository.
- Credential storage and rotation are reviewed.
- Data residency and payment data classification are approved.
- Webhook signature, replay, reconciliation, settlement, payout, refund, dispute, incident, and support gates pass.
- Live-mode flags and allowlists are reviewed by humans.
- Final user confirmation is required for live payment.
- Rollback drill is complete.

## What Must Happen Before External Protocol Publication Or Standards Submission

- Internal draft text is split into normative language and non-normative examples.
- Canonical schemas and test vectors are stable and public-safe.
- Adapter mappings to schema.org, UCP-style, ACP-style, AP2-style, MCP, A2A, and connector metadata are complete.
- Security, privacy, IANA/registry, versioning, governance, IP, and legal reviews are complete.
- Grantex and AgenticOrg are examples only.
- No IETF, NIST, NCCoE, RFC, UCP, ACP, AP2, schema.org, MCP, A2A, provider, certification, compliance, conformance, or standardization claim is made without separate approval.

## Stop Conditions

Stop the roadmap path and do not proceed to the next stage if any condition is true:

- A change requires a cloud command, production config change, secret touch, or production allowlist.
- Public discovery is requested before real merchant approval, public-safe payload review, rollback, and smoke evidence.
- Checkout/payment is requested before consent/passport, order, fulfillment, support, return/refund, audit, and payment safety gates.
- Live provider or live Plural is requested before legal, provider, security, data residency, settlement, incident, and support approval.
- AgenticOrg would call a payment provider or merchant private API directly.
- A connector would call a merchant private API without separate production connector approval.
- A doc or public surface claims certification, compliance, conformance, standardization, production readiness, public-launch readiness, IETF submission, NIST submission, NCCoE acceptance, or RFC status.
- Synthetic/demo data is treated as merchant approval.
- Required audit evidence cannot be written.
- Revocation or emergency disable does not block active protected actions.

## Suggested Next 10 Implementation PR Slices In Exact Order

1. C6U1: Grantex docs-only CI/deploy guard and release-control inventory.
2. C6U2: Cross-contract parity matrix for Grantex OpenAPI, MCP tools, SDKs, portal clients, and AgenticOrg aliases.
3. C6U3: Real merchant readiness packet with reviewer RBAC and non-secret evidence references, still no public discovery.
4. C6U4: Connector credential-reference design with vault-only references, still no outbound sync.
5. C6U5: First connector sandbox dry-run against a merchant-approved non-production source with source precedence evidence.
6. C6U6: AgenticOrg first-party web buyer read-only session smoke using Grantex-only calls.
7. C6U7: Grantex order foundation with line item snapshot, status, support reference, and audit.
8. C6U8: Fulfillment, delivery, support, and return/refund handoff contracts across Grantex and AgenticOrg.
9. C6U9: Sandbox checkout E2E with consent/passport, order handoff, mock or sandbox provider, webhook/reconciliation, and rollback drill.
10. C6U10: Live provider readiness packet and review checklist, with live mode still blocked until separate approval.

## Readiness Checklist By Stage

| Stage | Required ready evidence | Must remain false |
| --- | --- | --- |
| Internal sandbox | Synthetic labels, mock/sandbox data, Grantex-only AgenticOrg calls, refusal evals, no-secret scans. | Real merchant approval, public discovery, live payment, live Plural, production allowlist. |
| Real merchant private readiness | Non-secret merchant evidence references, reviewer RBAC, connector source declaration, legal/security/ops owners. | Public discovery, checkout/payment, live provider, protocol publication. |
| Read-only public pilot | One approved merchant/scope, Grantex smoke, public-safe payload, AgenticOrg dependency approval, rollback evidence. | Checkout/payment, live provider, live Plural, certification/conformance/compliance claim. |
| Sandbox checkout pilot | Consent/passport, order handoff, mock/sandbox provider, webhook/reconciliation, audit, support/rollback. | Live money movement, live provider, broad public launch. |
| Paid limited pilot | Legal/provider/security/ops approval, support staffed, caps, one channel, one merchant, incident readiness. | Broad merchant onboarding, autonomous delegated payments, unreviewed channel expansion. |
| Broader launch | Repeatable onboarding, connectors, order/fulfillment/refund/settlement, observability, docs, compliance and support operations. | Unsupported category/channel/provider claims. |
| External protocol publication | Stable schemas, adapters, examples, security/privacy, governance, legal/IP review. | Certification, compliance, conformance, or standards claim without external process completion. |

## Layman Explanation

For sellers: a seller will eventually sign up, create a merchant workspace, connect or upload product data, declare which system is the source of truth, review what buyer agents are allowed to see, fix launch blockers, request review, and later opt into public discovery or checkout only after separate approvals. The seller should be able to see what is missing and who owns each blocker.

For buyers: a buyer will eventually open a supported channel, choose or create a commerce buyer agent, browse approved merchant facts, ask grounded product questions, grant consent for protected actions, and receive safe status updates. If data is missing, stale, unapproved, or payment is blocked, the agent should refuse clearly instead of guessing.

## Explicit Non-Approval

This roadmap does not approve production launch, real merchants, public discovery, checkout/payment, live providers, live Plural, production allowlists, protocol publication, external standards submission, certification, compliance, conformance, standardization, production readiness, merchant approval, provider calls, merchant private API calls, cloud resources, production config changes, or secrets handling. Every launch stage requires a later explicit approval and fresh gate review.
