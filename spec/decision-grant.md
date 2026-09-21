# Decision grant profile

Status: draft for Grantex 0.6 (PRD G-3). Implemented by the auth service
(`apps/auth-service`, off unless `DECISION_GRANTS_ENABLED=true`), the Python
SDK (`grantex.decisions`), the TypeScript SDK (`@grantex/sdk`) and
`@grantex/mcp-auth` (`grantexDecisionVerifier`).

A **decision grant** is a second credential, next to the agent's grant token,
that a named person mints for **one semantic action** on **one case**. A tool
whose manifest entry declares `"requires_decision": true`, or that the agent's
grant lists in its `urn:grantex:decision:v1` entry (`grant-token-0.6.md`),
cannot be called without one; with the manifest's or that entry's
`four_eyes_on` listing the decision it needs two, from different people.

Keywords MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Roles and credentials

| Role | Credential | Can |
|---|---|---|
| Service administrator | `ADMIN_API_KEY` of the auth service | Allow-list the identity providers whose users may approve for a developer; disable them. |
| Platform (for example an approvals console or workflow engine) | Developer API key | Register case versions, create and cancel decision requests, read results, consume decision grants. **Cannot** add an identity provider, sign an approver in or approve. |
| Approver | A browser session on the auth service, created by signing in with an allow-listed identity provider with step-up | Review and approve decisions on the auth service's approval page. |
| Enforcer | Issuer's JWKS; developer API key for consumption | Verify decision grants and consume them before allowing a tool call: `enforce()`, or an MCP server with `grantexDecisionVerifier`. |

The separation is the point of the feature: nothing a developer API key or an
agent can do produces an approval.

## 2. Semantic action and canonicalisation

The action is `{case_id, action, decision, subject, amount?, extra?}` and

```
action_hash = "sha256:" || base64url( SHA-256( UTF-8( JCS(action) ) ) )
```

with RFC 8785 canonicalisation and unpadded base64url. Field rules, refused
characters, `extra` and the shared test vectors are in
[`canonicalization.md`](canonicalization.md).

The enforcer derives the action from the call it is about to authorise:
`action` is the tool name; `case_id`, `decision`, `subject`, `amount` and each
name the manifest lists in the tool's `decision_fields` (into `extra`) are read
from the call's arguments; other arguments are ignored. When a caller passes
both an explicit action and the arguments, they MUST hash identically.

**Only bound fields are approved.** A tool whose effect depends on an argument
that is not one of the core fields MUST declare it in `decision_fields`;
otherwise an approved decision can be carried out with any value of that
argument.

## 3. Token

A decision grant is a JWS compact JWT signed with the platform signing key
that signs grant tokens. The auth service verifies decision grants against
its signing key ring (the active key and the keys it keeps for verification
after a rotation), so a grant minted before a key rotation stays verifiable
for its lifetime; SDKs verify against the published JWK Set.

**Protected header**

| Parameter | Value |
|---|---|
| `typ` | `decision+jwt`. Verifiers MUST refuse any other value, so a grant token (`at+jwt`) is never accepted as a decision grant. |
| `alg` | `RS256` or `ES256`. Verifiers MUST use an allowlist. |
| `kid` | REQUIRED. Verifiers MUST select the key by `kid` (and key type) from the issuer's key set, never from the header alone. |

**Claims**

