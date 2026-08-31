---
title: "OAuth Profile for Delegated AI Agent Authorization"
abbrev: "DAAP"
docname: draft-mishra-oauth-agent-grants-03
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
    country: India
    email: mishra.sanjeev@gmail.com
    uri: https://grantex.dev

normative:
  RFC2119:
  RFC6749:
  RFC7009:
  RFC7517:
  RFC7518:
  RFC7519:
  RFC7636:
  RFC8174:
  RFC8414:
  RFC8693:
  RFC8705:
  RFC8707:
  RFC8725:
  RFC9068:
  RFC9126:
  RFC9207:
  RFC9396:
  RFC9449:
  RFC9700:

informative:
  RFC6234:
  RFC7942:
  RFC8785:
  I-D.aap-oauth-profile:
  I-D.araut-oauth-transaction-tokens-for-agents:
  I-D.chen-oauth-agent-authz-use-cases:
  I-D.ietf-oauth-identity-chaining:
  I-D.ietf-oauth-refresh-token-expiration:
  I-D.ietf-oauth-security-topics-update:
  I-D.ietf-oauth-transaction-tokens:
  I-D.li-oauth-delegated-authorization:
  I-D.mcguinness-oauth-actor-profile:
  I-D.mcguinness-oauth-ai-agent-instance:
  I-D.mcguinness-oauth-client-instance-assertion:
  I-D.mw-oauth-actor-chain:
  I-D.niyikiza-oauth-attenuating-agent-tokens:
  I-D.song-oauth-ai-agent-collaborate-authz:
  I-D.valverde-oauth-pact:

--- abstract

AI agents increasingly invoke protected APIs on behalf of human users. This
document defines an OAuth profile for binding an agent client instance,
obtaining an authenticated user's consent, issuing resource-bound and
sender-constrained access tokens, attenuating authority through OAuth Token
Exchange, and rotating refresh tokens safely. The profile uses existing OAuth
and JOSE mechanisms and defines no new JWT claims, OAuth parameters, or OAuth
endpoints. Implementation-specific lost-response recovery is described only as
security guidance and is not part of interoperable conformance. Operational
facilities such as policy engines, audit stores, budgets, event streams, and
credential vaults are outside the interoperable core. Grantex contains a
self-assessed reference implementation of the three conformance roles and is
not required for conformance.

--- middle

# Introduction

OAuth deployments already support software acting for users. AI agent
deployments add operational pressure because agent instances can be created
dynamically, can call high-impact APIs, and can delegate work to other agent
instances. These characteristics do not justify replacing OAuth. They do
justify a strict profile that removes unsafe choices and makes the acting
client, user, resource, authorization-server issuer, and sender key explicit.

This document profiles OAuth 2.0 {{RFC6749}} and the OAuth 2.0 Security Best
Current Practice {{RFC9700}}. It uses pushed authorization requests (PAR)
{{RFC9126}}, Proof Key for Code Exchange (PKCE) {{RFC7636}}, authorization
server issuer identification {{RFC9207}}, resource indicators {{RFC8707}}, JWT
access tokens {{RFC9068}}, Demonstrating Proof of Possession (DPoP) {{RFC9449}},
and OAuth Token Exchange {{RFC8693}}. Mutual TLS {{RFC8705}} is an optional
sender-constraining alternative.

The term "DAAP" is a convenient name for this profile. It is not a new
authorization framework, a new credential format, or a claim that an AI agent
is a legal person.

## Scope

This document specifies:

1. conformance requirements for OAuth clients, authorization servers, and
   resource servers;
2. discovery and security metadata for an agent's OAuth client registration;
3. an authorization-code flow with authenticated human consent;
4. resource-bound, sender-constrained JWT access tokens;
5. same-instance, same-resource scope attenuation using OAuth Token Exchange;
6. requirements for refresh tokens when they are issued; and
7. token and refresh-family revocation.

This document does not standardize cross-resource authorization mapping,
cross-instance agent delegation, agent orchestration, model selection, DIDs,
policy languages, payments, budget ledgers, audit storage APIs, event delivery,
credential vaults, SCIM, SSO configuration, or vendor deployment endpoints.
Those features can be useful, but they require separate specifications and
security analysis.

## Applicability

This profile is intended for OAuth deployments in which a human Principal
authorizes an agent client instance to access one protected resource and the
deployment needs strong request integrity, sender constraint, and explicit
delegation boundaries.

This profile is not an agent workload identity protocol and is not a substitute
for client-credentials, workload federation, or cross-domain identity chaining
when no human resource owner participates. It also does not make a model,
prompt, agent name, or developer assertion into an OAuth security principal.

