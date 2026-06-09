# Agentic Commerce Trust Architecture

Candidate filename: `draft-mishra-agentic-commerce-trust-architecture-00`

Status: internal Internet-Draft skeleton only.

Created: 2026-06-09.

This document is an internal draft-preparation artifact. It has not been
submitted to IETF, has not been adopted by an IETF working group, is not an
RFC, and is not a standard. It is not public protocol publication,
certification, production authorization, public discovery authorization,
checkout/payment authorization, live-payment authorization, or provider
authorization.

This skeleton uses generic protocol language for review. It does not define a
Grantex-specific requirement, AgenticOrg-specific requirement, payment-provider
requirement, production configuration, allowlist, credential, secret, merchant
private API, or live-payment behavior.

## Abstract

Agentic commerce lets software or AI agents discover merchant capabilities,
request buyer-scoped actions, and coordinate commerce workflows. Unsafe designs
can bypass buyer consent, merchant policy, source-of-truth boundaries, provider
boundaries, or audit evidence.

This document sketches an application-layer trust architecture for
agent-mediated commerce. It describes roles, trust boundaries, capability
discovery, buyer-agent session envelopes, consent and scoped authority,
merchant policy evaluation, cart/checkout/payment safety preconditions,
connector source metadata, evidence envelopes, refusal semantics, and mappings
to existing commerce and agent interoperability surfaces through adapters.

## 1. Introduction

Buyer agents can help buyers compare products, assemble carts, request consent,
and monitor commerce status. Merchant systems, however, often include private
catalog, pricing, inventory, order, fulfillment, support, payment, and policy
state. A trust architecture is needed so agent-mediated workflows can proceed
only when the buyer, merchant, agent platform, connector source, and payment
provider boundaries are respected.

The architecture in this skeleton has three goals:

- describe a generic trust layer for agent-mediated commerce;
- keep existing protocol and metadata surfaces usable through adapters rather
  than replacing them;
- fail closed when consent, scope, policy, freshness, source-of-truth,
  provider-boundary, or audit preconditions are missing.

This skeleton intentionally avoids formal requirement keywords while internal
review is in progress. Future drafts can introduce normative language only
after public-safe review, IPR/legal review, and external submission
authorization.

## 2. Terminology

Buyer:

: A human or organization that wants to discover, evaluate, purchase, or
  monitor goods or services.

Buyer agent:

: Software or an AI system acting on behalf of a buyer within declared scope.

Merchant:

: A seller that offers goods or services and controls whether capabilities are
  visible or usable by agents.

Merchant control plane:

: A merchant-authorized system that coordinates merchant identity, capability
  exposure, catalog state, policy, consent, connector source metadata, provider
  boundaries, and audit evidence.

Agent platform:

: A runtime, channel, assistant surface, or orchestration system that hosts or
  mediates buyer-agent interaction.

Connector source:

: A merchant-owned or merchant-authorized system of record for catalog, price,
  inventory, order, fulfillment, refund, settlement, support, or related state.

Payment provider:

: A system that creates or processes payment-related objects. In this
  architecture the payment provider is accessed through governed merchant
  control-plane boundaries.

Auditor/operator:

: A role or system that reviews evidence, investigates unsafe states, confirms
  readiness blockers, and handles remediation or rollback.

Capability profile:

: A public-safe or channel-safe description of merchant capabilities and
  blocked states that an agent platform can inspect.

Consent grant:

: Buyer authorization for a scoped commerce action, including actor, merchant,
  capability, amount, currency, validity, and revocation context where
  applicable.

Evidence envelope:

: Redacted structured evidence that references consent, policy, scope, state,
  and audit events without exposing secrets, credentials, raw private payloads,
  or concrete production configuration values.

Refusal:

: A structured denial or non-progression result that includes a safe reason
  code and optional remediation guidance.

## 3. Roles and Trust Boundaries

### 3.1 Buyer