| Claim | Type | Meaning |
|---|---|---|
| `iss` | string | Issuer; MUST equal the expected issuer. |
| `aud` | string | `urn:grantex:decision`; MUST be checked. |
| `sub` | string | The approver: `user:<ns>:<sub>`, where `<sub>` is the identity provider's subject and `<ns>` the first 22 base64url characters of SHA-256 of the identity provider's issuer. The same `sub` at two identity providers is two approvers. |
| `jti` | string | `dgnt_` followed by a 26-character ULID. Single use. |
| `iat`, `exp` | integer | Issued at and expiry. `exp - iat` MUST NOT exceed 86400. |
| `dev` | string | Developer (tenant). |
| `idp` | string | Issuer of the approver's identity provider. |
| `approver_auth` | string | `sso` followed by `+<amr>` for each authentication method the identity provider reported, sorted (`sso+hwk+pwd`), or `sso+acr` when only `acr` was reported. |
| `acr` | string | Optional; from the ID token. |
| `amr` | string[] | From the ID token (RFC 8176 values). |
| `auth_time` | integer | When the approver last authenticated with step-up. |
| `action` | object | The semantic action (section 2). |
| `action_hash` | string | Hash of `action`; verifiers MUST recompute it. |
| `connector` | string | Manifest connector of the tool; checked by verifiers, not part of the hash. |
| `case_version` | string | Case version the decision was taken on (section 5). |
| `dwell_ms` | integer | Milliseconds from rendering the approval page to its submission, measured by the auth service. |
| `dwell_source` | string | `server`. Verifiers MUST refuse any other value. |
| `memo_hash` | string | `sha256:` base64url SHA-256 of the memo text shown to the approver. |
| `policy_score_hash` | string | `sha256:` base64url SHA-256 of the RFC 8785 canonical JSON of the policy score shown. |
| `memo_ref`, `policy_score_ref` | string | Optional platform references to the memo and policy score. |
| `decision_request` | string | `dreq_...` identifier of the decision request. |
| `four_eyes` | object | For a two-approver decision: `{"approvals_required": 2, "position": 1}` on the first grant; `{"approvals_required": 2, "position": 2, "first_jti": "...", "first_sub": "..."}` on the second. |

Example (the second approval of a four-eyes decline):

```json
{
  "iss": "https://grantex.dev", "aud": "urn:grantex:decision",
  "sub": "user:bil3roIxTbMBJLooUOGo1Z:approver-b", "jti": "dgnt_01K8Z000000000000000000QA2",
  "iat": 1790000000, "exp": 1790086400,
  "dev": "dev_01", "idp": "https://idp.example.com",
  "approver_auth": "sso+hwk+pwd", "amr": ["hwk", "pwd"], "auth_time": 1789999900,
  "action": {"case_id": "case_8841", "action": "case_decision", "decision": "decline", "subject": "gb:00000001"},
  "action_hash": "sha256:dnbcKyONTJuAkycPknHk_dBSG_aKy0gupjhKwfFtewA",
  "connector": "acme_kyb", "case_version": "v7",
  "dwell_ms": 61250, "dwell_source": "server",
  "memo_hash": "sha256:MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM",
  "policy_score_hash": "sha256:PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
  "decision_request": "dreq_01K8Z000000000000000000QR1",
  "four_eyes": {"approvals_required": 2, "position": 2,
                "first_jti": "dgnt_01K8Z000000000000000000QA1", "first_sub": "user:bil3roIxTbMBJLooUOGo1Z:approver-a"}
}
```

## 4. Minting

### 4.1 Approver identity providers

The service administrator allow-lists an OpenID Connect client for a developer
(`POST /v1/admin/developers/{developerId}/decision-approver-idps` with
`ADMIN_API_KEY`): issuer, client id, optional client secret (stored encrypted),
optional `acr_values`, whether a verified email is required, and the operator
making the change (`actor`), which is recorded in the developer's audit chain.
The developer's SSO connections play no part.

### 4.2 Sign-in and step-up

1. An approver opens the approval page `/decisions/{requestId}` on the auth
   service. Without a session the page offers the developer's allow-listed
   identity providers.
2. `/decisions/login` starts an authorization code flow: `state` (single use,
   bound to the browser with a `__Host-` cookie), `nonce`, PKCE S256,
   `max_age` equal to the step-up window, and `acr_values` when configured.
3. `/decisions/callback` consumes the state, exchanges the code, and verifies
   the ID token:
   - the discovery document's `issuer` MUST equal the configured issuer;
   - the signature MUST verify with a key selected by `kid` from the
     provider's JWKS (asymmetric algorithms only; an unknown `kid` refetches
     the set at most once per cooldown);
   - `iss`, `aud` (the client id), `azp` (MUST equal the client id when
     present, and MUST be present with several audiences), `exp`, `iat`
     (recent), `nonce`, `sub`;
   - step-up: an `acr` in the configured list or an `amr` in the configured
     list (default `mfa`, `hwk`), with `auth_time` inside the window (default
     one hour);
   - when the identity provider requires it, a verified email
     (`email_verified: true`).
   A nonce is accepted once per issuer and subject.
