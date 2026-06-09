# Commerce V1 C6T - IETF And NIST Publication Readiness Plan

Status: internal publication-readiness plan only.

Created: 2026-06-09.

This C6T plan turns the existing Agentic Commerce open-protocol work into two
reviewable external-facing tracks:

- an IETF Internet-Draft candidate for the protocol-level trust architecture;
- a NIST-facing security and risk reference-architecture whitepaper candidate.

This plan is not an IETF submission, not a NIST submission, not public protocol
publication, not certification, not production approval, not public discovery
approval, and not checkout or payment approval.

This plan does not deploy, merge, create cloud resources, change production
configuration, touch secrets, enable public discovery, enable production
Commerce V1, enable checkout or payment creation, enable live payments, call
providers, call merchant private APIs, or claim certification.

## External Process Facts

These facts shape the publication path:

- IETF Internet-Drafts are working documents for review and comment. They have
  no formal standing unless adopted by an IETF working group or approved as an
  RFC. Source: https://www.ietf.org/how/ids/
- Anyone can author and submit an Internet-Draft. If the goal is an Internet
  Standard RFC, the work must follow the IETF standards process and find the
  appropriate IETF community path. Source:
  https://www.ietf.org/process/new-work/
- IETF standards work usually starts as an Internet-Draft and may progress only
  if there is consensus and sustained community interest. Source:
  https://www.ietf.org/process/process/
- NIST's AI Risk Management Framework is voluntary guidance for managing risks
  associated with AI systems, including generative AI profile guidance. Source:
  https://www.nist.gov/itl/ai-risk-management-framework
- NIST NCCoE work is collaborative, public, and often starts with a project
  description, public comment, collaborator assembly, and a repeatable reference
  architecture or practice guide. Source:
  https://www.nccoe.nist.gov/our-approach/how-we-work

## Publication Framing

The recommended external framing is:

> Agentic Commerce Trust Architecture defines a merchant-controlled trust,
> consent, policy, audit, and evidence layer for agent-mediated commerce. It
> maps to existing commerce and agent protocols through adapters rather than
> replacing them.

Use this framing:

- protocol trust layer;
- consent and scoped authority;
- merchant policy and capability exposure;
- audit evidence envelope;
- buyer-agent session and refusal semantics;
- adapter mappings to schema.org, UCP-style discovery, ACP-style checkout
  shapes, AP2-style mandate evidence, MCP/native APIs, and merchant system
  connector metadata.

Do not use this framing:

- "standard";
- "certified";
- "NIST-approved";
- "IETF-approved";
- "AP2-compliant";
- "ACP-compliant";
- "UCP-certified";
- "schema.org-certified";
- "providers can skip other protocols";
- "production-ready";
- "live payment-ready".

## Current Evidence Base

| Area | Current evidence | Publication posture |
| --- | --- | --- |
| Buyer-agent envelope | AgenticOrg C6I buyer session orchestration is merged. | Good for IETF terminology and message-flow draft sections. |
| schema.org preview | Grantex C6J preview adapter is merged. | Good for adapter-mapping examples only; not public publication. |
| UCP-style preview | Grantex C6K preview adapter is merged. | Use as "UCP-style" internal mapping only; do not claim UCP compliance. |
| ACP-style preview | Grantex C6L checkout shape preview is merged. | Use as checkout-shape mapping only; do not claim ACP compliance. |
| AP2-style preview | Grantex C6M unsigned evidence preview is merged. | Use as mandate-evidence inspiration only; do not claim AP2 compliance. |
| Connector foundation | Grantex C6N-C6Si chain is building metadata, dry-run, review, remediation, and triage evidence. | Good for merchant-system connector governance sections; no outbound sync or credentials yet. |
| Conformance fixtures | C6Oa-C6Oe preview fixtures and gate are merged. | Good internal conformance evidence; not external certification. |
| Release rehearsal | C6Of-C6Og runbook and gap assessment are merged. | Good no-go matrix and blocker source. |

## IETF Track

Recommended working title:

`draft-mishra-agentic-commerce-trust-architecture-00`

Goal:

Define an application-layer protocol architecture and JSON/HTTP message model
for safe agent-mediated commerce. The draft should be general enough that it is
not Grantex-specific, Pine/Plural-specific, or AgenticOrg-specific.

Expected draft sections:

1. Abstract.
2. Status of This Memo and IETF boilerplate.
3. Introduction.
4. Terminology.
5. Roles:
   - buyer;
   - buyer agent;
   - merchant;
   - merchant control plane;
   - agent platform;
   - payment provider;
   - connector source;
   - auditor/operator.
6. Architecture overview.
7. Discovery and capability profile.
8. Buyer-agent session envelope.
9. Consent and scoped authority.
10. Merchant policy evaluation.
11. Cart and checkout safety preconditions.
12. Evidence envelope.
13. Connector source metadata and source-of-truth precedence.
14. Error and refusal semantics.
15. Interoperability with existing surfaces.
16. Security considerations.
17. Privacy considerations.
18. Operational considerations.
19. IANA considerations.
20. Implementation status.
21. References.

Initial likely IETF community path:

- submit as individual Internet-Draft only after public-safe review;
- discuss with application/security dispatch communities before asking for
  working-group adoption;
- avoid requesting standards-track status until at least two independent
  implementers or serious implementer interest exists.

IETF blockers:

- no public-safe Internet-Draft text exists yet;
- no external implementer feedback;
- no IPR review;
- no consensus venue selected;
- no independent interoperability evidence;
- no public conformance suite;
- protocol examples still reference Grantex-specific preview states unless
  generalized.

## NIST Track