The buyer is the authority for buyer-specific consent. Buyer consent is not
implied by agent identity, prior browsing, chat context, merchant readiness, or
provider availability.

### 3.2 Buyer Agent

The buyer agent can request read-only discovery, cart drafting, consent
requests, checkout preparation, or status reads according to available
capabilities. It does not directly bypass merchant policy, connector source
boundaries, payment-provider boundaries, or buyer consent.

### 3.3 Merchant

The merchant owns capability exposure, source-of-truth precedence, readiness
gates, and policy for commerce actions. The merchant can disable or restrict
capabilities by channel, agent class, product class, region, amount, freshness,
or operational state.

### 3.4 Merchant Control Plane

The merchant control plane enforces the boundary between agent-facing requests
and merchant-controlled state. It evaluates capability exposure, policy,
consent, source freshness, provider readiness, and evidence emission before an
action advances.

### 3.5 Agent Platform

The agent platform carries buyer-agent requests and presents safe results,
refusals, or consent prompts. It consumes capability profiles and refusal
semantics but does not become the merchant source of truth.

### 3.6 Connector Source

Connector sources provide merchant-authorized metadata or state. The
architecture distinguishes connector metadata and source-of-truth precedence
from direct buyer-agent execution against private merchant systems.

### 3.7 Payment Provider

Payment providers remain behind governed merchant control-plane interfaces.
Payment-related progression requires the relevant consent, policy, amount,
currency, idempotency, provider-readiness, and audit preconditions.

### 3.8 Auditor/Operator

Auditors and operators inspect evidence, readiness blockers, refusal patterns,
source freshness, and rollback state. Their review does not itself imply
public discovery, production approval, or payment approval.

## 4. Architecture Overview

The architecture has five conceptual layers:

1. Capability exposure: merchant-authorized capability metadata is made available
   to agent platforms or discovery surfaces.
2. Session mediation: buyer-agent requests are represented in a session
   envelope with declared actor, channel, merchant, requested capability, and
   evidence references.
3. Consent and policy: buyer consent and merchant policy are evaluated before
   scoped actions proceed.
4. Source and provider boundaries: connector source precedence, source
   freshness, cart/checkout/payment preconditions, and provider readiness are
   checked by the merchant control plane.
5. Evidence and refusal: allowed, blocked, pending, or refused outcomes emit
   safe evidence and reason codes for buyers, merchants, agent platforms, and
   auditors.

```text
buyer
  -> buyer agent
  -> agent platform
  -> merchant control plane
       -> capability profile
       -> policy evaluator
       -> consent verifier
       -> connector source metadata
       -> provider-boundary adapter
       -> evidence envelope
  -> buyer agent response or refusal
```

The model maps to existing surfaces through adapters. It does not require
merchants or agents to ignore schema.org, UCP-style capability discovery,
ACP-style checkout shapes, AP2-style evidence, MCP, native APIs, or merchant
connector metadata.

## 5. Discovery and Capability Profile

A capability profile describes what a buyer agent can safely read or request.
It is generated from merchant policy, channel settings, source state, and
readiness blockers.

The profile can represent:

- merchant identity and public-safe display fields;
- readable catalog, offer, shipping, return, support, and availability fields;
- capability classes such as browse, compare, cart draft, consent request,
  checkout preparation, payment-status read, support handoff, and
  return/refund request;
- environment or channel restrictions;
- freshness windows and source confidence;
- consent, policy, provider, or operator review requirements;
- blocked capabilities with refusal codes.

Example profile fragment with synthetic identifiers:

```json
{
  "merchant_ref": "merchant.example.001",
  "profile_version": "cap_example_2026_06_09",
  "environment": "review",
  "capabilities": [
    {
      "key": "catalog.read",
      "status": "available",
      "source_freshness": "current"
    },
    {
      "key": "checkout.prepare",
      "status": "blocked",
      "reason": "consent_required"
    }
  ],
  "evidence_ref": "ev_example_capability_001"
}
```

