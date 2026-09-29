# Passport binding at grant issuance

Status: draft (Agent Trust Registry, Phase 1; PRD §8.4, §7 "Consent-time
presentation", §5 GrantPassportBinding, Appendix B; owner decision 1).
Implemented by the auth service behind `PASSPORT_BOUND_GRANTS_ENABLED`, off by
default. Off, every authorization and token path behaves exactly as before:
the `passport` member of an authorization request is ignored, as every member
the route does not know is.

Keywords MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

This annex says how an Agent Passport presented when a grant is requested is
checked, and how the grant is bound to it. Two rules frame it:

- **Passport ≠ grant.** The Agent Passport ([agent-passport-1.0.md](agent-passport-1.0.md))
  is the credential an accredited issuer gives an agent: who provides it, what
  software it is, which key it holds. The grant is the delegation a Principal
  gives it. A passport never authorizes anything; a grant may be *bound* to
  one, and then carries a reference to it, never the passport itself. See
  [docs/concepts/passport-vs-grant.md](../docs/concepts/passport-vs-grant.md).
- **Key equality** ([agent-passport-1.0.md](agent-passport-1.0.md) §7). The
  passport's `cnf` key, the attestation's `key_thumbprint`, a key in the
  agent's history (`agent_keys`, [agent-keys.md](agent-keys.md)) and the grant
  token's `cnf.jkt` are the same key: their RFC 7638 SHA-256 thumbprints are
  equal.

Normative references: RFC 9396 (Rich Authorization Requests) §2, §5, §6 and
§9.1; RFC 8693 (Token Exchange) §2.1, §2.2 and §4.1; RFC 6749 §5.2 and
Appendix B; RFC 6454 §6.2; RFC 9449 §6.1 (`cnf.jkt`); RFC 7638 §3; RFC 9901 §4 and §7.1;
draft-ietf-oauth-sd-jwt-vc-19 §2.2.1 and §2.2.2.3;
draft-ietf-oauth-status-list-21 §6.2 and §7.1.

## 1. Where a passport is accepted

Only `POST /v1/authorize` (the developer authorization request) takes a
passport, in the JSON member `passport`. `POST /oauth/par` and
`GET /oauth/authorize` (the OAuth agent-grants profile) do not in Phase 1; a
`passport` sent there is ignored as it was before. The consent surface of
`@grantex/mcp-auth` 3.0 is Phase 3.

<!-- example: authorize-request -->
```json
{
  "agentId": "ag_01J8Z3K4M5N6P7Q8R9S0T1V2W3",
  "principalId": "user_shopper",
  "scopes": ["read"],
  "audience": "https://merchant.example/checkout",
  "passport": "eyJhbGciOiJFUzI1NiIsInR5cCI6ImRjK3NkLWp3dCIsImtpZCI6ImsxIn0.eyJpc3MiOiJodHRwczovL2lzc3Vlci5leGFtcGxlIn0.c2lnbmF0dXJl~WyJzYWx0IiwiYXR0ZXN0YXRpb25faWQiLCJhdHQtMDEiXQ~"
}
```

The passport in the example is shortened and does not verify.

## 2. The parameter

`passport` is the Agent Passport as the holder presents it: the issuer-signed
JWT and the disclosures it chooses, ending with `~` (RFC 9901 §4). It is at
most 16 384 characters. Anything else is `passport_malformed` (`not_sd_jwt`,
`too_large`) before anything is read.

A request with a passport MUST name an `audience`, one of the agent's
registered resource servers, as without one: the rail or verifier the grant is
for, which becomes the grant token's `aud`. A passport without `audience` is
`400 RESOURCE_REQUIRED`.

## 3. No key binding at consent

A consent-time presentation carries **no** Key Binding JWT; one that does is
refused (`passport_malformed`, `unexpected_key_binding`). Possession of the
passport's key is established by the registry instead: the key must be in the
agent's key history with its possession proven (`agent_keys`), and the grant
is bound to it through `cnf.jkt`, so every use of the grant is a proof by
that key (RFC 9449). A KB-JWT at consent would prove the same key again, to a
registry that has no nonce of its own in the flow.

## 4. The checks (PRD §8.4)

The registry checks, in this order, and stops at the first refusal. Every
refusal carries a PRD Appendix C code (or the profile's `passport_malformed`
and `passport_not_accepted`), a `reason`, and records no authorization
request.

| Step | Rule | Refusal |
|---|---|---|
| 1 | `passport` is a non-empty string of at most 16 384 characters. | `passport_malformed` |
| 2 | The passport's `iss` is an accredited issuer, accredited for `urn:grantex:tm:agent.identity` and not suspended now. Asked before the signature, as attestation ingestion does, so an unknown or suspended issuer is refused as such. | `issuer_not_accredited`, `issuer_suspended`, `trust_mark_missing` |
| 3 | The passport verifies as [agent-passport-1.0.md](agent-passport-1.0.md) §4 steps 1 to 7 describe, with the issuer key the registry recorded for its `iss` and `kid` only (owner decision 7; a passport without `kid` has no key), 60 seconds of clock skew, EdDSA only with `REGISTRY_ATTESTATION_EDDSA_ENABLED=true`, and a P-256 `cnf` key when the agent declares a payments rail. | `passport_malformed`, `passport_not_accepted`, `passport_invalid_signature`, `passport_expired` |
| 4 | Its `sub` is the requesting agent's DID. | `attestation_mismatch` (`subject_mismatch`) |
| 5 | It discloses `attestation_id`, and the same issuer registered an `agent.identity` attestation with that id; the attestation's `external_credential_hash` is the passport's (hash rule, [agent-passport-1.0.md](agent-passport-1.0.md) §6); the attestation is still `accepted`; its `exp` is after now (attestations never move to an expired state, so their `exp` is read); it is for this agent; and its status entry is the passport's `status.status_list`. | `attestation_not_registered`, `attestation_hash_mismatch`, `attestation_not_accepted`, `passport_expired` (`attestation_expired`), `attestation_mismatch` |
| 6 | Both status sources: the registry's acceptance entry for the attestation is VALID (draft-ietf-oauth-status-list-21 §7.1), and the issuer's status for it is valid and fresh. When the registry's last read of the issuer's list is past its freshness, the list is read again now. | `passport_revoked` (`acceptance_suspended`, `acceptance_invalid`, `suspended`, `invalid`), `status_stale` |
| 7 | The passport's `cnf` key thumbprint is the attestation's `key_thumbprint`, and a usable key of the agent: active, or rotated and still inside its overlap. | `key_binding_mismatch`, `key_unproven`, `key_not_active` |
| 8 | The requested scopes are within the attestation's `declared_limits`, and a `declared_limits` the passport discloses is the attestation's. | `attestation_mismatch` (`scope_not_declared`, `declared_limits_unreadable`, `declared_limits_differ`) |

`declared_limits` is the issuer's; the registry reads one member of it here.
`scopes`, when present, is the list of scopes the issuer checked the agent
declares, and every requested scope must be in it. Other members (amounts,
currencies) have no counterpart in an authorization request; they are shown
at consent (§6) and stay bound to the grant through its attestation.

Every `attestation_mismatch` writes an audit entry on the developer's chain,
action `grantex.passport.attestation_mismatch`, with the reason, the issuer,
the issuer's and the registry's attestation ids and, for `scope_not_declared`,
the scopes outside the declared limits. Reporting it to the issuer is Phase 2.

HTTP status: `400` for `passport_malformed` and `passport_not_accepted`; `503`
for `status_stale`; `403` for every other code. The API key authenticated the
request, so a refused passport is never `401`.

| Code | HTTP |
|---|---|
| `passport_malformed` | 400 |
| `passport_not_accepted` | 400 |
| `passport_invalid_signature` | 403 |
| `passport_expired` | 403 |
| `passport_revoked` | 403 |
| `issuer_not_accredited` | 403 |
| `issuer_suspended` | 403 |
| `trust_mark_missing` | 403 |
| `attestation_not_registered` | 403 |
| `attestation_hash_mismatch` | 403 |
| `attestation_not_accepted` | 403 |
| `attestation_mismatch` | 403 |
| `key_binding_mismatch` | 403 |
| `key_not_active` | 403 |
| `key_unproven` | 403 |
| `status_stale` | 503 |

`level_below_policy`, `audience_mismatch`, `request_signature_invalid` and
`request_signature_stale` are not produced here: no trust-level policy applies
at authorization in Phase 1, and the request is authenticated by the API key.
`audience_mismatch` is the child grant exchange's (§8).

Every step fails closed. A database or network error is an error (`500`), and
an issuer list that cannot be read is `status_stale`, never a pass.

## 5. The binding

The request records what the grant will be bound to, and the code exchange
writes it to `grant_passport_bindings` (migration 125) in the transaction that
writes the grant: the issuer, the issuer's attestation id, the registry's
attestation id, the passport's external credential id, its hash, the key
thumbprint, the registry's acceptance entry (`uri`, `idx`) and the passport's
`exp`. A later cascade finds every grant bound to a passport through its
indexes.

A bound grant never outlives its passport or its attestation. The code
exchange sets the grant's `expires_at` (and the token's `exp`) to the earlier
of the requested lifetime (`expiresIn`) and the `exp` of the passport and of
its attestation; a shorter requested lifetime is kept. The refresh token
never outlives the grant, as for any grant.

