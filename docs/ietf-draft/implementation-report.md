# DAAP Implementation Report

**Draft:** `draft-mishra-oauth-agent-grants-03` working candidate

**Date:** 2026-08-30

**Author:** Sanjeev Kumar, Orchestrum Technologies LLP

**Contact:** mishra.sanjeev@gmail.com; sanjeev@orchestrum.in

## Status

The repository now contains role-specific implementations of the `-03`
profile for an OAuth client, authorization server, and resource server. The
standard endpoints are separate from the older Grantex `/v1/*` JSON API; the
legacy API remains supported but is not represented as standard OAuth.

This is a source-level, self-assessed conformance statement for the tested
configuration. It is not IETF endorsement, OAuth Working Group adoption, an
independent security certification, or interoperability evidence from a
second implementation. The hosted service must not claim this revision is
deployed until the corresponding commit and Firebase rewrites are released
and production E2E is green.

The current Datatracker publication remains
`draft-mishra-oauth-agent-grants-02`. Revision `-03` is intentionally held
from submission while review continues from 2026-09-06 through 2026-09-09.
It must not be uploaded before 2026-09-09 or without a new explicit approval
after the final review.

## Conforming Roles

| Role | Implementation | Scope of claim |
|:-----|:---------------|:---------------|
| Client | `OAuthAgentClient` in `packages/sdk-ts/src/oauth-agent.ts` | Metadata and issuer validation, PAR, PKCE S256, one-time state, RFC 9207 response validation, DPoP token requests and resource presentation, refresh, attenuation, and revocation. |
| Authorization server | `apps/auth-service/src/routes/oauth.ts` | RFC 8414 metadata, PAR, authorization-code exchange, RFC 9068 JWT access tokens, DPoP, same-instance RFC 8693 attenuation, refresh rotation/family reuse response, and RFC 7009 revocation for public clients. |
| Resource server | `ALL /oauth/resource` in the auth service | RFC 9068 signature/issuer/audience/lifetime checks, online token and grant status, DPoP method/URI/freshness/replay/`ath`/key checks, and an exact scope authorization decision. |

The authorization and revocation endpoints advertise `none` client
authentication because the implemented profile registrations are public
clients. DPoP proves possession of the registered instance key; the
implementation does not describe DPoP as confidential-client authentication.

## Core Profile Matrix