## 6. Buyer-Agent Session Envelope

The buyer-agent session envelope represents the immediate context for an
agent-mediated request. It should be small, redacted, and suitable for
correlation without containing secrets, raw credentials, or private connector
payloads.

Candidate fields:

- `session_ref`;
- `buyer_ref`;
- `buyer_agent_ref`;
- `agent_platform_ref`;
- `merchant_ref`;
- `channel_ref`;
- `requested_capability`;
- `capability_profile_ref`;
- `consent_state`;
- `policy_state`;
- `source_freshness_state`;
- `provider_boundary_state`;
- `evidence_ref`;
- `refusal`, when blocked.

Example envelope:

```json
{
  "session_ref": "sess_example_001",
  "buyer_ref": "buyer_example_001",
  "buyer_agent_ref": "agent_example_001",
  "agent_platform_ref": "platform_example_001",
  "merchant_ref": "merchant.example.001",
  "requested_capability": "checkout.prepare",
  "capability_profile_ref": "cap_example_2026_06_09",
  "consent_state": "required",
  "policy_state": "pending",
  "source_freshness_state": "current",
  "provider_boundary_state": "not_evaluated",
  "evidence_ref": "ev_example_session_001"
}
```

## 7. Consent and Scoped Authority

Agent identity and buyer consent are separate concepts. An authenticated buyer
agent can request capabilities, but payment-affecting or otherwise protected
actions require scoped buyer authority and merchant policy approval.

Consent and scoped authority should capture:

- buyer reference;
- buyer-agent reference;
- merchant reference;
- permitted capabilities;
- amount and currency constraints where applicable;
- time validity;
- revocation state;
- merchant policy reference;
- audit or evidence reference.

Consent should be narrow enough that a buyer can understand the requested
action. When consent is absent, denied, stale, overbroad, revoked, expired, or
outside scope, the architecture returns a refusal rather than allowing
progression.

## 8. Merchant Policy Evaluation

Merchant policy determines whether a requested capability is visible,
requestable, consent-required, operator-review-required, or blocked.

Policy inputs can include:

- merchant approval state;
- tenant or account boundary;
- buyer-agent status and trust tier;
- channel restrictions;
- product, category, offer, shipping, return, or support constraints;
- amount and currency constraints;
- consent grant state;
- connector source freshness;
- provider readiness;
- emergency disable state;
- environment separation;
- audit and evidence availability.

Policy results should be explicit:

- `allow`;
- `deny`;
- `requires_buyer_consent`;
- `requires_merchant_review`;
- `requires_operator_review`;
- `blocked_by_source_state`;
- `blocked_by_provider_state`.

## 9. Cart, Checkout, and Payment Safety Preconditions

Cart, checkout, and payment workflows are higher-risk than read-only
discovery. A merchant control plane should verify preconditions before
progressing from read-only discovery to payment-affecting work.

Candidate safety preconditions:

- buyer-agent identity is known for the requested channel;
- merchant is authorized for the requested capability and channel;
- requested products or offers are in scope;
- catalog, price, and inventory are fresh enough for the requested action;
- buyer consent covers capability, merchant, amount, currency, and validity;
- consent has not expired or been revoked;
- merchant policy allows the action;
- idempotency prevents duplicate progression;
- payment-provider boundary is mediated by the merchant control plane;
- audit evidence can be written or referenced;
- unsafe or incomplete state returns a refusal.

This skeleton does not enable checkout/payment creation, live payments, live
Plural, direct payment-provider calls, or production Commerce V1 behavior.

## 10. Connector Source Metadata and Source-of-Truth Precedence

Connector sources represent merchant-authorized systems of record. The trust
architecture describes connector source metadata and precedence so buyer agents
can receive safe, fresh, and explainable state without directly invoking
private merchant APIs.

