# Decision grant profile

Status: draft for Grantex 0.6 (PRD G-3). Implemented by the auth service
(`apps/auth-service`, behind `DECISION_GRANTS_ENABLED`), the Python SDK
(`grantex.decisions`), the TypeScript SDK (`@grantex/sdk`) and
`@grantex/mcp-auth` (`grantexDecisionVerifier`).

A **decision grant** is a second credential, next to the agent's grant
token, that a named person mints for **one semantic action** on **one case**.
A tool whose manifest entry declares `"requires_decision": true` cannot be
called without one; with `four_eyes_on` listing the decision, it needs two,
from different people.

Keywords MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Roles

| Role | Does |
|---|---|
| Platform | Runs the workflow and the approvals surface (for example an approvals console). Creates decision requests, registers case versions, presents decisions to people, and holds the developer API key. |
| Approver | A named person, authenticated through one of the developer's OIDC SSO connections with step-up. |
| Issuer | The Grantex auth service. Mints, records, audits and consumes decision grants. |
| Enforcer | Whatever authorises the tool call: `enforce()` in an SDK, or an MCP server using `mcp-auth`. |

## 2. Semantic action and canonicalisation

The action is `{case_id, action, decision, subject, amount?}` and its hash is

```
action_hash = "sha256:" || base64url( SHA-256( UTF-8( JCS(action) ) ) )
```

with RFC 8785 canonicalisation and unpadded base64url. Field rules, the
derivation from a tool call and the shared test vectors are in
[`canonicalization.md`](canonicalization.md). The enforcer derives the action
from the call it is about to authorise: `action` is the tool name; `case_id`,
`decision`, `subject` and `amount` are read from the call's arguments; other
arguments are ignored. A re-planned payload, a new timestamp or a reordered
field therefore keep the decision valid, and a different case, tool,
decision, subject or amount invalidate it.

## 3. Token

A decision grant is a JWS compact JWT.

**Protected header**

| Parameter | Value |
|---|---|
| `typ` | `decision+jwt` (MUST). Verifiers MUST refuse any other value, so a grant token (`at+jwt`) is never accepted as a decision grant and vice versa. |
| `alg` | The platform signing algorithm (RS256 in 0.6). Verifiers MUST use an allowlist. |
| `kid` | Key identifier in the issuer's JWKS. |

**Claims**

| Claim | Type | Meaning |
|---|---|---|
| `iss` | string | Issuer. MUST equal the expected issuer. |
| `aud` | string | `urn:grantex:decision`. MUST be checked. |
| `sub` | string | The approver: `user:<identity-provider subject>`. |
| `jti` | string | `dgnt_` followed by a 26-character ULID. Single use. |
| `iat`, `exp` | integer | Issued at and expiry, seconds. `exp - iat` MUST NOT exceed 86400. |
| `dev` | string | Developer (tenant) the grant belongs to. |
| `idp` | string | Issuer of the approver's ID token. |
| `approver_auth` | string | How the approver authenticated: `sso` followed by `+<amr>` for each authentication method reported, sorted (for example `sso+hwk+pwd`), or `sso+acr` when only `acr` was reported. |
| `acr` | string | Optional. Authentication context class from the ID token. |
| `amr` | string[] | Authentication methods from the ID token (RFC 8176 values). |
| `auth_time` | integer | When the approver last authenticated with step-up. |
| `action` | object | The semantic action (section 2). |
| `action_hash` | string | Hash of `action`. Verifiers MUST recompute it and refuse a mismatch. |
| `connector` | string | Manifest connector of the tool. Not part of the hash; checked separately. |
| `case_version` | string | Case version the decision was taken on (section 5). |
| `dwell_ms` | integer | Milliseconds the approver spent on the decision before approving. |
| `decision_request` | string | `dreq_...` identifier of the decision request. |
| `memo_ref`, `policy_score_ref` | string | Optional. References to the memo and policy score shown to the approver. |
| `four_eyes` | object | Present when the decision needs two approvals: `{"approvals_required": 2, "position": 1}` on the first grant; `{"approvals_required": 2, "position": 2, "first_jti": "...", "first_sub": "..."}` on the second. |

Example (second approval of a four-eyes decline):

```json
{
  "iss": "https://grantex.dev", "aud": "urn:grantex:decision",
  "sub": "user:approver-b", "jti": "dgnt_01K8Z000000000000000000QA2",
  "iat": 1790000000, "exp": 1790086400,
  "dev": "dev_01", "idp": "https://idp.example.com",
  "approver_auth": "sso+hwk+pwd", "amr": ["hwk", "pwd"], "auth_time": 1789999900,
  "action": {"case_id": "case_8841", "action": "case_decision", "decision": "decline", "subject": "gb:00000001"},
  "action_hash": "sha256:dnbcKyONTJuAkycPknHk_dBSG_aKy0gupjhKwfFtewA",
  "connector": "acme_kyb", "case_version": "v7", "dwell_ms": 61250,
  "decision_request": "dreq_01K8Z000000000000000000QR1",
  "four_eyes": {"approvals_required": 2, "position": 2,
                "first_jti": "dgnt_01K8Z000000000000000000QA1", "first_sub": "user:approver-a"}
}
```

