---
title: "OAuth Profile for Delegated AI Agent Authorization"
abbrev: "DAAP"
docname: draft-mishra-oauth-agent-grants-02
category: info
submissiontype: IETF
ipr: trust200902
area: Security
workgroup: Web Authorization Protocol
date: 2026-08-30
keyword:
  - AI agents
  - authorization
  - OAuth
  - delegation
  - sender-constrained tokens

stand_alone: yes
pi: [toc, sortrefs, symrefs]

author:
  - fullname: Sanjeev Kumar
    organization: Orchestrum Technologies LLP
    email: mishra.sanjeev@gmail.com
    uri: https://grantex.dev

normative:
  RFC2119:
  RFC8174:
  RFC6749:
  RFC7517:
  RFC7518:
  RFC7519:
  RFC7636:
  RFC8414:
  RFC8693:
  RFC8705:
  RFC8707:
  RFC9068:
  RFC9126:
  RFC9449:
  RFC9700:

informative:
  RFC6234:
  RFC7942:
  RFC8725:
  RFC8785:
  RFC9396:
  I-D.ietf-oauth-identity-chaining:
  I-D.ietf-oauth-transaction-tokens:
  I-D.chen-oauth-agent-authz-use-cases:
  I-D.song-oauth-ai-agent-collaborate-authz:
  DID-CORE:
    title: "Decentralized Identifiers (DIDs) v1.0"
    target: https://www.w3.org/TR/did-core/
    author:
      org: W3C
    date: 2022-07-19

--- abstract

AI agents increasingly invoke protected APIs on behalf of human users. This
document defines an OAuth profile for identifying an agent client instance,
obtaining an authenticated user's consent, issuing resource-bound and
sender-constrained access tokens, attenuating authority through OAuth Token
Exchange, and rotating refresh tokens safely. The profile uses existing OAuth
and JOSE mechanisms wherever possible and defines no new JWT claims or OAuth
endpoints. Operational facilities such as policy engines, audit stores,
budgets, event streams, and credential vaults are outside the interoperable
core. Grantex is an incomplete reference implementation and is not required
for conformance.

--- middle

# Introduction

OAuth deployments already support software acting for users. AI agent
deployments add operational pressure because agent instances can be created
dynamically, can call high-impact APIs, and can delegate work to other agent
instances. These characteristics do not justify replacing OAuth. They do
justify a strict profile that removes unsafe choices and makes the acting
client, user, resource, and sender key explicit.

This document profiles OAuth 2.0 {{RFC6749}} and the OAuth 2.0 Security Best
Current Practice {{RFC9700}}. It uses pushed authorization requests (PAR)
{{RFC9126}}, Proof Key for Code Exchange (PKCE) {{RFC7636}}, resource indicators
{{RFC8707}}, JWT access tokens {{RFC9068}}, sender constraints, and OAuth Token
Exchange {{RFC8693}}.

The term "DAAP" is a convenient name for this profile. It is not a new
authorization framework, a new credential format, or a claim that an AI agent
is a legal person.

## Scope

This document specifies:

1. security metadata associated with an agent's OAuth client registration;
2. an authorization-code flow with authenticated human consent;
3. resource-bound, sender-constrained JWT access tokens;
4. attenuated delegation using OAuth Token Exchange; and
5. refresh-token rotation requirements, including bounded recovery from a
   lost successful response.

This document does not standardize agent orchestration, model selection,
policy languages, payments, budget ledgers, audit storage APIs, event delivery,
credential vaults, SCIM, SSO configuration, or vendor deployment endpoints.
Those features can be useful, but they require separate specifications and
security analysis.

## Discussion Venues

Discussion of this document is intended for the OAuth Working Group mailing
list at `oauth@ietf.org`. The archive is at
`https://mailarchive.ietf.org/arch/browse/oauth/`.

Author contact:

* Primary: `mishra.sanjeev@gmail.com`
* Alternate: `sanjeev@orchestrum.in`

Source and issue tracking are maintained at
`https://github.com/mishrasanjeev/grantex/tree/main/docs/ietf-draft`.

## Changes Since -01

Revision -02:

* narrows the document to an OAuth profile and removes proprietary Grantex
  endpoint paths from the normative protocol;
* requires authenticated human consent and prohibits policy automation from
  impersonating that consent;
* requires exact redirect URI matching, `state`, PKCE S256, PAR, and a resource
  indicator;