4. The service creates a session and sets its secret only as a
   `__Host-grantex_decision_session` cookie (HttpOnly, Secure, SameSite=Lax,
   Path=/). No API returns it. The session ends when the step-up window ends,
   when the approver signs out, or when its identity provider is disabled.

### 4.3 Decision requests

The platform creates a request (`POST /v1/decisions/requests`) with the action,
the connector, the case version, the memo text and the policy score (a JSON
object), and the tool's `four_eyes_on` (from the manifest and the grant's
decision entry). The service stores the memo and
policy score with their hashes. A request lives at most 24 hours. Request
bodies with duplicate member names are refused.

### 4.4 Approval

The approval page shows the memo, the policy score and the exact action with
its hash, all HTML-escaped, with a Content-Security-Policy that allows no
script and no framing, and `Referrer-Policy: same-origin` (under
`no-referrer` browsers send `Origin: null` on the page's own form posts). The
approver's one click posts a form. The service MUST refuse unless:

- the session cookie is valid and step-up is still within the window;
- the CSRF token (HMAC of session, request and rendering) matches;
- `Origin` is present and equal to the service's origin, and
  `Sec-Fetch-Site` is present and `same-origin` (a request without either
  header is refused);
- the submitted action hash is the request's (`action_mismatch`);
- the request is pending and unexpired and its case version is current
  (`closed`, `expired`, `case_changed`);
- the page was rendered to this session and not yet submitted, and at least
  the configured minimum dwell time (default 2 seconds) has passed
  (`dwell_too_short`);
- for four eyes, the approver is not the first approver: neither the same
  `sub` nor the same verified email (`same_approver`).

Dwell time is measured from two database timestamps (rendering, submission);
no client supplies it. The decision grant is minted in the same transaction
that records the approval. The second four-eyes grant names the first.

**Attestation.** The signed decision grant is the attestation: it binds the
approver, their authentication, the action hash, the memo and policy score
hashes and the measured dwell time. A per-decision signature by a key
generated in the browser was considered and not adopted: such a key is usable
by any script running on the service's origin, exactly as the HttpOnly
session is, so it would add script to the page without separating any
attacker the session does not already separate.

### 4.5 Audit

The service appends to the developer's audit hash chain, each in the
transaction it records: identity-provider changes (with the operator), sign-ins
(identity provider, `approver_auth`, `acr`, `amr`, `auth_time`), requests,
approvals (approver `sub`, identity provider, authentication method, dwell
time and source, action, action hash, memo and policy score hashes, four-eyes
position), consumptions, refused consumptions (with the attempted action and
hash), case changes and cancellations. Approver emails are stored only as keyed
hashes and names encrypted.

## 5. Case-bound validity

A decision grant is valid until the first of: it is consumed; its case changes;
it expires (absolute ceiling 24 hours, and never after its request); its
request is cancelled.

The platform chooses what a case version is: an opaque string (at most 128
printable ASCII characters) that changes whenever the case changes materially,
for example a hash of the evidence the decision is based on. It registers the
current version with `PUT /v1/decisions/cases/{caseId}`; a new version
supersedes open requests and revokes unconsumed grants for other versions.
Enforcers MUST pass the current version from their own case state, never from
the agent's arguments, and MUST refuse a grant for another version
(`case_changed`).

## 6. Verification and single use

An enforcer MUST, in this order:

1. Refuse a missing grant with `decision_required`.
2. Verify each grant offline: `typ`, `kid`, algorithm allowlist, signature,
   `iss`, `aud`, required claims, `jti` shape, `action_hash` equals the hash
   of `action`, lifetime at most 24 hours, `dwell_source` is `server`,
   `memo_hash` and `policy_score_hash` present, `dev` equals the agent grant's
   developer (`unknown_grant`); then `wrong_case`, `action_mismatch` (hash or
   connector), `case_changed`, `expired`.
3. For four eyes (the manifest or the grant's decision entry lists the
   decision in `four_eyes_on`, **or**
   any presented grant carries `four_eyes`): exactly two grants, different
   `jti` and `sub`, positions 1 and 2, the second naming the first's `jti` and
   `sub`, the same `decision_request` (`four_eyes_incomplete`,
   `same_approver`, `malformed`).
4. **Consume** every presented grant at the issuer
   (`POST /v1/decisions/consume`), all or none, and allow the call only if the
   issuer confirmed exactly the presented `jti`s. The issuer answers with
   `requestId`, `actionHash`, `jtis` and one `approvers` entry per consumed
   grant (`sub`, `approver_auth`, `dwell_ms`, `dwell_source`, and the `jti` of
   the grant it came from), so a platform recording who decided pairs each
   approver with their own grant rather than by array position.

Offline verification alone MUST NOT allow a call. The issuer consumes with a
conditional update in one transaction, re-checking the action, case version,
expiry, revocation and four eyes (subjects and verified-email hashes) under row
locks, so two concurrent consumptions of one `jti` yield exactly one success.
Every refusal is audited; if the refusal cannot be recorded the issuer answers
503 and nothing is consumed.

An SDK SHOULD consume after every other check of the call (in `enforce()`,
after caps are reserved), MUST refund those reservations and deny when
consumption fails for any reason, and MUST NOT retry a consumption request.

**Consumption spends the grant.** If the consumption response is lost, or the
tool call fails after consumption, the grant stays spent; a person has to
approve again. Platforms SHOULD make the tool call idempotent per decision
request.

## 7. Errors

`decision_required` (no grant) or `decision_invalid` with a sub-reason. The
first four are PRD Appendix B's.

| Sub-reason | Where | Meaning |
|---|---|---|
| `action_mismatch` | issuer, enforcer | Another action (tool, decision, subject, amount, extra field) or connector; an approval of a hash other than the request's; an explicit action that differs from the call's arguments. |
| `expired` | issuer, enforcer | Past `exp`, or the request expired. |
| `consumed` | issuer, enforcer | Already used. |
| `same_approver` | issuer, enforcer | The same approver twice, or the same grant twice. |
| `case_changed` | issuer, enforcer | The case version differs from the one approved. |
| `wrong_case` | issuer, enforcer | The grant is for another case. |
| `four_eyes_incomplete` | issuer, enforcer | Two approvals needed, fewer presented. |
| `revoked` | issuer | The request was cancelled. |
| `unknown_grant` | issuer, enforcer | Unknown to the issuer, or another developer's. |
| `malformed` | issuer, enforcer | Unreadable, bad signature, key, issuer, audience, claims, `dwell_source`; a verifier without the developer or connector to check against. |
| `consume_unavailable` | enforcer | The issuer could not confirm consumption. |
| `step_up_required` | issuer (sign-in, approval) | No step-up, or step-up too old. |
| `authentication_failed` | issuer (sign-in) | The ID token failed verification. |
| `dwell_too_short` | issuer (approval) | Approved faster than the minimum dwell time. |
| `closed` | issuer (approval) | The request is not open for approval. |

The auth service answers API refusals with `{"reason": "decision_invalid",
"subReason": "...", "code": "..."}`. `@grantex/mcp-auth` answers with the
`decision_required` challenge of
[`mcp-auth-challenges.md`](mcp-auth-challenges.md) and the sub-reason in the
body; its reference verifier reads grants from the `grantex-decision-grant`
request header (two comma-separated grants for four eyes). The FastAPI
`GrantexEnforcer` reads the same header, the arguments from the JSON body and
the case version from a server-side callback, and answers 403 with
`reason_code` and `sub_reason`.

A tool listed in the agent grant's `urn:grantex:decision:v1` entry
(`grant-token-0.6.md`) needs a decision grant even when its manifest does not
declare `requires_decision`, and a decision in that entry's `four_eyes_on`
needs two approvers. `enforce()` in both SDKs and `@grantex/mcp-auth` apply
this; a token whose decision entries cannot be read is refused.

## 8. Threat model

**Defends against**

- *The platform or an agent approving on its own.* Approvals exist only as
  form posts from a browser session created by the service's own sign-in flow
  with an identity provider only the service administrator can allow-list. The
  developer API key has no approval, sign-in or identity-provider API; the
  session secret is never returned to an API caller; `typ` separation stops a
  grant token being used as a decision grant.
- *Replaying someone's ID token.* The sign-in state is single use and bound to
  the browser that started it, the nonce is checked and accepted once per
  issuer and subject, `azp` and audience are checked, and discovery must name
  the configured issuer.
- *Forged dwell time.* Only server-measured dwell is accepted, and approvals
  faster than a minimum are refused.
- *A prompt-injected or re-planned agent changing the action.* The grant is
  bound to the semantic action (and declared `decision_fields`); any change is
  refused.
- *Replay:* of a consumed grant (single use at the issuer), across cases, after
  the case changed, after 24 hours, across tenants.
- *Showing one action and signing another.* The page shows the stored action,
  memo and policy score; the submitted hash must be the request's; the memo and
  policy score hashes are in the grant.
- *Cross-site submission and framing.* CSRF token, required `Origin`,
  `Sec-Fetch-Site`, SameSite cookie, `frame-ancestors 'none'`, no script.
- *One identity satisfying four eyes.* Distinct namespaced `sub` and distinct
  verified-email hash, enforced at approval (with a unique constraint) and at
  consumption; SDKs check distinct `sub` offline.
- *Races.* Approvals and consumptions serialise on row locks and unique
  constraints.
- *Undetected tampering with the record.* Every step is in the audit hash chain.

**Does not defend against**

- *A compromised or malicious service administrator,* who can allow-list an
  identity provider they control.
- *A compromised identity provider or approver account,* or one person holding
  two identities without a shared verified email.
- *Misleading content.* The platform writes the memo and policy score; the page
  shows them faithfully, but a person can be misled by what the platform wrote.
- *Rubber-stamping.* A minimum dwell time and a dwell-time histogram make it
  visible, not impossible.
- *Script injection on the auth service's origin.* It could act within an
  approver's session (section 4.4).
- *Arguments outside the bound fields,* when a manifest omits a meaningful
  argument from `decision_fields`.
- *An enforcer that skips consumption,* or a tool that acts without calling
  `enforce()`.
- *A stale case version* supplied by the platform.
- *Issuer compromise or signing-key theft.*
- *Availability.* When the issuer is unreachable, decisions cannot be consumed
  and calls are refused (fail closed).

## 9. APIs

| | Python | TypeScript | Auth service |
|---|---|---|---|
| Approver identity providers | | | `POST`, `GET /v1/admin/developers/{id}/decision-approver-idps`, `POST .../{idpId}/disable` (admin credential) |
| Case version | `grantex.decisions.set_case_version` | `grantex.decisions.setCaseVersion` | `PUT /v1/decisions/cases/{caseId}` |
| Request | `create_request`, `get_request`, `cancel_request` | `createRequest`, `getRequest`, `cancelRequest` | `POST /v1/decisions/requests`, `GET .../{id}`, `POST .../{id}/cancel` |
| Sign in and approve | | | `GET /decisions/{id}`, `GET /decisions/login`, `GET /decisions/callback`, `POST /decisions/{id}`, `POST /decisions/logout` (browser only) |
| Verify offline | `verify_decision_grant(s)` | `verifyDecisionGrant(s)` | |
| Consume | `consume` | `consume` | `POST /v1/decisions/consume` |
| Enforce | `enforce(..., decision_grants, arguments and/or decision_action, case_version, decisions_mode)`; `wrap_tool(..., decision_grants, case_version)`; FastAPI `GrantexEnforcer(..., case_version=...)` | `enforce({..., decisionGrants, arguments and/or decisionAction, caseVersion, decisionsMode})`; `wrapTool`, `enforceMiddleware` | |
| MCP | | `grantexDecisionVerifier` (`@grantex/mcp-auth`) | |

Shared test cases: `spec/examples/decision-grant/action-hash.json` and
`spec/examples/decision-grant/verification.json`. The whole flow (admin
allow-list, request, browser sign-in with step-up and approval, `enforce()`
in both SDKs, replay and four eyes) runs in Chromium against the auth service
in `apps/auth-service/tests/e2e/decision-grants-browser.e2e.test.ts`.
