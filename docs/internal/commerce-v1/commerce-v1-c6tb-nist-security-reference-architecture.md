# Commerce V1 C6Tb - NIST Security Reference Architecture Skeleton

Status: internal draft-preparation note only.

Created: 2026-06-09.

C6Tb creates the first internal NIST-aligned whitepaper skeleton for `Securing
Agentic Commerce: Reference Architecture for Consent, Merchant Policy, Audit
Evidence, and Payment Safety`. It uses the C6T publication-readiness plan, the
C6T NIST candidate outline, the C6Ta IETF trust-architecture skeleton, the
consolidated Commerce V1 PRD, and the Commerce V1 build spec as source
material.

This package is not a NIST submission, not an IETF submission, not accepted by
NCCoE, not NIST-approved, not public guidance, not public protocol publication,
not certification, not production authorization, not public discovery
authorization, not checkout/payment authorization, not provider authorization,
and not live-payment authorization.

This package does not deploy, merge, create cloud resources, change production
configuration, touch secrets, enable public discovery, enable production
Commerce V1, enable checkout or payment creation, enable live payments, enable
live Plural, call payment providers, call merchant private APIs, set production
allowlists, or claim certification.

## Scope

C6Tb adds two docs-only artifacts:

- `docs/internal/commerce-v1/standards/nist-agentic-commerce-security-reference-architecture.md`;
- `docs/internal/commerce-v1/commerce-v1-c6tb-nist-security-reference-architecture.md`.

No runtime files, routes, migrations, workflows, jobs, provider adapters,
tests, portal UI, secrets, production configuration, public documentation
publication, cloud resources, discovery settings, checkout/payment behavior,
live-provider behavior, or production allowlists are added.

## Source Traceability

| Source | C6Tb use |
| --- | --- |
| `commerce-v1-c6t-ietf-nist-publication-readiness.md` | Uses C6T NIST track, publication framing, evidence base, cross-track guardrails, stop conditions, and rollback posture. |
| `commerce-v1-nist-agentic-commerce-security-reference-architecture-outline.md` | Expands the candidate NIST whitepaper outline into a first internal reference-architecture skeleton. |
| `standards/draft-mishra-agentic-commerce-trust-architecture-00.md` | Reuses generic role, trust-boundary, consent, policy, provider-boundary, connector-source, evidence, refusal, and adapter concepts. |
| `commerce-v1-agentic-commerce-prd.md` | Aligns standards posture, launch blockers, Grantex/AgenticOrg responsibility split, direct-provider bans, and no-certification language. |
| `GRANTEX_COMMERCE_PRD.md` | Preserves long-range agentic commerce context while keeping this package internal and preparation-only. |
| `GRANTEX_COMMERCE_V1_BUILD_SPEC.md` | Preserves V1 safety controls for consent, policy, tenant boundary, audit, provider-neutral boundaries, no direct provider calls, no direct merchant private API calls, and no live-payment enablement. |

## Traceability Matrix

| Requirement | Artifact coverage | Status |
| --- | --- | --- |
| Status statement | Standard skeleton header says internal draft only, not submitted to NIST, not accepted by NCCoE, not NIST-approved, not public guidance, and not certification. | Complete |
| Executive summary | Standard skeleton section `1. Executive Summary`. | Complete |
| Problem statement | Standard skeleton section `2. Problem Statement`. | Complete |
| Scope and assumptions | Standard skeleton section `3. Scope and Assumptions`. | Complete |
| Reference architecture with Mermaid diagram | Standard skeleton section `4. Reference Architecture`. | Complete |
| Actor and asset inventory | Standard skeleton section `5. Actor and Asset Inventory`. | Complete |
| Trust boundaries | Standard skeleton section `6. Trust Boundaries`. | Complete |
| Threat model | Standard skeleton section `7. Threat Model` covers malicious/compromised buyer agents, prompt injection, stale catalog/price/inventory, overbroad consent, cross-tenant exposure, provider-boundary bypass, merchant private API exposure, audit tampering, unsafe public discovery, and synthetic/demo evidence treated as approval. | Complete |
| Control objectives | Standard skeleton section `8. Control Objectives`. | Complete |
| NIST AI RMF mapping | Standard skeleton section `9. NIST AI RMF Mapping` covers Govern, Map, Measure, and Manage. | Complete |
| Cybersecurity control themes | Standard skeleton section `10. Cybersecurity Control Themes` covers identity/access, least privilege, data minimization, credential protection, auditability, integrity, resilience, and incident response. | Complete |
| Agentic Commerce safety controls | Standard skeleton section `11. Agentic Commerce Safety Controls`. | Complete |
| Payment safety and provider-boundary controls | Standard skeleton section `12. Payment Safety and Provider-Boundary Controls`. | Complete |
| Privacy and data minimization | Standard skeleton section `13. Privacy and Data Minimization`. | Complete |
| Audit evidence and evidence retention | Standard skeleton section `14. Audit Evidence and Evidence Retention`. | Complete |
| Incident response and rollback | Standard skeleton section `15. Incident Response and Rollback`. | Complete |
| Assurance evidence | Standard skeleton section `16. Assurance Evidence`. | Complete |
| Residual risks and blocked production gates | Standard skeleton section `17. Residual Risks and Blocked Production Gates`. | Complete |
| NIST/NCCoE engagement plan | Standard skeleton section `18. NIST/NCCoE Engagement Plan`. | Complete |
| Open questions for external collaboration | Standard skeleton section `19. Open Questions for External Collaboration`. | Complete |
| References placeholder | Standard skeleton section `20. References Placeholder`. | Complete |