* requires sender-constrained access and refresh tokens;
* uses the standard `scope`, `client_id`, `cnf`, and `act` claims rather than
  registering duplicate short claims;
* defines safety properties for bounded lost-response refresh recovery;
* makes DID use optional and requires proof of possession for any advertised
  agent key;
* moves audit, budget, policy, events, and credential-vault behavior outside
  the interoperable core; and
* reports the Grantex implementation as partial rather than conformant.

## Requirements Language

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in BCP 14
{{RFC2119}} {{RFC8174}} when, and only when, they appear in all capitals, as
shown here.

## Terminology

This document uses the OAuth roles defined by {{RFC6749}} and the following
terms:

Agent:
: Software that plans or performs actions. An Agent is not itself an OAuth
  role.

Agent Client Instance:
: An OAuth client instance that executes agent software. Its OAuth `client_id`
  identifies its registration, not a human or legal identity.

Principal:
: The human resource owner whose authority is delegated. A deployment can use
  a non-human resource owner only when its trust and authorization model is
  defined outside this profile.

Agent Key:
: An asymmetric key controlled by the Agent Client Instance and used for DPoP
  or mutual-TLS sender constraint.

Delegated Token:
: An access token issued by OAuth Token Exchange whose authority is derived
  from another token and attenuated in scope, resource, lifetime, or all three.

# Security Model

The authorization server is trusted to authenticate the Principal, display an
accurate authorization request, enforce registered client metadata, issue
tokens, and process revocation. A resource server is trusted to validate tokens
and enforce scopes for its own resource identifier.

An Agent Client Instance is not trusted merely because a developer registered
it or supplied an API key. Developer authentication and Principal
authentication are separate security events. A developer credential MUST NOT
be accepted as proof that the Principal approved a live authorization request.

For a live authorization, the authorization server MUST authenticate the
Principal using a method appropriate to the risk of the requested authority.
Phishing-resistant authentication is RECOMMENDED for high-impact scopes.
Sandbox deployments MAY use test principals and simulated consent when they
are clearly isolated from production resources and credentials.

An automated policy decision MAY deny, narrow, or require escalation of a
request. It MUST NOT replace the Principal's authenticated approval unless a
separate, explicitly authorized non-human resource-owner model applies.

# Agent Client Registration

An Agent Client Instance uses an OAuth client registration. Registration can
be provisioned administratively or by a standards-based dynamic registration
mechanism; the registration wire protocol is outside this document.

The registration MUST bind:

* one or more exact redirect URIs for authorization-code clients;
* the resources the client is permitted to request;
* the scopes the client is permitted to request; and
* key metadata sufficient to sender-constrain tokens.

The authorization server MUST reject redirect URIs containing fragments and
MUST apply the redirect URI rules from {{RFC9700}}. Production web redirect
URIs MUST use HTTPS, except for loopback redirects explicitly permitted for
native applications.

The Agent Key MUST be asymmetric. The registration MUST NOT contain private
key parameters. Before treating a key as controlled by an Agent Client
Instance, the authorization server MUST verify possession through DPoP
{{RFC9449}}, mutual TLS {{RFC8705}}, or another protocol that proves possession
of the corresponding private key.

## Optional DID Association

A deployment MAY associate an Agent Client Instance with a DID {{DID-CORE}}.
DID support is not required by this profile. If a DID is placed in a token or
shown to a Principal, it MUST resolve to a document that contains the verified
Agent Key or a verifiable delegation to that key. An opaque database identifier
with a `did:` prefix is not sufficient.

Key rotation MUST preserve an auditable relationship between the old and new
keys, invalidate future use of the retired key, and avoid silently changing the
meaning of already-issued sender-constrained tokens.

# Authorization

## Pushed Authorization Request

Clients conforming to this profile MUST use PAR {{RFC9126}}. The pushed request
MUST contain, at minimum:

* `client_id`;
* `response_type=code`;
* an exact registered `redirect_uri`;
* `scope`;
* a high-entropy `state` value;
* `code_challenge` and `code_challenge_method=S256`; and
* exactly one `resource` value identifying the target resource server.

The authorization server MUST reject an unregistered redirect URI, a resource
outside the client's registration, or a scope outside the client's registered
scope set. It MUST NOT apply prefix, wildcard, or substring matching to a
redirect URI.