## Discussion Venues

Discussion of this document is intended for the OAuth Working Group mailing
list at `oauth@ietf.org`. The archive is at
`https://mailarchive.ietf.org/arch/browse/oauth/`.

Author contact:

* Primary: `mishra.sanjeev@gmail.com`
* Alternate: `sanjeev@orchestrum.in`

Source and issue tracking are maintained at
`https://github.com/mishrasanjeev/grantex/tree/main/docs/ietf-draft`.

## Changes Since -02

Revision -03:

* defines explicit client, authorization-server, and resource-server
  conformance roles;
* defines the authorization-server metadata required for interoperable
  discovery;
* makes DPoP mandatory to implement and binds authorization codes to the DPoP
  key used in PAR;
* requires authorization-response issuer validation to prevent mix-up;
* defines an issuer-, client-, and sender-key-bound authorization context
  without treating a key thumbprint as stable agent identity;
* replaces ambiguous delegation language with same-instance, same-resource
  Token Exchange and exact scope-set containment;
* requires an RFC 7009 revocation endpoint and refresh-family invalidation;
* uses the precise `cnf.jkt` and `cnf."x5t#S256"` confirmation members;
* changes consent wording to display effective lifetimes and constraints that
  are actually represented in the authorization request;
* moves lost-response refresh recovery outside interoperable conformance and
  adds storage, entropy, expiry, crash, and reauthorization guidance;
* expands current OAuth agent-work comparisons and privacy guidance; and
* removes the duplicate manually authored address section.

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
: An OAuth client instance that executes agent software. Within this profile,
  authorization is bound to the tuple of authorization-server issuer, OAuth
  `client_id`, and sender-key thumbprint. This tuple is an authorization and
  presentation-binding context, not a stable semantic identity or provenance
  assertion. It changes when the sender key rotates. The `client_id`
  identifies a registration, not a human or legal identity.

Principal:
: The human resource owner whose authority is delegated. A deployment can use
  a non-human resource owner only when its trust and authorization model is
  defined outside this profile.

Agent Key:
: An asymmetric key controlled by one Agent Client Instance and used for DPoP
  or mutual-TLS sender constraint. Distinct instances do not share an Agent Key.

Attenuated Token:
: An access token issued by OAuth Token Exchange whose authority is derived
  from another token and attenuated in scope or lifetime without changing the
  protected resource or Agent Client Instance.

# Conformance {#conformance}

Conformance applies separately to clients, authorization servers, and resource
servers. A deployment claiming conformance MUST identify the conforming roles
and MUST NOT describe a vendor-specific endpoint as a standard OAuth endpoint.

DPoP is the mandatory-to-implement sender-constraining mechanism. Conforming
clients, authorization servers, and resource servers MUST implement the DPoP
requirements in this profile. A deployment MAY additionally negotiate mutual
TLS for a client and its tokens when all participating roles support it. Mutual
TLS support does not remove the requirement to implement DPoP.

A conforming client:

* uses the authorization-code flow, PAR, PKCE S256, `state`, and exactly one
  resource indicator;
* binds a DPoP key during PAR and proves possession at the token endpoint;
* verifies `state` and the authorization-response issuer; and
* presents DPoP-bound tokens and proofs as required by {{RFC9449}}, except
  when mutual TLS has been explicitly negotiated for the client and token.

A conforming authorization server:

* publishes the metadata in {{authorization-server-metadata}};
* enforces the authorization and token requirements in this profile;
* supports RFC 9068 JWT access tokens bound using DPoP;
* supports same-instance, same-resource attenuation through RFC 8693 Token
  Exchange;
* supports RFC 7009 revocation; and
* applies the refresh requirements in this profile whenever it issues refresh
  tokens.

A conforming resource server:

* validates RFC 9068 access tokens, audience, scope, issuer, and lifetime;
* validates the DPoP proof and its binding for every DPoP-bound request, or
  validates the certificate binding for a negotiated mTLS-bound request; and
* makes an authorization decision after, not merely as a consequence of,
  cryptographic validation.

# Security Model

The authorization server is trusted to authenticate the Principal, display an
accurate authorization request, enforce registered client metadata, issue
tokens, and process revocation. A resource server is trusted to validate tokens
and enforce scopes for its own resource identifier.

An Agent Client Instance is not trusted merely because a developer registered
it or supplied an API key. Developer authentication and Principal
authentication are separate security events. A developer credential MUST NOT
be accepted as proof that the Principal approved a live authorization request.