The grant token carries, in `authorization_details` (RFC 9396 §2, §9.1), after
any other entries, one entry of type `urn:grantex:commerce:v1`:

<!-- example: commerce-detail -->
```json
{
  "type": "urn:grantex:commerce:v1",
  "passport": {
    "issuer": "https://issuer.example",
    "id": "att-01",
    "hash": "sha-256:vDGKR0eipzfsrEgKMqXzI0NWGjZnjYVkBXW4Vf6PjcE",
    "key_thumbprint": "gzr6dlS40bV-rn_SVrIuqv36jX1W6ZnTeGkVbXr-SgY"
  },
  "acceptance_status": {
    "uri": "https://registry.example/status/attestations/racl_01J8Z3K4M5N6P7Q8R9S0T1V2W3",
    "idx": 4127
  }
}
```

| Member | Value |
|---|---|
| `passport.issuer` | The passport's `iss`, the accredited issuer's `entity_id`. |
| `passport.id` | The passport's `attestation_id`: the id under which its issuer registered it. |
| `passport.hash` | The hash rule applied to the passport. It identifies the bytes, and MUST NOT be relied on alone to deny ([agent-passport-1.0.md](agent-passport-1.0.md) §6). |
| `passport.key_thumbprint` | The RFC 7638 thumbprint of the passport's `cnf` key. |
| `acceptance_status` | The registry's acceptance entry for the attestation, a Token Status List reference (draft-ietf-oauth-status-list-21 §6.2) a relying party resolves to learn whether the registry still accepts it. |