The client then sends the returned `request_uri` to the authorization endpoint
as defined by {{RFC9126}}. The authorization endpoint MUST reject a request URI
that is expired, already consumed where single use is enforced, issued to a
different client, or altered.

## Principal Interaction

The authorization server MUST authenticate the Principal independently of the
developer or Agent Client Instance. The consent view MUST show, in language the
Principal can understand:

* the Agent Client Instance and responsible developer;
* the target resource;
* the requested scopes and their consequences;
* the requested duration; and
* material delegation or transaction constraints.

Approval and denial MUST both be bound to the authenticated Principal and the
specific authorization request. The authorization server MUST prevent login
CSRF, consent CSRF, clickjacking, and reuse of approval artifacts.

The client MUST verify that the returned `state` exactly matches its stored
value before exchanging the authorization code.

## Authorization Code Exchange

The client exchanges the authorization code at the OAuth token endpoint using
`grant_type=authorization_code`, the code, the same `redirect_uri`, and the
PKCE `code_verifier`.

The authorization server MUST:

1. authenticate or otherwise identify the client as required for its client
   type;
2. require exact `redirect_uri` equality with the authorization request;
3. validate the S256 verifier;
4. bind the code to the client, Principal, resource, and approved scopes; and
5. consume the code atomically with successful token issuance.

An error while signing or storing tokens MUST leave the authorization code
usable for a later retry or MUST produce an unambiguous terminal error. It MUST
NOT create a partially committed grant.

# Access Tokens

Authorization servers conforming to this profile issue JWT access tokens
{{RFC7519}} as profiled by {{RFC9068}}. The JWK Set requirements of {{RFC7517}},
the JOSE requirements of {{RFC7518}}, JWT validation
guidance in {{RFC8725}}, and authorization-server metadata in {{RFC8414}}
apply.

The authorization server metadata MUST publish a `jwks_uri`. A JWKS document
alone is not authorization-server metadata and MUST NOT be described as
conformance with {{RFC8414}}.

## Claims

The token MUST contain the claims required by {{RFC9068}}, including `iss`,
`sub`, `aud`, `exp`, `iat`, `jti`, and `client_id`. Granted scopes MUST use the
standard space-delimited `scope` claim.

`aud` MUST identify the single resource requested during authorization. Tokens
without the expected audience MUST be rejected by the resource server.

The token MUST be sender-constrained:

* a DPoP-bound token carries the public-key thumbprint in `cnf.jkt` as defined
  by {{RFC9449}}; or
* an mTLS-bound token carries the certificate thumbprint in `cnf` as defined by
  {{RFC8705}}.

An authorization server MUST NOT emit `cnf` solely because a public key was
uploaded. It MUST first establish proof of possession. The resource server MUST
verify the DPoP proof or mutual-TLS binding on every protected request.

This profile defines no short aliases for `scope`, `client_id`, `act`, or
`authorization_details`. Private implementation claims MAY be used only under
collision-resistant names and MUST NOT be required for interoperability.

## Validation

A resource server MUST validate at least:

1. an explicitly allowed signature algorithm and a valid signature;
2. `iss` against the configured authorization server;
3. `aud` against the resource server's identifier;
4. `exp`, `iat`, and any applicable not-before constraint;
5. the required values in `scope`;
6. the sender constraint represented by `cnf`; and
7. revocation or token status when the deployment's risk model requires online
   state.

The resource server MUST NOT treat signature verification alone as sufficient
authorization.

# Delegation

Delegation uses OAuth Token Exchange {{RFC8693}}. The delegating token is the
`subject_token`. When an agent or service is acting as a distinct actor, the
authorization server represents that chain using the standard `act` claim.

The authorization server MUST authenticate the requesting client and validate
the subject token before exchange. It MUST reject a requested scope that is not
contained in the subject token, and it MUST reject a resource that is broader
than or inconsistent with the original authorization.

A delegated token:

* MUST NOT expire later than the subject token;
* MUST be sender-constrained to the receiving Agent Client Instance;
* MUST use a scope set no broader than the subject token;
* MUST preserve the Principal as `sub` unless another specification defines a
  subject transition; and
* MUST represent the current actor and any nested actor chain as specified by
  {{RFC8693}}.

Deployments SHOULD bound delegation depth and SHOULD support revoking all
tokens derived from a root authorization. Database parent identifiers and
cascade algorithms are implementation details, not JWT claims defined here.

Cross-domain delegation should be evaluated against OAuth Identity and
Authorization Chaining {{I-D.ietf-oauth-identity-chaining}} rather than creating
an incompatible chain format.