Authorization-server and protected-resource endpoints used by this profile
MUST use HTTPS with certificate validation as required by {{RFC9700}}. The
loopback redirect exception for native applications does not permit an
insecure authorization, token, PAR, revocation, or resource endpoint.

For a live authorization, the authorization server MUST authenticate the
Principal using a method appropriate to the risk of the requested authority.
Phishing-resistant authentication is RECOMMENDED for high-impact scopes.
Sandbox deployments MAY use test principals and simulated consent when they
are clearly isolated from production resources and credentials.

An automated policy decision MAY deny, narrow, or require escalation of a
request. It MUST NOT replace the Principal's authenticated approval unless a
separate, explicitly authorized non-human resource-owner model applies.

# Protocol Overview

A conforming authorization proceeds as follows:

1. The client validates the authorization server's RFC 8414 metadata and
   maintains issuer-specific registration, redirect, and key state.
2. The client creates a fresh `state`, PKCE verifier, and PAR request for one
   resource, binding the authorization code to its DPoP key.
3. The authorization server authenticates the Principal, displays the exact
   effective authorization, and records approval or denial for that request.
4. The client validates `iss` and `state` in the authorization response and
   exchanges the code using the PKCE verifier and matching DPoP key.
5. The client presents the resource-bound access token with a valid DPoP proof
   on each protected request, unless mTLS was explicitly negotiated.
6. The same Agent Client Instance may use Token Exchange to obtain a narrower
   token for the same resource without changing the sender key.
7. If a refresh token was issued, the client rotates it using the same sender
   binding. Loss of a response is handled by reauthorization unless the client
   and server share a proprietary recovery mechanism satisfying the guidance
   in this document.

# Authorization Server Metadata {#authorization-server-metadata}

The authorization server MUST publish metadata as defined by {{RFC8414}}. At a
minimum, the metadata MUST include:

* `issuer`, `authorization_endpoint`, `token_endpoint`, and `jwks_uri`;
* `revocation_endpoint`;
* `pushed_authorization_request_endpoint` and
  `require_pushed_authorization_requests` set to `true`;
* `response_types_supported` containing `code`;
* `grant_types_supported` containing `authorization_code`,
  `urn:ietf:params:oauth:grant-type:token-exchange`, and `refresh_token` when
  refresh tokens are issued;
* `code_challenge_methods_supported` containing `S256`;
* `authorization_response_iss_parameter_supported` set to `true`;
* a non-empty `dpop_signing_alg_values_supported` containing only asymmetric
  algorithms accepted by the authorization server; and
* `token_endpoint_auth_methods_supported` accurately describing supported
  client authentication methods; and
* `revocation_endpoint_auth_methods_supported` accurately describing the
  revocation endpoint's supported client authentication methods.

An authorization server that supports mutual TLS MUST also publish
`mtls_endpoint_aliases` and MUST set
`tls_client_certificate_bound_access_tokens` to `true` as defined by
{{RFC8705}}.

Metadata values and endpoint origins MUST be validated as required by
{{RFC8414}}. A JWKS document alone is not authorization-server metadata and
MUST NOT be described as conformance with {{RFC8414}}.

This metadata set advertises the standard capabilities required by the
profile. It is not a DAAP conformance indicator. This document defines no new
profile identifier; a deployment's conformance claim is conveyed out of band
and identifies the conforming roles as required by {{conformance}}.

# Agent Client Registration

An Agent Client Instance uses an OAuth client registration. Registration can
be provisioned administratively or by a standards-based dynamic registration
mechanism; the registration wire protocol is outside this document.

The registration MUST bind:

* one or more exact redirect URIs for authorization-code clients;
* the resources the client is permitted to request, represented as absolute
  URIs;
* the exact, case-sensitive scopes the client is permitted to request; and
* one or more separately identified Agent Keys.

The authorization server MUST reject redirect URIs containing fragments and
MUST apply the redirect URI rules from {{RFC9700}}. Production web redirect
URIs MUST use HTTPS, except for loopback redirects explicitly permitted for
native applications.

Each Agent Key MUST be asymmetric and MUST be controlled by one Agent Client
Instance. The registration MUST NOT contain private key parameters. Before
treating a key as controlled by an Agent Client Instance, the authorization
server MUST verify possession through DPoP {{RFC9449}}, mutual TLS {{RFC8705}},
or another protocol that proves possession of the corresponding private key.

If one OAuth registration authorizes multiple runtime instances, each instance
MUST use a distinct Agent Key, and the authorization server MUST maintain the
binding between the registration and each authorized key. Tokens identify the
authorization context and bind the presenting key through the sender-key
confirmation member in combination with `iss` and `client_id`; those values do
not attest stable agent identity.