The token's `cnf.jkt` (RFC 9449 §6.1) is the same thumbprint, so the grant is
sender-constrained to the passport's key; its `aud` is the request's
`audience`. The existing entry types (`urn:grantex:tools:v1`,
`urn:grantex:decision:v1`, the budget entry) are unchanged and come first.
`grants.authorization_details` keeps only those: the commerce entry is rebuilt
from `grant_passport_bindings` at every issuance and refresh.

Before a bound grant's token is issued (code exchange) or refreshed, the
registry checks its own records again, with the same two status sources as at
authorization (§4 step 6):

| Rule | Refusal |
|---|---|
| The issuer is still accredited for `urn:grantex:tm:agent.identity` and not suspended. | `issuer_not_accredited`, `issuer_suspended`, `trust_mark_missing` |
| The attestation is still registered, `accepted`, and unchanged (same agent, key thumbprint and hash). | `attestation_not_registered`, `attestation_not_accepted`, `attestation_mismatch` (`binding_changed`) |
| Neither the passport's `exp` nor the attestation's `exp` has passed. | `passport_expired` (`expired`, `attestation_expired`) |
| The registry's acceptance entry is VALID. | `passport_revoked`, `attestation_not_registered` |
| The issuer's recorded status is valid and fresh. | `passport_revoked`, `status_stale` |
| The key is still usable by the agent. | `key_unproven`, `key_not_active` |