Connector metadata can include:

- source type, such as catalog, inventory, order, fulfillment, support, refund,
  settlement, or payment metadata source;
- source owner and merchant authorization reference;
- freshness timestamp or freshness bucket;
- precedence order among sources;
- read-only or write-capable posture;
- last validation or dry-run state;
- stale, conflict, or blocked status;
- redacted evidence reference.

Source-of-truth precedence should be explicit. When sources conflict or become
stale, the merchant control plane should downgrade capabilities, refuse unsafe
actions, or request review rather than silently presenting uncertain state as
current.

## 11. Evidence Envelope

The evidence envelope is a redacted record that lets parties reason about why
an action was allowed, blocked, pending, or refused. It should reference
decision evidence without disclosing secrets, raw private payloads, private
merchant artifacts, provider credentials, concrete production configuration
values, or concrete allowlist values.

Candidate fields:

- `evidence_ref`;
- `evidence_type`;
- `generated_at`;
- `buyer_ref`;
- `buyer_agent_ref`;
- `agent_platform_ref`;
- `merchant_ref`;
- `capability_ref`;
- `session_ref`;
- `consent_ref`;
- `policy_ref`;
- `source_state_ref`;
- `provider_boundary_ref`;
- `audit_refs`;
- `redaction`;
- `signature_state`, if present.

Example envelope:

```json
{
  "evidence_ref": "ev_example_decision_001",
  "evidence_type": "policy_and_consent_result",
  "generated_at": "2026-06-09T00:00:00Z",
  "buyer_ref": "buyer_example_001",
  "buyer_agent_ref": "agent_example_001",
  "merchant_ref": "merchant.example.001",
  "capability_ref": "checkout.prepare",
  "consent_ref": "consent_example_001",
  "policy_ref": "policy_example_v1",
  "audit_refs": ["audit_example_001"],
  "redaction": {
    "raw_payloads_included": false,
    "credentials_included": false,
    "private_api_urls_included": false,
    "production_config_values_included": false
  },
  "signature_state": "not_defined_by_this_skeleton"
}
```

## 12. Refusal and Error Semantics

Refusals are first-class results. They let buyer agents and agent platforms
explain why a request cannot proceed without inventing capability, stock,
policy, payment, or approval state.

Candidate refusal code families:

- `merchant_not_available`;
- `public_discovery_disabled`;
- `channel_not_enabled`;
- `capability_not_enabled`;
- `consent_required`;
- `consent_denied`;
- `consent_expired`;
- `consent_revoked`;
- `policy_denied`;
- `operator_review_required`;
- `catalog_stale`;
- `inventory_stale`;
- `price_changed`;
- `checkout_not_enabled`;
- `payment_provider_not_ready`;
- `live_payment_not_enabled`;
- `connector_source_blocked`;
- `merchant_private_api_not_allowed`;
- `provider_call_not_allowed`;
- `unsupported_action`.

Refusals should be safe for the buyer and useful for merchant operators. Public
or buyer-facing refusal details should avoid leaking private merchant policy,
private source details, credentials, or provider metadata.

## 13. Interoperability Mapping

The architecture maps to existing surfaces through adapters. It does not make
those surfaces optional for ecosystems that require them, and it does not claim
certification or conformance with those surfaces.

| Surface | Adapter mapping |
| --- | --- |
| schema.org JSON-LD | Public-safe product, offer, shipping, and return fields can be generated from merchant-authorized canonical state. |
| UCP-style capability profile | Merchant capabilities, consent requirements, channel status, and blocker reasons can be represented as a capability-discovery view. |
| ACP-style checkout shape | Cart, checkout, payment-status, and refusal state can be adapted from merchant-control-plane state when consent and provider preconditions are satisfied. |
| AP2-style evidence | Consent, amount, currency, scope, policy, cart hash, and audit references can be represented as evidence inputs for future mandate-oriented flows. |
| MCP/native API | Tool or API requests can be mediated by the same capability, consent, policy, source, provider-boundary, and audit checks. |
| Merchant connector metadata | Connector source health, freshness, source precedence, conflict state, and redacted evidence can inform capability exposure and refusal semantics. |