Key rotation MUST either preserve validation of the old key for the remaining
lifetime of already-issued tokens or revoke those tokens. The authorization
server MUST reject future issuance and refresh using a retired key.

The Agent Key is binding material, not a durable identifier for an agent task,
model, runtime, or installation. A deployment requiring stable or attested
agent instance identity SHOULD compose this profile with a specification that
defines that identity and its evidence rather than deriving identity from a
key thumbprint.

A DPoP proof establishes possession of a key; it does not by itself
authenticate a confidential OAuth client. Confidential clients MUST also use
their registered token-endpoint authentication method. Public clients remain
public clients and MUST NOT be described as confidential merely because they
use DPoP.

# Authorization

## Pushed Authorization Request

Clients conforming to this profile MUST use PAR {{RFC9126}}. The pushed request
MUST contain, at minimum:

* `client_id`;
* `response_type=code`;
* an exact registered `redirect_uri`;
* `scope`;
* a `state` value containing at least 128 bits of unpredictable entropy and
  bound to the initiating user-agent session;
* `code_challenge` and `code_challenge_method=S256`; and
* exactly one `resource` value identifying the target resource server.

The `resource` value MUST be an absolute URI without a fragment as defined by
{{RFC8707}}. The authorization server MUST reject an unregistered redirect URI,
a resource outside the client's registration, or any scope outside the
client's registered scope set. It MUST NOT apply prefix, wildcard, or substring
matching to a redirect URI.

For DPoP, the PAR request MUST bind the authorization code to the Agent Key
using either the `dpop_jkt` parameter or a DPoP proof in the `DPoP` header as
defined by Section 10.1 of {{RFC9449}}. A conforming authorization server MUST
support both mechanisms. If both are present, their key thumbprints MUST match.
The key MUST also match a key authorized for that Agent Client Instance.

The client then sends the returned `request_uri` to the authorization endpoint
as defined by {{RFC9126}}. The authorization endpoint MUST reject a request URI
that is expired, already consumed where single use is enforced, issued to a
different client, or not recognized exactly as issued.

## Principal Interaction

The authorization server MUST authenticate the Principal independently of the
developer or Agent Client Instance. The consent view MUST show, in language the
Principal can understand:

* the Agent Client Instance and responsible developer;
* the target resource;
* the requested scopes and their consequences;
* the effective access-token, refresh-token, and grant lifetimes determined by
  authorization-server policy; and
* material delegation or transaction constraints actually represented by the
  request.

If structured constraints are requested, they SHOULD use
`authorization_details` as defined by {{RFC9396}}. This profile defines no new
authorization-details type. An authorization server MUST NOT display a
constraint as approved unless it was integrity-protected in the PAR request or
was a narrowing imposed by the authorization server and clearly disclosed.

Approval and denial MUST both be bound to the authenticated Principal and the
specific authorization request. The authorization server MUST prevent login
CSRF, consent CSRF, clickjacking, and reuse of approval artifacts.

## Authorization Response and Code Exchange

The authorization response MUST contain the `iss` parameter defined by
{{RFC9207}}. The client MUST store the expected issuer with the initiating
session and MUST reject the response unless `iss` exactly matches it. The
client MUST also verify that `state` exactly matches the stored value and has
not already been consumed.

The client exchanges the authorization code at the OAuth token endpoint using
`grant_type=authorization_code`, the code, the same `redirect_uri`, and the
PKCE `code_verifier`.

For DPoP, the token request MUST carry a valid DPoP proof. The authorization
server MUST reject the request unless the proof key matches the key bound at
PAR and the key authorized for the Agent Client Instance.

The authorization server MUST:

1. authenticate or otherwise identify the client as required for its client
   type;
2. require exact `redirect_uri` equality with the authorization request;
3. validate the S256 verifier;
4. bind the code to the client, Principal, issuer, resource, approved scopes,
   and sender key; and
5. consume the code atomically with successful token issuance.

An error while signing or storing tokens MUST leave the authorization code
usable for a later retry or MUST produce an unambiguous terminal error. It MUST
NOT create a partially committed grant.

# Access Tokens

Authorization servers conforming to this profile issue JWT access tokens
{{RFC7519}} as profiled by {{RFC9068}}. The JWK Set requirements of {{RFC7517}},
the JOSE requirements of {{RFC7518}}, and JWT validation guidance in
{{RFC8725}} apply.

## Claims and Sender Constraint

The token MUST use a `typ` value of `at+jwt` and contain the claims required by
{{RFC9068}}, including `iss`, `sub`, `aud`, `exp`, `iat`, `jti`, and
`client_id`. Granted scopes MUST use the standard space-delimited `scope`
claim.