| Profile requirement | Status | Repository evidence |
|:--------------------|:-------|:--------------------|
| RFC 8414 metadata | Implemented | `GET /.well-known/oauth-authorization-server` publishes all required endpoints, grant/response types, S256, RFC 9207 support, DPoP algorithms, and accurate `none` authentication methods. |
| Standard authorization endpoint | Implemented | `GET /oauth/authorize` accepts only an issued PAR `request_uri`, enforces client binding, consumes it atomically, and redirects with `code`, `state`, and `iss`. |
| RFC 9126 PAR | Implemented | `POST /oauth/par` validates exact registered redirect, scopes, one resource, state, PKCE, an optional account-discovery hint, typed optional RFC 9396 details, and DPoP key binding; request URIs expire after 90 seconds. The hint is not an undeclared interoperability requirement. |
| DPoP code binding | Implemented | PAR accepts a DPoP proof, a previously possession-verified `dpop_jkt`, or both; both must match when present. A public-key upload alone is not proof of possession. Code exchange requires a fresh proof from the same current registered key. |
| Exact registered redirect and resource | Implemented | Registration and PAR use exact set membership; resources are absolute and fragment-free. Production registration is HTTPS-only. |
| State and RFC 9207 issuer checks | Implemented | The SDK stores issuer-specific one-time state and rejects an unknown, consumed, or wrong-issuer callback before token exchange. |
| PKCE S256 | Implemented | The client creates a fresh verifier per request; PAR requires S256; token exchange validates exact redirect and verifier. |
| Principal consent | Implemented with deployment condition | Live approval and denial require a WebAuthn assertion bound to the principal and authorization request. When PAR omits an account hint, the consent page binds the first interactive principal selection before creating its passkey challenge. Operators remain responsible for trustworthy passkey enrollment and principal identity proofing; sandbox auto-approval is isolated and not a live conformance deployment. |
| Consent disclosure | Implemented | The consent view shows the agent, responsible developer, exact scopes and descriptions, resource, access/refresh/grant lifetimes, and integrity-protected structured authorization details. |
| Policy cannot replace live consent | Implemented | Policy may deny, but an `allow` decision never emits a live authorization code without principal verification. |
| Standard OAuth token endpoint | Implemented | Form-encoded `POST /oauth/token` supports authorization code, refresh token, and RFC 8693 Token Exchange grants. |
| RFC 9068 JWT access tokens | Implemented | Standard tokens use `typ=at+jwt` and carry `iss`, `sub`, one `aud`, `exp`, `iat`, `jti`, `client_id`, space-delimited `scope`, and `cnf.jkt`; private compatibility claims are not required by the profile client or resource route. |
| Interoperable claim vocabulary | Implemented | Profile access tokens omit the legacy short claims `scp`, `agt`, `dev`, and `grnt`. Authorization, resource validation, and attenuation use the standard `scope`, `client_id`, `aud`, `cnf`, `act`, and `authorization_details` members. |
| Non-cacheable token responses | Implemented | Success and error responses from `/oauth/token` carry `Cache-Control: no-store` and `Pragma: no-cache`. |
| High-entropy protocol secrets | Implemented | PAR request handles, authorization codes, and profile refresh tokens contain 256 bits from `crypto.randomBytes`; identifiers such as grant IDs and JWT `jti` values remain non-secret identifiers. |
| End-to-end DPoP | Implemented | ES256/384/512, RS256, and EdDSA public proofs are validated for signature, `typ`, method, target URI, freshness, unique `jti`, optional/required `ath`, and registered/token key equality. Redis replay protection fails closed. |
| Bearer downgrade prevention | Implemented | `/oauth/resource` rejects bearer presentation of a DPoP-bound token and requires the DPoP scheme plus proof. |
| RFC 8693 attenuation | Implemented | Token Exchange accepts only a standard active subject token from the same `client_id`, key, and resource; scope must be an exact subset; actor tokens are rejected; output preserves principal, audience, sender constraint, existing `act`, and structured authorization details. |
| Refresh rotation and sender binding | Implemented | Rotation is atomic, preserves resource/scope/key/grant lifetime and structured authorization details, checks the currently registered key, and returns a new family member. A non-conformance 300-second lost-response extension binds the old token, client, DPoP key, and recovery key; it returns the exact committed token values with a recalculated remaining lifetime, stores the access token in an AES-256-GCM envelope, and erases expired state. Any mismatched reuse, including reuse without a recovery key at any time after rotation, revokes the active grant and family. Profile access tokens carry no `act` claim, and a refreshed token gains none. |
| RFC 7009 revocation | Implemented | `POST /oauth/revoke` authenticates the public client with its DPoP key, hides token validity, revokes access-token status, and invalidates an entire refresh family. |
| Key isolation and rotation | Implemented | A partial unique database index prevents two Agent Client Instances at this issuer from sharing an Agent Key. New issuance and refresh require the current registered key. Existing access tokens retain their original `cnf.jkt` and remain verifiable until expiry or revocation. |
| Resource-server authorization | Implemented | The protected route checks protocol origin, token status, audience, DPoP binding, and the exact `grantex.resource.read` scope before returning an authorized result. |

## Legacy and Extension Boundaries

The following paths remain product APIs and are deliberately isolated from the
standard profile:

| Product operation | Legacy path | Boundary |
|:------------------|:------------|:---------|
| JSON authorization | `POST /v1/authorize` | Cannot issue a standard-profile code. |
| JSON token exchange | `POST /v1/token` | Cannot consume a standard-profile code. |
| Product-profile refresh | `POST /v1/token/refresh` | Cannot rotate a standard-profile refresh family. Its 300-second `Idempotency-Key` recovery uses the same encrypted response cache as `/oauth/token`, but neither recovery mechanism is DAAP conformance or an interoperable extension. |
| Cross-agent delegation | `POST /v1/grants/delegate` | Cannot use a standard-profile grant as its parent. Cross-instance delegation remains outside core `-03`. |
| Product token verification | `POST /v1/tokens/verify` | Grantex API, not RFC 7662. |
| Product grant revocation | `DELETE /v1/grants/{id}` | Authenticated administrative grant control in addition to RFC 7009. |

Audit chains, signed checkpoints, budgets, policies, event delivery, the
credential vault, SCIM, SSO, Commerce, and other enterprise integrations are
implementation extensions and are not used as evidence of DAAP conformance.

## Test Evidence

The repository contains both focused cryptographic tests and a database-backed
wire-protocol E2E:

- `apps/auth-service/tests/oauth-profile.test.ts` uses real ES256 DPoP proofs
  to test proof validation, replay rejection, PAR key binding, bearer
  downgrade rejection, protocol isolation, and protected-resource decisions.
- `packages/sdk-ts/tests/oauth-agent.test.ts` tests metadata validation, PAR,
  one-time state, RFC 9207 issuer rejection, token exchange proof construction,
  `ath`-bound resource requests, redirect binding, cross-origin token-leak
  prevention, duplicate callback rejection, RFC 8414 path-issuer discovery,
  token-response validation, and public/private key-pair validation.
- `tests/e2e/oauth-agent-profile.test.ts` runs against Docker Postgres, Redis,
  and the built auth-service image. It covers PAR, sandbox authorization,
  RFC 9207, code exchange, DPoP resource use, RFC 8693 attenuation, rotation,
  access and refresh revocation, family replay response, retired-key rejection,
  authorization-details preservation, duplicate Agent Key rejection, PAR
  single use, bearer and scope-escalation rejection, standard-only profile
  claims, and clean deletion of profile state.
- `apps/auth-service/tests/oauth-profile.test.ts` also checks that a refreshed
  profile token has the same (absent) `act` claim as the token issued at code
  exchange, and that a used refresh token re-presented inside the recovery
  window without a recovery key revokes the family instead of returning the
  committed successor.

Verified on 2026-08-30:

```text
Auth service: 167 test files passed, 1 skipped; 2,138 tests passed, 2 skipped
TypeScript SDK: 31 test files passed; 456 tests passed; build and typecheck passed
Docker E2E: 23 files; 255 tests passed; 0 failed
OAuth Docker flow: all protocol stages, negative cases, key uniqueness, and cleanup passed
Refresh restart proof: encrypted recovery state survived an auth-service container restart
Fresh Docker database: all 93 migrations applied; Postgres and Redis healthy
IETF Author Tools: 0 errors, 0 flaws, 1 Unicode warning, 1 heuristic comment
```

The Docker files were executed sequentially, matching the workflow's isolated
steps and avoiding self-induced concurrency against per-IP authentication
limits. The test did not disable or weaken a production rate limit.

The Markdown was converted with `kramdown-rfc2629` 1.7.43. Text and HTML were
rendered with `xml2rfc` 3.33.0 from the official image digest
`sha256:de208fee97d109a9a0764782e31f7898594f55c0521bf124b30da169f32bf9b9`.
IETF Author Tools validation reported no errors or flaws. The remaining Unicode
warning is the correctly encoded surname `Würtele` in an informative-reference
author list, and the heuristic comment is non-blocking; both must be rechecked
after the final review edits.

## Deployment Conditions

A deployment claim is valid only when all of the following are true:

1. The deployed revision includes migration
   `090_oauth_daap_profile.sql` and the `/oauth/*` Firebase rewrites.
   Before migration, operators must confirm that existing non-null Agent Key
   thumbprints are unique; the migration deliberately fails rather than retain
   ambiguous cross-instance key ownership.
2. Issuer, PAR, authorization, token, revocation, and resource URLs use HTTPS
   with certificate validation. HTTP is accepted only by the non-production
   loopback Docker harness.
3. Redis replay protection is available; the service fails closed when it is
   not.
4. Live principal passkeys are enrolled under a trustworthy identity and
   account-recovery process. A developer API key alone is never approval.
5. Production E2E passes against the advertised issuer and deployed resource.

## Second Implementation Report