## 14. Security Considerations

This skeleton expects the draft to discuss at least the following risks:

- malicious, compromised, or over-permissioned buyer agents;
- prompt injection from merchant, catalog, support, or connector content;
- stale catalog, price, inventory, delivery, or support state;
- overbroad or ambiguous buyer consent;
- replay of consent, cart, checkout, or evidence references;
- idempotency failure causing duplicate action progression;
- cross-tenant or cross-merchant data exposure;
- capability overexposure through discovery profiles;
- private source metadata leakage;
- credential or secret leakage;
- direct payment-provider boundary bypass;
- direct merchant private API execution by buyer agents or agent platforms;
- audit tampering or missing audit evidence;
- public discovery misconfiguration;
- environment confusion between review, sandbox, and live modes.

Unsafe states should fail closed. Read-only discovery should not be treated as
authorization for cart, checkout, payment, refund, support, or private-system
execution.

## 15. Privacy Considerations

This skeleton expects the draft to address:

- data minimization across capability profiles, session envelopes, and evidence
  envelopes;
- separation of public merchant fields from private merchant artifacts;
- exclusion of raw private payloads from buyer-facing and public-safe views;
- redacted evidence references instead of private record disclosure;
- buyer consent records and revocation visibility;
- channel identity binding without unnecessary cross-channel tracking;
- retention, deletion, and export policy dependencies;
- sensitive-category or regulated-offer restrictions;
- safe operator visibility that does not leak secrets, credentials, or private
  merchant-system data to unauthorized parties.

## 16. Operational Considerations

Operators need enough state to investigate and recover without enabling unsafe
commerce actions.

Operational topics include:

- source freshness monitoring;
- connector conflict handling;
- capability downgrade and emergency disable;
- refusal-code monitoring;
- evidence retention;
- audit export and redaction;
- idempotency and duplicate detection;
- provider outage handling through merchant-control-plane boundaries;
- replay and reconciliation of safe internal events;
- rollback of capability exposure;
- incident response for public discovery or provider-boundary mistakes.

## 17. IANA Considerations

No IANA action is requested in this internal skeleton.

Future drafts may revisit registries only after message shapes, error codes,
and capability labels are stable and reviewed for public use.

## 18. Implementation Status

This section is non-normative.

The concepts in this skeleton are informed by internal implementation
experience in Grantex and AgenticOrg. Those systems are examples only and do
not define mandatory protocol behavior.

Current implementation experience is internal and preview-oriented. It does not
represent IETF submission, working-group adoption, RFC status, standards
status, public protocol publication, certification, production authorization,
public discovery authorization, checkout/payment authorization, provider
authorization, or live-payment authorization.

## 19. References

References are placeholders for later public-safe review.

- IETF Internet-Draft author guidance.
- IETF process overview.
- JSON data model references.
- HTTP semantics references.
- Security considerations guidance.
- Privacy considerations guidance.
- schema.org public metadata references.
- UCP-style capability profile references, if public-safe and cleared for
  citation.
- ACP-style checkout-shape references, if public-safe and cleared for
  citation.
- AP2-style evidence references, if public-safe and cleared for citation.
- MCP/native API references, if public-safe and cleared for citation.

## Appendix A. Internal Draft-Preparation Checklist

- Examples use synthetic identifiers only.
- Grantex and AgenticOrg appear only as non-normative implementation examples.
- No real merchant names, production identifiers, secrets, private URLs,
  provider credentials, raw payloads, concrete allowlists, or production config
  values are included.
- Existing surfaces are mapped through adapters rather than ignored or
  replaced.
- External submission requires separate explicit authorization.