Recommended working title:

`Securing Agentic Commerce: Reference Architecture for Consent, Merchant
Policy, Audit Evidence, and Payment Safety`

Goal:

Present a NIST-aligned security and risk reference architecture for agentic
commerce. The whitepaper should focus on risk management, controls, assurance,
and repeatable implementation guidance rather than protocol standardization.

Expected whitepaper sections:

1. Executive summary.
2. Problem statement.
3. Reference architecture.
4. Threat model.
5. Trust boundaries.
6. Actor and asset inventory.
7. Control objectives.
8. NIST AI RMF mapping.
9. NIST Cybersecurity Framework mapping.
10. Identity, consent, and authorization controls.
11. Merchant policy and capability governance.
12. Connector and source-of-truth controls.
13. Payment safety and provider-boundary controls.
14. Audit evidence and evidence retention.
15. Privacy and data minimization.
16. Incident response and rollback.
17. Conformance and test evidence.
18. Open questions for industry collaboration.
19. Appendix: implementation lessons from Grantex and AgenticOrg.

NIST/NCCoE collaboration path:

- first publish an internal/public-safe whitepaper draft;
- map it to NIST AI RMF and cybersecurity control families;
- prepare a project-description style proposal for "Securing Agentic
  Commerce";
- seek collaborators only after the scope is generalized beyond Grantex and
  AgenticOrg;
- do not claim NIST acceptance, endorsement, approval, or publication.

NIST blockers:

- no public-safe NIST whitepaper draft exists yet;
- no complete threat model matrix;
- no formal AI RMF control mapping for agentic commerce;
- no NCCoE-style project description;
- no external collaborator list or CRADA/LOI path;
- no official NIST engagement evidence;
- no approved public language.

## Cross-Track Guardrails

Every external-facing artifact must preserve these facts:

- internal preview evidence is not public protocol publication;
- preview conformance is not certification;
- sandbox data is not production approval;
- Grantex examples are implementation examples, not the protocol boundary;
- AgenticOrg must not call payment providers or merchant private APIs directly;
- live payments and live providers remain blocked until separate approvals
  exist;
- protocol adapters map from canonical merchant state and must not duplicate
  source-of-truth data;
- payment-affecting actions require consent, policy, scope, idempotency,
  revocation check, and audit evidence.

## Deliverable Plan

| Slice | Output | Scope | Stop condition |
| --- | --- | --- | --- |
| C6Ta | IETF draft skeleton and terminology alignment | Markdown/xml2rfc-ready outline, examples, no public submission | Claims IETF acceptance or certification |
| C6Tb | NIST whitepaper skeleton and control map | NIST AI RMF/CSF mapping, threat model outline | Claims NIST approval or submission |
| C6Tc | Public-safe example corpus | Generic examples derived from fixtures with Grantex/private IDs removed | Includes real merchant/private data |
| C6Td | Conformance profile split | Internal preview conformance vs public draft conformance matrix | Claims independent conformance |
| C6Te | Standards outreach packet | Mailing-list/community questions, IPR checklist, legal review checklist | Submits externally without approval |

## Publication Readiness Matrix

| Track | Current status | Readiness | Next required evidence |
| --- | --- | --- | --- |
| IETF individual Internet-Draft | Not drafted, not submitted | Preparing | Public-safe Internet-Draft text and IPR/legal review |
| IETF working-group adoption | Not started | Blocked | Community interest and appropriate venue |
| IETF RFC | Not started | Blocked | IETF consensus or Independent Stream review |
| NIST-aligned whitepaper | Not drafted | Preparing | NIST AI RMF/CSF mapping and threat model |
| NCCoE project proposal | Not started | Blocked | Generalized project description and collaborators |
| Official NIST publication | Not started | Blocked | NIST project sponsorship/process |

## Stop Conditions

Stop and require a new approved work item if any C6T follow-up:

- submits an IETF Internet-Draft;
- submits a NIST comment, project description, or collaborator request;
- claims IETF, RFC, NIST, NCCoE, UCP, ACP, AP2, schema.org, MPP, A2A,
  provider, or live-payment approval;
- publishes public protocol materials;
- exposes real merchant data, private artifacts, secrets, credentials, raw
  payloads, concrete allowlist values, production config, or provider metadata;
- enables public discovery, production Commerce V1, checkout/payment creation,
  live payments, live Plural, live providers, provider calls, merchant private
  API calls, or production allowlists;
- treats sandbox, demo, synthetic, fixture, dry-run, remediation, triage, or
  rehearsal output as production approval.

## Validation

C6T validation should include:

- `git diff --check origin/main...HEAD`;
- focused scan for standards overclaims;
- focused scan for secrets/private artifacts;
- focused scan for production config, allowlist, public discovery, checkout,
  payment, live provider, direct provider call, and merchant private API
  enablement;
- manual review that all IETF/NIST statements are framed as preparation, not
  submission or approval.

## Rollback

C6T is docs-only. Roll back by removing:

- `docs/internal/commerce-v1/commerce-v1-c6t-ietf-nist-publication-readiness.md`;
- `docs/internal/commerce-v1/commerce-v1-ietf-agentic-commerce-trust-architecture-draft-outline.md`;
- `docs/internal/commerce-v1/commerce-v1-nist-agentic-commerce-security-reference-architecture-outline.md`;
- the C6T PRD/compliance wording updates.

No runtime flags, production configuration, provider credentials, connector
credentials, public discovery settings, checkout/payment behavior,
live-provider behavior, production allowlists, cloud resources, migrations,
routes, portal UI changes, public docs publication, external submission, or
deployment workflow changes are created by this package.