# Refresh Tokens

Refresh-token handling MUST follow {{RFC9700}}. Public clients MUST use refresh
token rotation or sender-constrained refresh tokens. This profile requires
both rotation and sender constraint for Agent Client Instances.

On a successful refresh, the authorization server MUST invalidate the
presented refresh token and return a new refresh token atomically. The new
access token MUST NOT expand the original resource, scope, delegation, sender
binding, or grant lifetime.

## Lost-Response Recovery

Network failure can occur after the authorization server commits rotation but
before the client receives the response. A deployment MAY provide bounded
recovery for this case. The transport syntax for a recovery key is an
implementation extension and is not part of core conformance.

If recovery is provided, all of the following requirements apply:

1. Before its first attempt, the client generates a high-entropy recovery key
   and persists it with the old refresh token until the response is durable.
2. Every transport retry of that same refresh request uses the same recovery
   key. A new logical refresh operation uses a new key.
3. The authorization server binds recovery state to the authenticated client,
   Agent Client Instance, old refresh token, and recovery key.
4. Recovery returns the exact committed access token and rotated refresh token;
   it MUST NOT mint a new token, extend a lifetime, or rotate again.
5. Recovery is allowed only while the rotated child refresh token is active and
   unused.
6. The recovery window MUST be short and bounded. This profile RECOMMENDS no
   more than 300 seconds.
7. A different or missing recovery key, an expired recovery window, or an
   already-used child token is treated as refresh-token reuse and MUST fail.

A server crash before transaction commit leaves the old token unused and the
client can retry normally. A crash after commit is the lost-response case above
and requires durable recovery state. Implementations MUST test both boundaries.

# Operational Extensions

The following topics are intentionally outside core conformance:

* tamper-evident audit storage and external witnessing;
* policy decision points and policy languages;
* financial budgets and atomic debit ledgers;
* event streams and webhooks;
* credential vaults;
* anomaly detection; and
* enterprise provisioning and SSO configuration.

An implementation MUST NOT claim that an operator-signed hash chain is
operator-independent evidence. Such a claim requires publication to or
countersignature by an independent witness. If JSON records are hashed across
implementations, canonicalization should use the JSON Canonicalization Scheme
{{RFC8785}} and SHA-256 should be specified using {{RFC6234}}.

Financial constraints should use structured authorization details
{{RFC9396}}, including an unambiguous amount representation and currency,
rather than a bare numeric JWT claim.

Potential extension documents are listed in the source repository. Their
presence does not imply IETF submission, adoption, or interoperability.

# Security Considerations

The OAuth threat model and mitigations in {{RFC9700}} apply. This section calls
out agent-specific consequences.

## Consent Substitution

A developer API key, policy-engine decision, or agent assertion is not the
Principal's consent. Conflating these identities lets the party requesting
authority approve its own request. Live consent therefore requires independent
Principal authentication and request-bound approval.

## Redirect and Authorization Request Integrity

Exact redirect matching, PAR, PKCE S256, and `state` are mandatory. These
controls address different attacks and are not substitutes for one another.
Clients MUST keep `state`, the PKCE verifier, and the PAR request association
confidential until the flow completes.

## Audience and Sender Binding

Bearer tokens are especially hazardous for autonomous software because agents
may pass data through tools, logs, prompts, and subprocesses. Resource binding
limits where a token can be used; sender constraint limits who can use it.
This profile requires both.

## Agent-Key Enrollment

Accepting an uploaded public key without proof of possession enables an
attacker to register somebody else's key or create unusable identities.
Authorization servers MUST verify possession and MUST define secure key
rotation and recovery procedures.

## Delegation

Every delegation hop increases the attack surface. Scope and resource
attenuation, bounded lifetime, sender constraint, depth limits, and root
revocation SHOULD be enforced together. A textual claim that an agent is a
sub-agent is not sufficient.

## Refresh Reuse

Recovery must not become a replay grace period. Only the same authenticated and
request-bound retry can receive the previously committed response. Any other
reuse can indicate token theft and SHOULD trigger family revocation or another
risk-appropriate incident response.

## Logging

Authorization servers and resource servers MUST NOT log authorization codes,
refresh tokens, access tokens, DPoP private keys, PKCE verifiers, recovery keys,
or upstream credentials. Security logs SHOULD record enough non-secret context
to investigate consent, delegation, refresh reuse, and revocation events.