The `aud` claim MUST contain exactly one audience value, identifying the single
resource requested during authorization. A token with no audience, a different
audience, or more than one audience value MUST be rejected by the resource
server.

The token MUST be sender-constrained:

* a DPoP-bound token carries the JWK SHA-256 thumbprint in `cnf.jkt` as defined
  by {{RFC9449}}; or
* an mTLS-bound token carries the certificate SHA-256 thumbprint in
  `cnf."x5t#S256"` as defined by {{RFC8705}}.

An authorization server MUST NOT emit `cnf` solely because a public key was
uploaded. It MUST first establish proof of possession. The resource server MUST
verify the DPoP proof or mutual-TLS binding on every protected request.

A DPoP-bound access token MUST be presented using the `DPoP` authentication
scheme together with a DPoP proof, as defined by {{RFC9449}}. A bearer
presentation of a DPoP-bound token MUST be rejected.

A token response containing a DPoP-bound access token MUST use the `DPoP`
`token_type` value defined by {{RFC9449}}. An mTLS-bound access-token response
uses the `Bearer` token type while binding the token to the certificate as
defined by {{RFC8705}}.

This profile defines no short aliases for `scope`, `client_id`, `act`, or
`authorization_details`. Private implementation claims MAY be used only under
collision-resistant names and MUST NOT be required for interoperability.

## Validation

A resource server MUST validate at least:

1. `typ`, an explicitly allowed signature algorithm, and a valid signature;
2. `iss` against the configured authorization server;
3. `aud` against the resource server's identifier;
4. `exp`, `iat`, and any applicable not-before constraint;
5. the required values in `scope` using exact, case-sensitive comparison;
6. the sender constraint represented by `cnf`; and
7. revocation or token status when the deployment's risk model requires online
   state.

For DPoP, validation MUST include the requirements of {{RFC9449}}, including
the HTTP method and target URI, proof freshness and replay detection, the
access-token hash, and equality between the proof key and `cnf.jkt`.

The resource server MUST NOT treat signature verification alone as sufficient
authorization.

# Same-Instance Token Attenuation

Token attenuation uses OAuth Token Exchange {{RFC8693}} at the standard OAuth
token endpoint. The request MUST include:

* `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`;
* `subject_token`;
* `subject_token_type=urn:ietf:params:oauth:token-type:access_token`;
* `requested_token_type=urn:ietf:params:oauth:token-type:access_token`;
* `scope`; and
* exactly one `resource` value.

The authorization server MUST authenticate the requesting client and validate
the subject token before exchange. The subject token's `client_id` MUST equal
the authenticated client's `client_id`, and its sender constraint MUST match
the requesting Agent Client Instance. For DPoP, the request MUST carry a valid
DPoP proof whose key thumbprint equals the subject token's `cnf.jkt`. For
mutual TLS, the request certificate thumbprint MUST equal the subject token's
`cnf."x5t#S256"` value.

This profile does not define transfer to a different Agent Client Instance.
An `actor_token` or `actor_token_type` indicates a different delegation model
and MUST NOT be accepted under this profile unless another explicitly
negotiated profile defines the actor validation and recipient sender binding.

OAuth scopes are opaque, case-sensitive strings. The requested scope set MUST
be an exact set-theoretic subset of the scope set in the subject token. The
requested `resource` value MUST exactly equal the subject token's sole audience
value.

The Token Exchange response MUST identify the issued token type as
`urn:ietf:params:oauth:token-type:access_token`. The attenuated token:

* MUST NOT expire later than the subject token;
* MUST preserve the subject token's sender constraint exactly;
* MUST use the requested scope set;
* MUST preserve the Principal as `sub` and the resource as its sole audience;
  and
* MUST preserve any existing RFC 8693 `act` claim without adding a new actor.

The authorization server SHOULD bound repeated exchanges and token lifetimes.
OAuth Token Exchange does not by itself revoke the subject token or create
revocation linkage between input and output tokens. A deployment MUST NOT
claim cascade revocation unless it implements and tests such linkage as an
extension.

Cross-instance, cross-resource, and cross-domain delegation are outside this
profile. They should be evaluated against the related work described later in
this document rather than implemented as private `act` chain semantics.

# Refresh Tokens

Refresh-token handling MUST follow {{RFC9700}}. This profile requires both
rotation and sender constraint whenever an Agent Client Instance is issued a
refresh token.

