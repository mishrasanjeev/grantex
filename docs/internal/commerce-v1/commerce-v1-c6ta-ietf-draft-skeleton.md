# Commerce V1 C6Ta - IETF Draft Skeleton

Status: internal draft-preparation note only.

Created: 2026-06-09.

C6Ta creates the first internal IETF Internet-Draft skeleton for Agentic
Commerce Trust Architecture. It uses the C6T publication-readiness plan, the
IETF candidate outline, and the consolidated Commerce V1 PRD as source
material.

This package is not an IETF submission, not a NIST submission, not public
protocol publication, not certification, not production authorization, not
public discovery authorization, not checkout/payment authorization, not
provider authorization, and not live-payment authorization.

This package does not deploy, merge, create cloud resources, change production
configuration, touch secrets, enable public discovery, enable production
Commerce V1, enable checkout or payment creation, enable live payments, enable
live Plural, call payment providers, call merchant private APIs, set production
allowlists, or claim certification.

## Scope

C6Ta adds two docs-only artifacts:

- `docs/internal/commerce-v1/standards/draft-mishra-agentic-commerce-trust-architecture-00.md`;
- `docs/internal/commerce-v1/commerce-v1-c6ta-ietf-draft-skeleton.md`.

No runtime files, routes, migrations, workflows, jobs, provider adapters,
secrets, production configuration, public documentation publication, cloud
resources, discovery settings, checkout/payment behavior, live-provider
behavior, or production allowlists are added.

## Source Traceability

| Source | C6Ta use |
| --- | --- |
| `commerce-v1-c6t-ietf-nist-publication-readiness.md` | Uses C6T IETF track, publication framing, evidence base, cross-track guardrails, and stop conditions. |
| `commerce-v1-ietf-agentic-commerce-trust-architecture-draft-outline.md` | Expands the candidate outline into a first internal draft skeleton with section stubs and synthetic examples. |
| `commerce-v1-agentic-commerce-prd.md` | Aligns the skeleton with canonical commerce model, safety gates, adapter posture, and non-certification language. |
| `GRANTEX_COMMERCE_V1_BUILD_SPEC.md` | Preserves consent, policy, audit, provider-boundary, no-direct-provider, no-direct-merchant-private-API, and no-certification boundaries. |

## Traceability Matrix

| Requirement | Artifact coverage | Status |
| --- | --- | --- |
| Draft title and candidate filename | Draft header names `Agentic Commerce Trust Architecture` and `draft-mishra-agentic-commerce-trust-architecture-00`. | Complete |
| Internal-only status | Draft status says internal skeleton only, not submitted, not adopted, not RFC, not a standard. | Complete |
| Abstract and introduction | Draft sections `Abstract` and `1. Introduction`. | Complete |
| Terminology | Draft section `2. Terminology`. | Complete |
| Roles and trust boundaries | Draft section `3. Roles and Trust Boundaries` covers buyer, buyer agent, merchant, merchant control plane, agent platform, connector source, payment provider, and auditor/operator. | Complete |
| Architecture overview | Draft section `4. Architecture Overview`. | Complete |
| Discovery and capability profile | Draft section `5. Discovery and Capability Profile`. | Complete |
| Buyer-agent session envelope | Draft section `6. Buyer-Agent Session Envelope`. | Complete |
| Consent and scoped authority | Draft section `7. Consent and Scoped Authority`. | Complete |
| Merchant policy evaluation | Draft section `8. Merchant Policy Evaluation`. | Complete |
| Cart/checkout/payment safety preconditions | Draft section `9. Cart, Checkout, and Payment Safety Preconditions`. | Complete |
| Connector source metadata and source-of-truth precedence | Draft section `10. Connector Source Metadata and Source-of-Truth Precedence`. | Complete |
| Evidence envelope | Draft section `11. Evidence Envelope`. | Complete |
| Refusal and error semantics | Draft section `12. Refusal and Error Semantics`. | Complete |
| Interoperability mapping | Draft section `13. Interoperability Mapping` covers schema.org JSON-LD, UCP-style capability profile, ACP-style checkout shape, AP2-style evidence, MCP/native API, and merchant connector metadata. | Complete |
| Security considerations | Draft section `14. Security Considerations`. | Complete |
| Privacy considerations | Draft section `15. Privacy Considerations`. | Complete |
| Operational considerations | Draft section `16. Operational Considerations`. | Complete |
| IANA considerations | Draft section `17. IANA Considerations`, initially no IANA action requested. | Complete |
| Non-normative implementation status | Draft section `18. Implementation Status`. | Complete |
| References placeholder | Draft section `19. References`. | Complete |