# Privacy Considerations

Agent authorization data can reveal a Principal's services, activities,
relationships, and intended actions. Implementations SHOULD minimize token
claims and consent records, use pairwise subject identifiers where appropriate,
and avoid placing personal data in globally resolvable agent documents.

Resource indicators and fine-grained scopes can themselves be sensitive. They
SHOULD be disclosed only to parties that require them. Audit retention and
export must have a defined purpose, access policy, retention period, and
deletion process.

Delegation chains reveal relationships among services and actors. A resource
server should receive only the chain information needed for its authorization
decision.

# IANA Considerations

This document requests no IANA actions. It uses claims, parameters, endpoints,
and confirmation methods defined by existing OAuth and JOSE specifications.
Any future wire-level recovery key or agent-specific authorization detail will
require separate specification and appropriate registry review.

# Relationship to Other Work

OAuth Identity and Authorization Chaining Across Domains
{{I-D.ietf-oauth-identity-chaining}} addresses identity and authorization
continuity across trust domains. Implementations should use that work for
cross-domain chains rather than defining private equivalents.

OAuth Transaction Tokens address short-lived, purpose-bound tokens for a
transaction {{I-D.ietf-oauth-transaction-tokens}}. They may complement this
profile for multi-service call chains; this document does not redefine
transaction tokens.

The agent authorization use-cases draft
{{I-D.chen-oauth-agent-authz-use-cases}} surveys emerging scenarios and gaps.
The multi-agent collaboration draft
{{I-D.song-oauth-ai-agent-collaborate-authz}} explores group authorization.
This profile focuses more narrowly on a high-assurance OAuth authorization and
delegation baseline and does not claim to supersede either effort.

# Implementation Status {#implementation-status}

This section follows the intent of {{RFC7942}} and is expected to be removed
before publication as an RFC.

Grantex provides an implementation-specific JSON API inspired by this profile.
As of 2026-08-30 it implements exact registered redirects and resources for
profile-aware agents, PKCE S256 checks, live-consent WebAuthn checks,
resource-bound JWTs, key-thumbprint `cnf` claims, scope attenuation,
refresh-token rotation, and bounded request-bound recovery.

It is not yet a conformant implementation of this profile. In particular, its
custom `/v1/authorize` and `/v1/token` endpoints are not the standard OAuth
authorization and token endpoints; PAR is not implemented; DPoP proofs are not
validated at protected resources; legacy agent registrations can omit profile
metadata; and live Principal passkey enrollment is not yet anchored in an
independent identity-provider ceremony. The repository's implementation report
tracks these gaps.

# Acknowledgements

The author thanks reviewers in the OAuth community whose published work on
OAuth security, identity chaining, transaction tokens, and agent authorization
helped narrow this document.

--- back

# Non-Normative Grantex Mapping

This appendix is informative. It helps reviewers compare the profile with the
Grantex reference implementation; it does not define interoperable endpoints.

| Profile operation | Grantex implementation-specific path |
|:------------------|:--------------------------------------|
| Agent registration metadata | `POST /v1/agents` |
| Authorization request | `POST /v1/authorize` |
| Principal consent | `POST /v1/consent/{id}/approve` |
| Code exchange | `POST /v1/token` |
| Refresh rotation | `POST /v1/token/refresh` |
| Token status | `POST /v1/tokens/verify` |
| Grant revocation | `DELETE /v1/grants/{id}` |
| Delegation | `POST /v1/grants/delegate` |
| Authorization-server metadata | `GET /.well-known/oauth-authorization-server` |
| Signing keys | `GET /.well-known/jwks.json` |

The implementation transports its refresh recovery key in an
`Idempotency-Key` HTTP request header. That header use is implementation
specific in this revision and is not required for DAAP core conformance.

# Candidate Extension Documents

The following subjects should be developed independently if there is community
interest:

1. externally witnessed agent audit checkpoints;
2. financial authorization details and atomic budget settlement;
3. agent delegation lifecycle and cascade revocation profiles; and
4. operational event, policy, and credential-handling interfaces.

Separating these topics keeps security assumptions, registries, and consensus
boundaries reviewable.

# Author's Address

Sanjeev Kumar

Orchestrum Technologies LLP

Email: `mishra.sanjeev@gmail.com`

Alternate email: `sanjeev@orchestrum.in`

URI: `https://grantex.dev`