On a successful refresh, the authorization server MUST invalidate the
presented refresh token and return a new refresh token atomically. The new
access token MUST NOT expand the original resource, scope, delegation, sender
binding, or grant lifetime. A DPoP proof or mutual-TLS certificate used during
refresh MUST match the sender binding of the refresh-token family.

Reuse of an invalidated refresh token outside an explicitly recognized
request-bound recovery attempt MUST fail with `invalid_grant` and SHOULD revoke
the active refresh-token family or trigger another risk-appropriate incident
response.

## Implementation-Specific Lost-Response Recovery

This subsection is implementation guidance. It defines no OAuth parameter,
header, or conformance requirement, and two independent implementations cannot
assume interoperability based on it.

Network failure can occur after the authorization server commits rotation but
before the client receives the response. A proprietary recovery mechanism can
avoid unnecessary reauthorization, but it needs to avoid becoming a replay
grace period. A secure design has all of the following properties:

1. Before its first attempt, the client generates a recovery key with at least
   128 bits of entropy from a cryptographically secure random source and
   persists it with the old refresh token until the response is durable.
2. Every transport retry of that same logical refresh operation uses the same
   recovery key. A new logical refresh operation uses a new key.
3. The authorization server binds recovery state to the authenticated client,
   Agent Client Instance, old refresh-token digest, sender key, and recovery-key
   digest.
4. Any stored access token, rotated refresh token, or serialized token response
   is encrypted at rest, excluded from logs, and deleted when the recovery
   window expires.
5. Recovery returns the exact committed token values and response parameters,
   except that relative lifetime fields such as `expires_in` are recalculated
   from the committed absolute expiration. It does not mint a new token, extend
   a lifetime, or rotate again.
6. Recovery is permitted only while the rotated child refresh token is active
   and unused, and only for the same authenticated and sender-bound request.
7. The recovery window is short and bounded; no more than 300 seconds is
   recommended.
8. A different or missing recovery key, an expired recovery window, or an
   already-used child token fails as refresh-token reuse. After the window, the
   client discards the old token and initiates a new authorization flow rather
   than retrying indefinitely.

A server crash before transaction commit leaves the old token unused and the
client can retry normally. A crash after commit requires the rotated token and
recovery state to have been committed in the same durable transaction.
Implementations should test both crash boundaries, concurrent retries, expiry,
child-token use, family revocation, and deletion of stored responses.

# Revocation

The authorization server MUST expose the OAuth token revocation endpoint
defined by {{RFC7009}}. The endpoint MUST authenticate confidential clients as
required by their registration. DPoP or mTLS sender constraint does not replace
that client authentication. The authorization server MUST verify that the
requesting client, Principal, or administrator is authorized to revoke the
presented token or its grant.

Revoking a refresh token MUST invalidate its entire refresh-token family and
prevent further token issuance from that family. The authorization server MUST
also provide an authenticated mechanism for the Principal or an authorized
administrator to revoke the underlying authorization grant.

For an access token, the authorization server MUST either make revocation
state available to the resource server or limit the token lifetime so that the
residual authorization window is appropriate to the protected resource's risk.
The consent view displays that effective lifetime as required earlier in this
document.

Revocation of a subject token does not automatically revoke tokens previously
created by Token Exchange. A deployment claiming that behavior MUST maintain
and enforce explicit input-to-output linkage.

# Operational Extensions

The following topics are intentionally outside core conformance:

* decentralized identifiers and globally resolvable agent documents;
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

The OAuth threat model and mitigations in {{RFC9700}} apply. Implementers should
also track the active OAuth Security BCP update
{{I-D.ietf-oauth-security-topics-update}}. This section calls out
agent-specific consequences.

## Consent Substitution

A developer API key, policy-engine decision, or agent assertion is not the
Principal's consent. Conflating these identities lets the party requesting
authority approve its own request. Live consent therefore requires independent
Principal authentication and request-bound approval.

## Redirect, Issuer, and Request Integrity

Exact redirect matching, PAR, PKCE S256, `state`, issuer identification, and
DPoP code binding address different attacks and are not substitutes for one
another. Clients MUST keep `state`, the PKCE verifier, the expected issuer, and
the PAR request association confidential until the flow completes.

A client that interacts with multiple authorization servers MUST maintain
separate validated metadata, client registration, redirect state, and Agent
Keys for each issuer. It MUST NOT accept endpoints from one issuer as metadata
for another issuer. These requirements also reduce mix-up, audience-injection,
and cross-provider account-linking risks.

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

Distinct Agent Client Instances MUST NOT share an Agent Key. Key reuse across
authorization-server issuers can enable correlation and can increase the
impact of a compromised client assertion or signing environment.