On 2026-11-15 Ilja Radusch posted an implementation report and a partial run
of the `-03` vectors for a second authorization server, in
[issue #1887](https://github.com/mishrasanjeev/grantex/issues/1887). He wrote
both about his own implementation and states that the run is author-produced,
not independent. The summary below is ours; the issue holds his text.

**Implementation and stance.** A deployed OAuth 2.1 and OpenID Connect
authorization server (TypeScript, Express, PostgreSQL) serving several first-
and third-party resource servers, one of which uses its delegated-agent tokens
in production. Delegated tokens are ordinary JWT access tokens with an RFC 8693
`act` claim. The agent lane is a profile of existing OAuth: no new grant type,
token format, or endpoint, and delegation needs the same user consent as any
other scope.

**Delegation depth.** Depth 1 in production: a user, an agent, and one RFC 8707
resource. Token exchange intersects the requested scope with the subject
token's scope, refresh narrowing never widens the rotated refresh token, an
`actor_token` is rejected, and the actor comes from the authenticated client,
never from a presented token. This is the same-instance, exact-scope
attenuation core of `-03`.

**Actor binding across refresh.** `act` is set at one central issuance point
when the delegation basis applies and is stored with the token, so the refresh
grant issues it again unchanged. An earlier design set `act` in each grant
handler; the refresh handler never did, and a delegated token silently rotated
into a non-delegated one. That defect is the reason for this revision's
refresh `act` requirement and for the `refresh.valid.actor-preserved` and
`refresh.reject.actor-dropped` vectors. Client-credentials tokens carry no
`act`, because the client acts for itself.

**Client floor.** An allowlist keyed on the authenticated `client_id` holds
known agents in the delegated lane. It never keys on self-asserted scope or a
redirect-URI pattern, and it can only add restriction. It works alongside
sender-constrained, resource-bound tokens: the DPoP key shows possession, the
floor shows which registered agent is calling, and both checks apply.

**Lane versus scope consent.** The delegated lane is recorded per user and
client, apart from the session's union of consented scopes. Deriving it from
that union let a second client sharing one SSO session inherit `act` from the
first client's choice.

**Actor-profile interop.** The reported `act` shape (`iss`, `sub` set to the
authenticated `client_id`, and `sub_profile: ai_agent`) passes the
Agent-Authority-Conformance actor-profile cases AC-01 to AC-05, RT-01, and
CC-01; AC-01, AC-02, and RT-01 were captured from live server output.

### Partial Vector Run

The run used a local test server with a throwaway database and tokens issued
through a real login on the delegated lane (device flow, refresh, then
revocation). The vectors file had SHA-256
`80a413c1657202be9d0488ad8f59941f4892a6534cfa38e5d2b650a2ae8248e6`, which is
the 30-vector corpus before this revision. The implementation commit is
`8831bc7d` in a private repository.

| Result | Count | Vectors |
|:-------|------:|:--------|
| Pass | 2 | `token.valid.non-cacheable-response`, `revocation.valid.refresh-family` |
| Fail | 1 | `token.valid.standard-claims`: no `cnf`, because the run presented no DPoP proof. The server binds `cnf.jkt` when a proof is presented but does not require one. |
| Not applicable | 8 | The client-role and resource-server-role vectors |
| Not run | 19 | PAR, DPoP agent keys, PKCE, token exchange, `authorization_details`, retired key, and the two refresh-reuse vectors |

**Refresh reuse.** The server always rotates and revokes the family on reuse,
except that within 90 seconds of rotation it returns the already issued
successor to a re-presented parent, as lost-response mitigation. The probe
reused the parent after 31 seconds, so `refresh.valid.atomic-rotation` and
`refresh.reject.family-reuse` measured that replay; he marked them not run
and asked whether `-03` forbids any grace replay. This revision answers that a
time-only replay is refresh-token reuse: the Refresh Tokens section now says
so, and both vectors state that the probe presents no recovery key. A
recovery-key design, as in the lost-response recovery guidance, is not
affected.

**Actor binding.** In the companion actor-profile capture, `act` was
byte-identical on the initial and refreshed tokens, the behavior that
`refresh.valid.actor-preserved` checks. That result predates the vector and is
not yet a run of it.

**Deployment note.** The server supports PAR but does not advertise
`require_pushed_authorization_requests`, so a client applying
`metadata.valid.required-fields` would reject its metadata. He treats this as
deployment configuration, not a protocol gap.

A fuller run covering PAR, DPoP-bound grants, and token exchange is planned.
This report is evidence from a second implementation, but it is
author-produced and partial; it does not close the independent-implementation
gap below.

## Remaining Evidence Gaps

These do not negate the implemented role behavior, but they block a broad or
independent interoperability claim:

1. No second independent implementation has completed an interop event.
2. No external OAuth certification suite currently identifies DAAP as a
   registered profile.
3. The repository includes a vendor-neutral behavioral corpus under
   `docs/ietf-draft/test-vectors/`. A second implementation has reported an
   author-produced partial run against it (above), but no independent
   implementation has yet reported results against it.
4. This source snapshot is not a hosted deployment until it is reviewed,
   released, and re-tested in production.

## Reviewer Note

This report applies only to the source revision that contains it and to the
tested configuration above. It is not a security certification, legal opinion,
standards approval, or claim that an undeployed hosted service has enabled the
new endpoints.