## 4. Minting

1. **Step-up.** The platform exchanges the approver's ID token from an active
   OIDC SSO connection of the developer (`POST /v1/decisions/approver-sessions`).
   The issuer MUST verify it against that connection (JWKS signature, issuer,
   audience, expiry), MUST accept each ID token once, and MUST require step-up:
   an `acr` in the configured list or an `amr` in the configured list, with
   `auth_time` inside the configured window (default one hour). The resulting
   approver session lasts until that window ends. Step-up happens once per
   session.
2. **Request.** The platform creates a decision request
   (`POST /v1/decisions/requests`) with the action, connector, case version,
   memo and policy-score references, and the manifest's `four_eyes_on` (or
   `approvalsRequired: 2`). A request lives at most 24 hours.
3. **Attestation.** The approval surface MUST show the memo, the policy
   score and the exact action and hash, and MUST measure the dwell time. The
   approver's one click sends `POST /v1/decisions/requests/{id}/approvals`
   with the approver session, the **action hash that was displayed** and the
   dwell time. The issuer MUST refuse a different hash (`action_mismatch`), a
   dwell time outside its configured range or longer than the request has
   existed, a changed case (`case_changed`), an expired request (`expired`) and
   an expired step-up (`step_up_required`). The issuer's own approval page
   measures dwell time itself, from rendering to submission.
4. **Four eyes.** The second grant is minted only after the first and names
   it. The issuer MUST refuse a second approval by the same `sub`, and SHOULD
   refuse one by the same email under another subject (`same_approver`).
5. **Audit.** The issuer MUST append the request, every approval (approver
   identity, identity provider, `approver_auth`, `acr`, `amr`, `auth_time`,
   `dwell_ms`, action, action hash, case version, four-eyes position), every
   consumption and refused consumption, case changes and cancellations to the
   developer's audit hash chain, in the same transaction as the change.

`exp` is the earlier of `iat + 86400` and the request's expiry.

## 5. Case-bound validity

A decision grant is valid until the first of: it is consumed; its case
changes; it expires (absolute ceiling 24 hours); its request is cancelled.