## Terminology Summary

The skeleton defines the protocol roles as generic concepts:

- buyer;
- buyer agent;
- merchant;
- merchant control plane;
- agent platform;
- connector source;
- payment provider;
- auditor/operator.

Supporting terms include capability profile, consent grant, evidence envelope,
and refusal. These terms are written generically and do not make Grantex,
AgenticOrg, a payment provider, or a connector source mandatory.

## Interoperability Posture

C6Ta keeps the C6T adapter position:

- schema.org JSON-LD is a public-safe metadata adapter;
- UCP-style capability profile is a capability-discovery adapter;
- ACP-style checkout shape is a cart/checkout-state adapter;
- AP2-style evidence is a future mandate-evidence input adapter;
- MCP/native API is a tool/API transport adapter;
- merchant connector metadata is a source-health and source-precedence adapter.

The skeleton does not say merchants can ignore those surfaces. It says the
trust architecture maps canonical merchant state into existing surfaces through
adapters and does not claim conformance or certification.

## Synthetic Example Policy

The draft skeleton uses synthetic identifiers only, such as:

- `merchant.example.001`;
- `buyer_example_001`;
- `agent_example_001`;
- `platform_example_001`;
- `sess_example_001`;
- `ev_example_decision_001`;
- `policy_example_v1`.

No real merchant name, production identifier, private URL, secret, credential,
raw payload, provider metadata, concrete allowlist, or production config value
is included.

## Security and Privacy Coverage

The draft skeleton includes security consideration placeholders for:

- malicious or compromised buyer agents;
- prompt injection from merchant or connector content;
- stale catalog, price, inventory, delivery, and support state;
- overbroad consent;
- replay and idempotency;
- cross-tenant and cross-merchant exposure;
- capability overexposure;
- credential or secret leakage;
- direct provider-boundary bypass;
- direct merchant private API execution;
- audit tampering;
- public discovery misconfiguration.

Privacy consideration placeholders cover data minimization, public/private
field separation, redacted evidence, raw payload avoidance, buyer consent
records, channel identity binding, retention/deletion dependencies, sensitive
category restrictions, and safe operator visibility.

## Stop Conditions

Stop and require a new explicitly authorized work item if any follow-up:

- submits the draft externally;
- requests IETF adoption, RFC approval, standards-track handling, or IANA
  registration;
- publishes public protocol materials;
- claims IETF, RFC, NIST, NCCoE, UCP, ACP, AP2, schema.org, MPP, A2A,
  provider, or live-payment approval;
- claims certification or conformance;
- treats Grantex or AgenticOrg behavior as mandatory protocol behavior;
- exposes real merchant data, private artifacts, secrets, credentials, raw
  payloads, private URLs, concrete allowlists, production config values, or
  provider metadata;
- enables public discovery, production Commerce V1, checkout/payment creation,
  live payments, live Plural, provider calls, merchant private API calls, or
  production allowlists.

## Validation Plan

C6Ta validation:

```bash
git diff --check origin/main...HEAD
```

Focused scans must cover:

- secrets, credentials, tokens, private URLs, raw payloads, provider metadata,
  real merchant details, and production identifiers;
- production config, production allowlists, public discovery,
  checkout/payment, live provider, live Plural, provider calls, and merchant
  private API enablement;
- IETF, RFC, standards-track, certification, conformance, compliance,
  provider, or live-payment overclaims.

## Rollback

C6Ta is docs-only. Roll back by removing:

- `docs/internal/commerce-v1/standards/draft-mishra-agentic-commerce-trust-architecture-00.md`;
- `docs/internal/commerce-v1/commerce-v1-c6ta-ietf-draft-skeleton.md`.

No cloud action, deployment action, secret rotation, migration, route removal,
production configuration change, public discovery change, checkout/payment
change, live-provider change, merchant private API change, production allowlist
change, or external standards action is required.
