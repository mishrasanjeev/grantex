# IETF Candidate Outline - Agentic Commerce Trust Architecture

Status: internal Internet-Draft outline only.

Created: 2026-06-09.

Candidate filename:

`draft-mishra-agentic-commerce-trust-architecture-00`

This outline prepares an IETF Internet-Draft candidate. It has not been
submitted to IETF, has not been adopted by an IETF working group, has not been
approved as an RFC, and must not be cited as a standard.

## Intended Abstract

This document describes a trust architecture for agent-mediated commerce. It
defines roles, message envelopes, consent and authorization requirements,
merchant capability exposure, policy checks, audit evidence, refusal semantics,
and interoperability considerations for buyer agents, merchant control planes,
agent platforms, payment providers, and connector sources.

The architecture is designed to let agents discover and request commerce
actions without bypassing merchant policy, buyer consent, scoped authority,
provider boundaries, or audit evidence.

## Draft Goals

- Define a protocol-neutral trust architecture for agentic commerce.
- Provide JSON/HTTP-oriented examples that can map to multiple transports.
- Keep payment providers behind merchant-control-plane authorization.
- Keep merchant private systems behind merchant-control-plane connectors.
- Define refusal/error semantics for unsafe, stale, unapproved, or unsupported
  commerce actions.
- Describe evidence envelopes suitable for consent, policy, and audit review.
- Describe how existing protocol surfaces can consume canonical commerce state.

## Non-Goals

- No payment-provider standardization.
- No card-data or bank-account credential handling.
- No settlement, refund, chargeback, or tax standardization.
- No schema.org, UCP, ACP, AP2, MCP, MPP, A2A, or provider certification claim.
- No Grantex-specific API requirement.
- No AgenticOrg-specific agent implementation requirement.
- No autonomous live payment delegation requirement.

## Terminology

| Term | Draft meaning |
| --- | --- |
| Buyer | Human or organization seeking to discover or purchase goods or services. |
| Buyer Agent | AI or software agent acting for a buyer within declared scope. |
| Merchant | Seller offering goods or services. |
| Merchant Control Plane | System that owns merchant identity, catalog, policy, consent, evidence, and provider boundaries. |
| Agent Platform | Runtime or channel that hosts buyer-agent interaction. |
| Connector Source | Merchant-owned or merchant-authorized system of record for catalog, price, inventory, order, fulfillment, refund, settlement, or support state. |
| Commerce Capability | Bounded action or data surface that may be exposed to agents. |
| Consent Grant | Buyer authorization for a scoped commerce action. |
| Evidence Envelope | Redacted, signed or unsigned structured evidence of consent, policy, state, and audit references. |
| Refusal | Structured denial of an action with a safe reason code and optional remediation. |

## Candidate Table Of Contents

1. Introduction.
2. Terminology.
3. Roles and trust boundaries.
4. Architecture overview.
5. Merchant capability discovery.
6. Buyer-agent session envelope.
7. Consent and scoped authority.
8. Merchant policy evaluation.
9. Cart, checkout, and payment safety preconditions.
10. Connector source metadata and source-of-truth precedence.
11. Evidence envelope.
12. Refusal and error semantics.
13. Interoperability with existing protocol surfaces.
14. Security considerations.
15. Privacy considerations.
16. Operational considerations.
17. IANA considerations.
18. Implementation status.
19. References.

## Core Message Concepts

### Capability Profile

The capability profile describes what an agent may read or request. It must
distinguish:

- read-only capabilities;
- consent-required capabilities;
- merchant-review-required capabilities;
- checkout/payment-capable states;
- blocked capabilities;
- environment restrictions;
- freshness requirements;
- channel restrictions.

### Buyer Session Envelope

The buyer session envelope should contain:

- session identifier;
- buyer-agent identifier;
- channel identifier;
- requested action;
- merchant reference;
- capability snapshot reference;
- consent requirement;
- refusal code when blocked;
- redacted evidence reference.

### Evidence Envelope

The evidence envelope should contain:

- evidence type;
- actor identifiers;
- merchant reference;
- capability reference;
- policy version;
- consent reference;
- cart or request hash where applicable;
- amount cap where applicable;
- idempotency reference where applicable;
- audit references;
- generated timestamp;
- signature status.

Evidence examples must use synthetic identifiers only.

## Refusal Semantics

Refusals are first-class protocol results. Refusal reasons should include:

- merchant_not_approved;
- public_discovery_disabled;
- channel_not_enabled;
- capability_not_enabled;
- consent_required;
- consent_denied;
- policy_denied;
- stale_catalog;
- stale_inventory;
- price_changed;
- checkout_not_enabled;
- payment_provider_not_ready;
- live_payment_not_enabled;
- connector_source_blocked;
- merchant_private_api_not_allowed;
- provider_call_not_allowed;
- unsupported_action.

## Interoperability Mapping

| Surface | Mapping posture |
| --- | --- |
| schema.org JSON-LD | Public-safe product/offer/return/shipping metadata generated from approved canonical state. |
| UCP-style capability profile | Capability discovery view generated from canonical merchant policy and channel state. |
| ACP-style checkout shape | Cart/checkout state shape generated only when consent and provider prerequisites exist. |
| AP2-style evidence | Consent, scope, policy, audit, amount, and cart evidence that may later support signed mandate flows. |
| MCP/native API | Tool calls backed by merchant-control-plane policy, tenant boundary, and audit. |
| Merchant connectors | Metadata and governed sync state, never direct agent execution of private merchant APIs. |

## Security Considerations Draft Notes

The draft must discuss:

- malicious or compromised buyer agents;
- prompt injection from merchant/catalog content;
- stale catalog, price, and inventory;
- overbroad consent;
- replay and idempotency;
- cross-tenant access;
- capability overexposure;
- credential leakage;
- provider boundary bypass;
- audit tampering;
- direct merchant private API execution by agents;
- public-discovery misconfiguration.

## Privacy Considerations Draft Notes

The draft must discuss:

- data minimization;
- separation of public merchant fields from private artifacts;
- redacted evidence;
- raw payload avoidance;
- buyer consent records;
- retention and deletion policy dependencies;
- channel identity binding;
- sensitive category restrictions.

## IANA Considerations Draft Notes

Initial draft posture:

No IANA action is requested in the first individual Internet-Draft. Future
versions may request registries only after the message shapes stabilize.

## Implementation Status Draft Notes

The implementation status section may cite Grantex and AgenticOrg only as
non-normative implementation experience. It must say:

- implementation is internal/preview unless separately approved;
- conformance fixtures are preview-only;
- no public protocol publication has occurred;
- no certification is claimed;
- live payment/provider execution remains separately gated.

## Pre-Submission Checklist

- Public-safe examples use synthetic identifiers only.
- All Grantex-specific names are examples, not protocol requirements.
- All IETF boilerplate is correct.
- IPR/legal review complete.
- Security considerations are substantive.
- Privacy considerations are substantive.
- No certification, approval, or standards status is claimed.
- No production configs, allowlists, credentials, or private merchant details
  appear in examples.
- External submission is explicitly approved before using IETF Datatracker.

## Stop Conditions

Stop drafting if any change:

- claims IETF adoption, RFC approval, or standards-track status;
- submits externally without approval;
- exposes real merchant/private data;
- enables public discovery, checkout/payment, live provider, or production
  allowlist behavior;
- treats Grantex implementation details as mandatory protocol requirements.
