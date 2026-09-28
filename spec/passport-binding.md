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

Normative references: RFC 9396 (Rich Authorization Requests) §2 and §9.1;
RFC 9449 §6.1 (`cnf.jkt`); RFC 7638 §3; RFC 9901 §4 and §7.1;
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
approved request bound to it, as for any key-bound request. A delegated grant
(`POST /v1/delegate`) does not inherit the binding in Phase 1.

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

## 7. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PASSPORT_BOUND_GRANTS_ENABLED` | `false` | `true` (exactly) reads `passport` on `POST /v1/authorize` as this annex describes. Any other value, or unset, ignores it. |

No new endpoint is added.