## NIST Reference Architecture Summary

The skeleton frames agentic commerce as a governed security architecture with
distinct buyer, buyer-agent, agent-platform, merchant-control-plane,
connector-source, payment-provider, reviewer/operator, and audit/evidence-store
boundaries.

The reference architecture keeps protected commerce actions behind a merchant
control plane. Agent platforms request actions and receive safe results or
refusals; they do not become the merchant source of truth, do not call payment
providers directly, and do not call merchant private APIs directly.

The Mermaid diagram shows buyer-agent requests flowing through an agent
platform into a merchant control plane, where consent/passport verification,
merchant policy, connector governance, provider-boundary controls, and audit
evidence mediate the action.

## Threat Model Summary

The threat model covers:

- malicious or compromised buyer agents;
- prompt injection through product, support, connector, or channel content;
- stale catalog, price, inventory, delivery, refund, or support facts;
- overbroad or ambiguous consent;
- cross-tenant and cross-merchant data exposure;
- provider-boundary bypass;
- merchant private API exposure;
- audit tampering or missing evidence;
- unsafe public discovery;
- synthetic, demo, sandbox, dry-run, remediation, or rehearsal evidence treated
  as production approval.

Each threat maps to a control objective, such as scoped consent, tenant
isolation, connector source governance, direct-provider bans, direct-private-API
bans, append-only or durable evidence patterns, discovery approval gates, and
explicit production blockers.

## NIST AI RMF and Control Mapping Summary

The AI RMF alignment is internal and preparatory:

- Govern: owner roles, stop conditions, production gates, policy authority, and
  rollback ownership;
- Map: actor inventory, asset inventory, trust boundaries, data flows, source
  systems, providers, and channels;
- Measure: C6O conformance gate, refusal tests, tenant-boundary tests,
  secret/private scans, connector dry-run/remediation evidence, and audit
  tests;
- Manage: incident response, revocation, emergency disable, discovery rollback,
  connector quarantine, residual risk tracking, and rollback rehearsal.

The cybersecurity control themes cover identity/access, least privilege, data
minimization, credential protection, auditability, integrity, resilience, and
incident response.

## Standards and Engagement Posture

C6Tb remains preparation-only:

- no NIST submission;
- no NIST public-comment submission;
- no NCCoE acceptance;
- no NIST approval;
- no public guidance publication;
- no IETF submission;
- no public protocol publication;
- no certification, conformance, or compliance claim;
- no provider approval;
- no live-payment approval;
- no production approval.

Grantex and AgenticOrg appear only as non-normative implementation examples.
The skeleton does not describe them as mandatory architecture participants,
certified implementations, official NIST participants, or external approval
sources.

## Private Data and Synthetic Example Policy

The C6Tb skeleton does not include real merchant names, production identifiers,
private URLs, secrets, credentials, raw payloads, provider metadata, concrete
allowlists, or production config values.

Where examples are needed, use synthetic identifiers only, such as:

- `merchant.example.001`;
- `buyer_example_001`;
- `agent_example_001`;
- `platform_example_001`;
- `source_example_001`;
- `policy_example_v1`;
- `evidence_example_001`.

The standard skeleton currently avoids concrete payload examples and instead
uses tables, control objectives, and review checklists.

## Stop Conditions

Stop and require a new explicitly authorized work item if any follow-up:

- submits material to NIST;
- submits a NIST public comment, project description, collaborator request, or
  NCCoE package;
- submits material to IETF;
- publishes public protocol materials or public guidance;
- claims NIST approval, NIST publication, NIST public-comment submission,
  NCCoE acceptance, IETF approval, RFC status, UCP certification, ACP
  certification, AP2 certification, schema.org certification, MPP approval, A2A
  approval, provider certification, live-payment certification, conformance, or
  compliance;
- treats Grantex or AgenticOrg behavior as mandatory security architecture
  behavior;
- exposes real merchant data, private artifacts, secrets, credentials, raw
  payloads, private URLs, concrete allowlists, production config values, or
  provider metadata;
- enables public discovery, production Commerce V1, checkout/payment creation,
  live payments, live Plural, provider calls, merchant private API calls,
  production allowlists, cloud resources, deployments, production config,
  routes, migrations, portal UI, workflows, or runtime behavior;
- treats sandbox, demo, synthetic, fixture, dry-run, remediation, triage, or
  rehearsal output as production approval.

## Validation Plan

C6Tb validation:

```bash
git diff --check origin/main...HEAD
```

Focused scans must cover:

- secrets, credentials, tokens, private URLs, raw payloads, provider metadata,
  real merchant details, production identifiers, and production config values;
- production config, production allowlists, public discovery,
  checkout/payment, live provider, live Plural, provider calls, and merchant
  private API enablement;
- NIST, NCCoE, certification, conformance, compliance, provider, public
  guidance, public-comment, public publication, or live-payment overclaims;
- real merchant names, private data, private URLs, provider credentials, raw
  payloads, concrete allowlists, and production identifiers.

## Rollback

C6Tb is docs-only. Roll back by removing:

- `docs/internal/commerce-v1/standards/nist-agentic-commerce-security-reference-architecture.md`;
- `docs/internal/commerce-v1/commerce-v1-c6tb-nist-security-reference-architecture.md`.

No cloud action, deployment action, secret rotation, migration, route removal,
production configuration change, public discovery change, checkout/payment
change, live-provider change, merchant private API change, production allowlist
change, external submission, public publication, certification action, or
NIST/NCCoE engagement action is required.