## Delegation

Even same-instance Token Exchange can create unexpectedly long-lived or
difficult-to-revoke token graphs. Exact scope containment, same-resource
enforcement, bounded lifetime, unchanged sender constraint, and exchange-rate
limits SHOULD be enforced together.

Cross-instance delegation requires a secure method for the subject-token
holder to authorize the recipient and for the issued token to be bound to the
recipient's key. Plain client-supplied actor text provides neither property.
This profile therefore does not define that operation.

The subject token remains valid after RFC 8693 Token Exchange unless another
mechanism revokes it. Resource servers and authorization servers MUST NOT
infer one-time use or cascade revocation from the exchange itself.

## Refresh Reuse

Recovery must not become a replay grace period. Only the same authenticated and
request-bound retry can receive a previously committed response. Any other
reuse can indicate token theft and SHOULD trigger family revocation or another
risk-appropriate incident response.

## Logging

Authorization servers and resource servers MUST NOT log authorization codes,
refresh tokens, access tokens, DPoP private keys, PKCE verifiers, recovery keys,
stored recovery responses, client assertions, or upstream credentials.
Security logs SHOULD record enough non-secret context to investigate consent,
delegation, refresh reuse, and revocation events.

# Privacy Considerations

Agent authorization data can reveal a Principal's services, activities,
relationships, and intended actions. Implementations SHOULD minimize token
claims and consent records, use pairwise subject identifiers where appropriate,
and avoid placing personal data in globally resolvable agent documents.

Resource indicators and fine-grained scopes can themselves be sensitive. They
SHOULD be disclosed only to parties that require them. Audit retention and
export MUST have a defined purpose, access policy, retention period, and
deletion process.

Stable `client_id` values and sender-key thumbprints can correlate an Agent
Client Instance across resource servers and authorization servers. Deployments
SHOULD use issuer-specific registrations and Agent Keys and SHOULD expose the
sender-key confirmation member only to the resource server for which the token
was issued.

Delegation chains reveal relationships among services and actors. A resource
server should receive only the chain information needed for its authorization
decision.

# IANA Considerations

This document requests no IANA actions. It uses claims, parameters, endpoints,
and confirmation methods defined by existing OAuth and JOSE specifications.
The lost-response recovery guidance deliberately defines no wire-level key or
header. Any future interoperable recovery key or agent-specific authorization
detail will require a separate specification and appropriate registry review.

# Relationship to Other Work

The Agent Authorization Profile (AAP) for OAuth 2.0
{{I-D.aap-oauth-profile}} defines structured agent, task, capability, context,
and oversight claims, primarily for agent-to-API authorization. This document
does not define those claims; it focuses on authenticated human authorization,
standard RFC 9068 claims, PAR, issuer and resource binding, and a
mandatory-to-implement sender constraint.

OAuth 2.0 Client Instance Assertion
{{I-D.mcguinness-oauth-client-instance-assertion}} and the OAuth 2.0 AI Agent
Instance Profile {{I-D.mcguinness-oauth-ai-agent-instance}} define attested
client-instance identity and how agent identity or provenance can surface in
tokens. This profile does not duplicate those claims. Its issuer, `client_id`,
and sender-key tuple is only an authorization and proof-of-possession context.
Deployments needing stable agent instance identity should compose with that
work.

PACT {{I-D.valverde-oauth-pact}} profiles privacy-preserving agent consent
using OAuth 2.1, CIBA, structured capabilities, and risk-graduated consent.
This document instead profiles the browser authorization-code flow and defines
no agent capability vocabulary.

Attenuating Authorization Tokens for Agentic Delegation Chains
{{I-D.niyikiza-oauth-attenuating-agent-tokens}} explores richer capability and
delegation attenuation. This profile deliberately limits core delegation to
exact OAuth scope-set containment and the same resource.

OAuth 2.0 Delegated Authorization
{{I-D.li-oauth-delegated-authorization}} defines cryptographically linked,
client-issued delegation tokens that avoid contacting the authorization
server for every hop. This profile defines only authorization-server-mediated,
same-instance attenuation and does not define client-issued access tokens.

The OAuth Actor Profile for Delegation
{{I-D.mcguinness-oauth-actor-profile}} and Cryptographically Verifiable Actor
Chains {{I-D.mw-oauth-actor-chain}} explore richer actor representation,
disclosure, and proof. This profile preserves an existing RFC 8693 `act` claim
but does not extend the chain or define an actor-chain proof format.

OAuth Identity and Authorization Chaining Across Domains
{{I-D.ietf-oauth-identity-chaining}} addresses identity and authorization
continuity across trust domains. Implementations should use that work for
cross-domain chains rather than defining private equivalents.