The platform chooses what a **case version** is: an opaque string (at most 128
printable ASCII characters) that changes whenever the case changes materially,
for example a hash of the evidence the decision was based on. It registers the
current version with `PUT /v1/decisions/cases/{caseId}`; a new version
supersedes open requests and revokes unconsumed grants for other versions.
Enforcers MUST pass the current version from their own case state (never from
the agent's arguments) and MUST refuse a grant for another version
(`case_changed`).

Wall-clock expiry alone would break against asynchronous provider calls that
outlast a short lifetime; case binding keeps a decision usable while the case
is unchanged, and no longer.

## 6. Verification and single use

An enforcer MUST, in this order:

1. Refuse a missing grant with `decision_required`.
2. Verify offline: `typ`, algorithm allowlist, signature, `iss`, `aud`,
   required claims, `jti` shape, `action_hash` = hash of `action`, lifetime
   at most 24 hours, `dev` equal to the agent grant's developer, then the
   action: `wrong_case` (different `case_id`), `action_mismatch` (different
   hash or connector), `case_changed`, `expired`.
3. For four eyes (the manifest lists the decision in `four_eyes_on`, **or**
   any presented grant carries `four_eyes`): require exactly two grants with
   different `jti` and `sub`, positions 1 and 2, the second naming the first's
   `jti` and `sub`, the same `decision_request` (`four_eyes_incomplete`,
   `same_approver`, `malformed`).
4. **Consume** every presented grant at the issuer
   (`POST /v1/decisions/consume`), atomically: all or none. Allow the call
   only if the issuer confirmed consumption of exactly the presented `jti`s.

Offline verification alone MUST NOT allow a call: a grant verified offline
can be replayed until it expires. The issuer consumes with a conditional
update in one transaction and re-checks the action, case version, expiry,
revocation and four eyes under row locks, so two concurrent consumptions of
one `jti` yield exactly one success.

An SDK SHOULD perform consumption after every other check of the call (in
`enforce()`, after caps are reserved) and release other reservations when
consumption fails. It MUST NOT retry a consumption request automatically.

## 7. Errors

Enforcers report `decision_required` (no grant) or `decision_invalid` with a
sub-reason. The first four are PRD Appendix B's.

| Sub-reason | Meaning |
|---|---|
| `action_mismatch` | The grant approves a different action (tool, decision, subject, amount) or connector; or the approval surface submitted a hash other than the request's. |
| `expired` | Past `exp`, or the decision request expired. |
| `consumed` | The grant was already used. |
| `same_approver` | The same person approved twice, or the same grant was presented twice. |
| `case_changed` | The case version differs from the one approved. |
| `wrong_case` | The grant is for another case (replay across cases). |
| `step_up_required` | Issuer only: the approver has not stepped up, or step-up is too old. |
| `four_eyes_incomplete` | Two approvals are needed and fewer were presented. |
| `revoked` | The request was cancelled. |
| `unknown_grant` | The issuer does not know the grant, or it belongs to another developer. |
| `malformed` | The grant, the action or the request cannot be read, or fails signature, issuer, audience or claim checks. |
| `consume_unavailable` | Enforcer only: the issuer could not confirm consumption. |
| `closed` | Issuer only: the request is not open for approval. |

The auth service answers refusals with `{"reason": "decision_invalid",
"subReason": "...", "code": "..."}`. `@grantex/mcp-auth` answers with the
`decision_required` challenge of [`mcp-auth-challenges.md`](mcp-auth-challenges.md)
and the sub-reason in the body; its reference verifier reads grants from the
`grantex-decision-grant` request header (two comma-separated grants for four
eyes).

## 8. Threat model

**Defends against**

- *An agent approving its own actions.* Only a person authenticated at an
  identity provider can obtain an approver session; the agent's grant token
  cannot mint decision grants, and `typ` separation stops one token type
  being used as the other.
- *A prompt-injected or re-planned agent swapping the action.* The grant is
  bound to the semantic action; any change to case, tool, decision, subject,
  amount or connector is refused.
- *Replay:* of a consumed grant (single use at the issuer), across cases
  (`case_id` in the hash), after the case changed (case version), after 24
  hours (ceiling), across tenants (`dev`).
- *Showing one action and signing another* (a compromised or buggy console
  changing the action between render and submit). The issuer requires the
  displayed action hash and binds it to the request.
- *One person satisfying four eyes.* Distinct `sub` enforced at minting (with
  a unique constraint) and again at verification and consumption, plus an
  email check at the issuer.
- *Races.* Concurrent approvals and consumptions serialise on row locks and
  unique constraints.
- *Undetected tampering with the record.* Approvals and consumptions are in
  the audit hash chain, written in the same transaction.

**Does not defend against**

- *A malicious or compromised platform holding the developer API key.* It
  can create requests for arbitrary actions and supply dwell times. It cannot
  mint a grant without an approver's step-up ID token, but it can put a
  misleading action in front of a real approver. Approvers must be able to
  trust the surface they approve on.
- *A compromised identity provider or approver account,* or a person who
  controls two identities at different identity providers without a shared
  email: four eyes compares identities, not humans.
- *Rubber-stamping.* Dwell time is recorded and exported (a histogram and
  audit entries) so an alert can catch it collapsing; a click is not proof of
  review. Dwell supplied by an approval surface is bounded but self-reported.
- *An enforcer that skips consumption* (offline verification only), or a tool
  that performs the action without calling `enforce()` at all. Decision grants
  protect the paths that check them.
- *A stale case version supplied by the platform.* The case version is only
  as current as the platform's own case state.
- *Issuer compromise or signing-key theft.*
- *Availability.* When the issuer is unreachable, decisions cannot be
  consumed and calls are refused (fail closed).

## 9. APIs

| | Python | TypeScript | Auth service |
|---|---|---|---|
| Approver session | `grantex.decisions.create_approver_session` | `grantex.decisions.createApproverSession` | `POST /v1/decisions/approver-sessions` |
| Case version | `set_case_version` | `setCaseVersion` | `PUT /v1/decisions/cases/{caseId}` |
| Request | `create_request`, `get_request`, `cancel_request` | `createRequest`, `getRequest`, `cancelRequest` | `POST /v1/decisions/requests`, `GET .../{id}`, `POST .../{id}/cancel` |
| Approve | `approve` | `approve` | `POST /v1/decisions/requests/{id}/approvals` |
| Approval page | `create_page_ticket` | `createPageTicket` | `POST .../{id}/page-tickets`, `GET/POST /decisions/{id}` |
| Verify offline | `verify_decision_grant(s)` | `verifyDecisionGrant(s)` | |
| Consume | `consume` | `consume` | `POST /v1/decisions/consume` |
| Enforce | `enforce(..., decision_grants, arguments or decision_action, case_version, decisions_mode)` | `enforce({..., decisionGrants, arguments or decisionAction, caseVersion, decisionsMode})` | |
| MCP | | `grantexDecisionVerifier` (`@grantex/mcp-auth`) | |

Shared test cases: `spec/examples/decision-grant/action-hash.json` and
`spec/examples/decision-grant/verification.json`.