No network is read inside the issuing transaction. When the issuer's recorded
status is past its freshness (the recheck worker keeps it current, but the
issuer's list may be unreadable), the transaction is left, the issuer's list is
read again and recorded, and the checks run once more against the instant the
request arrived. A list that cannot be read is `status_stale` (`503`); a read
past its freshness is never relied on. A refusal carries its code; the
authorization code or the refresh token is not consumed.

A request authorized with a passport keeps its binding if the flag is turned
off before the exchange: turning the flag off stops new bindings and never
strips one a Principal consented to. Reporting the key compromised through
`POST /v1/agents/{id}/keys/{thumbprint}/compromise` denies every pending or
approved request bound to it, as for any key-bound request.

A passport-bound grant is not delegated in Phase 1. With the flag on,
`POST /v1/grants/delegate` refuses a parent grant that has a binding with
`403` `PASSPORT_BOUND_DELEGATION_UNSUPPORTED` and writes nothing: a delegated
grant would carry no binding, so it would escape the rechecks above and outlive
a revoked or suspended passport. PRD §8.6 delegation, where the sub-agent binds
its own passport and the parent's binding is carried in `act.passport`, is
later work. With the flag off, a delegated grant does not inherit the binding
(FINDINGS G-130). The refusal covers per-merchant children too (§8.6).

## 6. Consent

`GET /v1/consent/{id}` returns `agentPassport` for a request that carries a
passport, and the consent page shows it before the Principal decides:

<!-- example: consent-view -->
```json
{
  "trustLevel": "attested",
  "verificationLevel": "substantial",
  "issuers": ["https://issuer.example"],
  "declaredLimits": { "max_transaction": { "amount": "250.00", "currency": "EUR" } },
  "softwareName": "Nimbus Shopper",
  "softwareVersion": "2.4"
}
```

`trustLevel` is the registry's computed level for the agent when the request
was checked; `verificationLevel` the issuer's level from the attestation,
verbatim; `issuers` the passport's issuer and the issuers of the attestations
the level counts; `declaredLimits` the attestation's.

With the flag on, a request whose `authorization_details` named commerce
constraints (§8.1) also returns them, next to `agentPassport`, as
`commerceConstraints`, and the consent page shows them (the merchants, the
amount per payment and the total budget) before the Principal decides:

<!-- example: consent-commerce-constraints -->
```json
{
  "allowedMerchants": ["https://merchant.example", "https://shop.merchant.example"],
  "amountRange": { "currency": "EUR", "max": "250.00" },
  "budget": { "amount": "500.00", "currency": "EUR" }
}
```

`allowedMerchants` is always present; `amountRange` and `budget` only when
the request named them. A request without commerce constraints, or any
request with the flag off, has no `commerceConstraints`.

## 7. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PASSPORT_BOUND_GRANTS_ENABLED` | `false` | `true` (exactly) reads `passport` and `authorization_details` on `POST /v1/authorize` and takes the token exchange on `POST /v1/token` (§8), as this annex describes. Any other value, or unset, ignores them and answers a token exchange as before. |

No new endpoint is added.

## 8. Per-merchant child grants

Status: PRD §8.5 and §8.6, Appendix B (child grant); owner decision 3.

A bound grant may be for more than one merchant. Before it is used at one, it
is exchanged (RFC 8693) for a **child grant** for that merchant alone: a
short-lived token whose `aud` is the merchant, sender-constrained to the same
key, bound to the same passport, and never wider than its parent.

### 8.1 Naming the merchants

With the flag on, `POST /v1/authorize` with a `passport` may carry
`authorization_details` (RFC 9396 §2): an array with exactly one entry of type
`urn:grantex:commerce:v1`:

<!-- example: authorize-commerce-details -->
```json
[
  {
    "type": "urn:grantex:commerce:v1",
    "allowed_merchants": ["https://merchant.example", "https://shop.merchant.example"],
    "amount_range": { "currency": "EUR", "max": "250.00" },
    "budget": { "amount": "500.00", "currency": "EUR" }
  }
]
```

| Member | Rule |
|---|---|
| `allowed_merchants` | Required. 1 to 50 distinct `https` origins, each exactly as it serializes (RFC 6454 §6.2): lower case, no path, no trailing slash, no default port. Decision 3: a child's `aud` must equal one of them. |
| `amount_range` | Optional. `currency` (ISO 4217), `max` and an optional `min`: decimal strings with at most 6 decimals, `min` at most `max`. |
| `budget` | Optional. `amount` (a decimal string) and `currency`: the most the grant may spend in all. |

An entry of another type, a second entry, an unknown member (`passport` and
`acceptance_status` included: the registry sets them) or a malformed value is
refused `400 invalid_authorization_details` (RFC 9396 §5) before anything is
read, and no request is recorded. With the flag on, `authorization_details`
without a `passport` is refused the same way (`passport_required`): there
would be no binding to carry it. With the flag off it is ignored, as every
unknown member is.

The constraints are kept with the binding
(`grant_passport_bindings.commerce_constraints`, migration 126) and added to
the grant token's `urn:grantex:commerce:v1` entry, after `acceptance_status`,
at every issuance and refresh. A bound grant authorized without them names no
merchant: it cannot be exchanged for a child (`audience_mismatch`).

### 8.2 The exchange

`POST /v1/token`, authenticated by the developer's API key, with the RFC 8693
§2.1 parameters, form-encoded (RFC 6749 Appendix B) or as the members of a
JSON object, and a `DPoP` header (RFC 9449 §4) proving possession of the key
the parent is bound to. In a form body `authorization_details` is a JSON
string; a JSON body may carry the array itself:

<!-- example: exchange-request -->
```json
{
  "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
  "subject_token": "<the parent grant token>",
  "subject_token_type": "urn:ietf:params:oauth:token-type:access_token",
  "resource": "https://merchant.example",
  "scope": "read",
  "authorization_details": [
    { "type": "urn:grantex:commerce:v1", "amount_range": { "currency": "EUR", "max": "20.00" } }
  ]
}
```

| Parameter | Rule |
|---|---|
| `grant_type` | `urn:ietf:params:oauth:grant-type:token-exchange`. |
| `subject_token` | A token of a passport-bound grant of this developer, not itself a child. |
| `subject_token_type` | `urn:ietf:params:oauth:token-type:access_token`. |
| `resource`, `audience` | Together they name exactly one merchant (the same value may be given as both): an `https` origin as it serializes. Several distinct values, or a value that is not an origin, are `invalid_target` (RFC 8693 §2.1.1, §2.2.2). |
| `requested_token_type` | Optional; `urn:ietf:params:oauth:token-type:access_token` when given. |
| `scope` | Optional; a subset of the parent's scopes (`invalid_scope`, RFC 6749 §5.2). By default, the parent's. |
| `authorization_details` | Optional; one `urn:grantex:commerce:v1` entry asking for narrower constraints (RFC 9396 §6). |
| `actor_token`, `actor_token_type` | Not accepted (`invalid_request`): a child is for the same agent; see §8.6. |

| Header | Rule |
|---|---|
| `DPoP` | Required. One DPoP proof JWT (RFC 9449 §4.2): `typ` `dpop+jwt`, an asymmetric `alg`, the public `jwk` in its header; `htm` `POST`; `htu` this endpoint, `<PUBLIC_BASE_URL>/v1/token`; `iat` within the last 300 seconds (30 seconds of clock skew); a `jti` not used before with the same key (the registry records it for 330 seconds, §11.1). Its key's thumbprint (RFC 7638) must equal the subject token's `cnf.jkt`, which is the passport's key. |

The API key says which developer asks; the proof says the agent holding the
passport's key asks. Neither the developer's credential nor a copy of the
parent token is enough without the other.

A form body is taken on this route only for the token exchange, and only with
the flag on; a form-encoded code exchange is `415`, as before. With the flag
off a token exchange is answered as a code exchange without a code (`400
BAD_REQUEST`), and a form body `415`, exactly as before.

The registry then, in this order:

1. verifies the DPoP proof: present, well formed, signed, for `POST` at this
   endpoint, fresh, and not replayed (`invalid_dpop_proof`), before the
   subject token is read;
2. verifies the subject token and its developer, and that neither it nor its
   grant is revoked or expired (`invalid_request`), and that the proof's key
   is the one its `cnf.jkt` names (`invalid_dpop_proof`);
3. requires the grant to be passport-bound, and the subject token not to be a
   child (`invalid_request`), and the proof's key to be the binding's;
4. applies an emergency stop's lockout (`ISSUANCE_FROZEN`);
5. checks the binding again exactly as the code exchange and the refresh do
   (§5), both status sources included, and refuses with that table's codes
   when the passport, its attestation or its issuer is revoked, suspended or
   expired, or the key is no longer usable;
6. requires the merchant to equal one of the parent's `allowed_merchants`
   (`audience_mismatch`, decision 3);
7. attenuates the constraints (§8.3) and the scope.

Nothing is recorded for a refused request. A refused proof is answered
before the subject token is read; a replayed proof is refused even when the
first request that carried it succeeded.

Refusals are RFC 6749 §5.2 error responses (RFC 8693 §2.2.2), with
`Cache-Control: no-store`, `error`, `error_description`, and `code` (the PRD
Appendix C code where one applies, else `error`) and `reason`:

| `code` | HTTP | `error` |
|---|---|---|
| `invalid_request` | 400 | `invalid_request` |
| `invalid_target` | 400 | `invalid_target` |
| `invalid_scope` | 400 | `invalid_scope` |
| `invalid_authorization_details` | 400 | `invalid_authorization_details` |
| `audience_mismatch` | 400 | `invalid_target` |
| `invalid_dpop_proof` | 400 | `invalid_dpop_proof` |
| a code of §5 | 400 | `invalid_request` |
| `status_stale` | 503 | `invalid_request` |

`invalid_dpop_proof` is RFC 9449 §5's error code for a token request whose
proof is refused. Its `reason` says why: `dpop_proof_missing` (no `DPoP`
header), `dpop_proof_invalid` (not a proof JWT, a bad signature, an
unsupported `alg` or `jwk`, or a missing `jti` or `iat`),
`dpop_htm_mismatch`, `dpop_htu_mismatch`, `dpop_proof_stale` (`iat` outside
the window), `dpop_proof_replayed` (its `jti` was used before),
`dpop_replay_unavailable` (the replay store cannot be reached: the request is
refused rather than let through), or `dpop_key_mismatch` (the proof is not
signed with the subject token's `cnf.jkt` key).

Every refusal is `400`, as RFC 6749 §5.2 specifies for an error response
unless otherwise stated, and not the `403` of §4: the token endpoint answers
in OAuth's terms, and the Appendix C code in `code` carries the reason.
`status_stale` is the exception, `503` as in §4: the request is not refused,
the registry cannot answer it now, and a client retries.

The response (RFC 8693 §2.2.1), `200`:

<!-- example: exchange-response -->
```json
{
  "access_token": "<the child grant token>",
  "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
  "token_type": "DPoP",
  "expires_in": 900,
  "scope": "read"
}
```

`token_type` is `DPoP` because the child is sender-constrained by `cnf.jkt`
(RFC 9449 §6.1). No refresh token is issued: a new child is exchanged from
the parent.

### 8.3 The child grant token

| Claim | Value |
|---|---|
| `aud` | The merchant origin. |
| `exp` | The earliest of: issuance + 900 seconds, the subject token's `exp`, the grant's expiry, the passport's `exp` and the attestation's `exp`. |
| `jti` | Fresh. |
| `cnf.jkt` | The parent's: the passport's key (key equality). |
| `sub`, `client_id`, `urn:grantex:grant.agent_did` | The parent's. |
| `urn:grantex:grant.grant_id` | The parent grant's id: a child is a token of its parent grant. |
| `urn:grantex:grant.parent_jti` | The subject token's `jti`. |
| `act` | The parent's, unchanged, when it has one (RFC 8693 §4.1): the same agent acts with the same key, so no actor is added. |
| `scope` | The requested scope, else the parent's. |
| `authorization_details` | The parent's tools entries for the child's scopes, then the `urn:grantex:commerce:v1` entry below. |

The commerce entry keeps the parent's `passport` and `acceptance_status`, and
attenuates its constraints. For the request above:

<!-- example: child-commerce-detail -->
```json
{
  "type": "urn:grantex:commerce:v1",
  "passport": {
    "issuer": "https://issuer.example",
    "id": "att-01",
    "hash": "sha-256:vDGKR0eipzfsrEgKMqXzI0NWGjZnjYVkBXW4Vf6PjcE",
    "key_thumbprint": "gzr6dlS40bV-rn_SVrIuqv36jX1W6ZnTeGkVbXr-SgY"
  },
  "acceptance_status": {
    "uri": "https://registry.example/status/attestations/racl_01J8Z3K4M5N6P7Q8R9S0T1V2W3",
    "idx": 4127
  },
  "allowed_merchants": ["https://merchant.example"],
  "amount_range": { "currency": "EUR", "max": "20.00" },
  "budget": { "amount": "500.00", "currency": "EUR" }
}
```

- `allowed_merchants` is exactly the merchant. A request that lists any other
  is refused.
- `amount_range` and `budget` are the parent's unless the request asks for
  narrower ones: the same currency, a `max` (or `amount`) no higher, a `min`
  no lower. A parent without a limit takes any limit the child asks for.
- Anything wider is refused `invalid_authorization_details` (RFC 9396 §6: the
  grant does not allow the requested authorization details). The Appendix C
  code `attestation_mismatch` is not used: the request is wider than the
  grant, not inconsistent with the attestation.

### 8.4 Records and budget

The child is recorded in `grant_tokens` against the parent grant, and in
`grant_child_tokens` (migration 126): its `jti`, the parent grant, the
subject token's `jti` (`parent_jti`), the merchant, its constraints and its
expiry. A child creates no grant, so it does not count against the plan's
active grants.

Budget is the parent's. `POST /v1/budget/allocate` and `POST /v1/budget/debit`
take a grant id; a relying party that debits at enforce time uses the token's
`urn:grantex:grant.grant_id`, which for a child is the parent grant's, so the
debit lands on the parent's allocation and every child of a grant draws on
one balance. `budget` in the commerce entry is the limit the Principal
consented to; the allocation is what is left of it. The service does not yet
compare an allocation with `budget`, or a debit with `amount_range`: a
relying party checks the amount it charges against the child's entry.

### 8.5 Revocation

- Revoking the parent grant (`DELETE /v1/grants/{id}`, a cascade, an
  emergency stop) revokes every child with it: the children are its tokens,
  and every check of a token reads its grant's status. New exchanges are
  refused.
- Revoking the subject token (`POST /v1/tokens/revoke`) revokes, in the same
  transaction, every child exchanged from it (RFC 8693 §2.1 leaves propagating
  revocation to the deployment). Revoking a child touches nothing else. An
  exchange holds a share lock on the subject token's row until its child is
  committed, so a revocation that arrives during an exchange waits for it,
  and then revokes the children in a second statement whose snapshot includes
  that child; an exchange that arrives after the revocation reads the token as
  revoked and is refused.
- When the passport, its attestation or its issuer is revoked or suspended,
  new exchanges are refused (§8.2 step 4). Children already issued end within
  900 seconds; revoking them at once is the registry cascade, a later
  milestone, which finds them through the binding of their grant.

### 8.6 Sub-agents

PRD §8.6: a sub-agent of a passport-bound grant binds its own (the leaf
agent's) passport, and the parent's binding travels in `act.passport`. That
delegation is not implemented yet. Until it is, with the flag on,
`POST /v1/grants/delegate` refuses a passport-bound grant, or a child of one,
as the parent: `403 PASSPORT_BOUND_DELEGATION_UNSUPPORTED`, and nothing is
written. The exchange refuses `actor_token` for the same reason.