OAuth Transaction Tokens {{I-D.ietf-oauth-transaction-tokens}} and Transaction
Tokens for Agents {{I-D.araut-oauth-transaction-tokens-for-agents}} address
short-lived, purpose-bound context for service call chains. They may complement
this profile after initial authorization; this document does not redefine
transaction tokens.

The agent authorization use-cases draft
{{I-D.chen-oauth-agent-authz-use-cases}} surveys emerging scenarios and gaps.
The multi-agent collaboration draft
{{I-D.song-oauth-ai-agent-collaborate-authz}} explores group authorization.
This profile focuses more narrowly on a high-assurance OAuth authorization and
same-resource delegation baseline and does not claim to supersede either work.

OAuth Refresh Token and Authorization Expiration
{{I-D.ietf-oauth-refresh-token-expiration}} defines related expiration metadata
and semantics. Implementations should align effective lifetime displays and
refresh behavior with that work as it progresses.

# Implementation Status {#implementation-status}

This section follows the intent of {{RFC7942}} and is expected to be removed
before publication as an RFC.

As of 2026-08-30, the Grantex source repository contains role-specific client,
authorization-server, and resource-server implementations of this revision.
The TypeScript `OAuthAgentClient` performs metadata and issuer validation, PAR,
PKCE S256, one-time state handling, DPoP, refresh rotation, same-resource scope
attenuation, revocation, and protected-resource requests. The authorization
server exposes standard `/oauth/par`, `/oauth/authorize`, `/oauth/token`, and
`/oauth/revoke` endpoints. The example resource server is exposed at
`/oauth/resource` and validates the access-token and DPoP requirements in this
profile.

The implementation has same-repository unit and Docker integration tests.
It is a self-assessed implementation statement, not evidence of interoperability
with an independent implementation, an external certification, IETF
endorsement, or OAuth Working Group adoption. A production deployment also
depends on trustworthy Principal passkey enrollment and account recovery; a
developer credential alone is not Principal approval.

The older Grantex `/v1/*` JSON API remains available as a separate legacy
protocol. It is intentionally isolated from the standard-profile authorization
codes, grants, refresh tokens, and token exchanges and is not claimed as a
conformant OAuth surface. The repository implementation report identifies the
tested revision and the remaining independent-evidence gaps.

# Acknowledgements

The author thanks reviewers in the OAuth community whose published work on
OAuth security, identity chaining, transaction tokens, and agent authorization
helped narrow this document.

--- back

# Non-Normative Grantex Mapping

This appendix is informative. It helps reviewers locate the profile operations
in the Grantex source implementation; the normative protocol requirements are
defined by the body of this document and its referenced specifications.

| Profile operation | Grantex standard-profile path |
|:------------------|:-------------------------------|
| Administrative agent registration | `POST /v1/agents` |
| Pushed Authorization Request | `POST /oauth/par` |
| Authorization request | `GET /oauth/authorize` |
| Principal consent decision | `POST /v1/consent/{id}/approve` or `/deny` |
| Authorization-code exchange | `POST /oauth/token` |
| Refresh rotation | `POST /oauth/token` |
| Same-resource scope attenuation | `POST /oauth/token` using RFC 8693 Token Exchange |
| Token revocation | `POST /oauth/revoke` |
| Example protected resource | `ALL /oauth/resource` |
| Authorization-server metadata | `GET /.well-known/oauth-authorization-server` |
| Signing keys | `GET /.well-known/jwks.json` |

Agent registration is an administrative provisioning operation, not a new
OAuth protocol endpoint. The implementation requires exact registered redirect
URIs, resources, and sender-key material before a client can use the profile.
The separate `/v1/authorize`, `/v1/token`, `/v1/token/refresh`,
`/v1/grants/delegate`, and grant-deletion APIs implement the legacy Grantex
protocol and are outside the conformance claim.

The implementation transports its refresh recovery key in an
`Idempotency-Key` HTTP request header. That header use is implementation
specific, is not required for DAAP conformance, and must not be interpreted as
an IETF-defined use of that header.

# Candidate Extension Documents

The following subjects should be developed independently if there is community
interest:

1. an interoperable refresh lost-response recovery mechanism;
2. externally witnessed agent audit checkpoints;
3. financial authorization details and atomic budget settlement;
4. cross-instance or cross-resource agent delegation and cascade revocation
   profiles; and
5. operational event, policy, and credential-handling interfaces.

Separating these topics keeps security assumptions, registries, and consensus
boundaries reviewable.
