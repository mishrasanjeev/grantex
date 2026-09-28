---
title: "Becoming an Accredited Issuer"
sidebarTitle: "Accredited Issuers"
description: "What the registry records about an accredited issuer in Phase 1, and how an accredited issuer posts, withdraws and refreshes attestations."
---

An **accredited issuer** is an organisation whose Agent Passports and
attestations the Grantex registry accepts. Accreditation is decided outside the
registry, by the registry operator, against the evidence the operator requires.
What the registry holds is the outcome: one record per issuer that says who the
issuer is, what it is accredited to attest, the keys it signs with and where
its status lists live. Relying parties and the registry's own checks read that
record; nobody reads the evidence through it.

This page covers **Phase 1** of the registry. In Phase 1 an issuer's keys are a
static JWK Set recorded at accreditation. Resolving keys and trust marks
through OpenID Federation is Phase 2 and is not available yet. The protocol
text is in [`spec/registry-federation.md`](https://github.com/mishrasanjeev/grantex/blob/main/spec/registry-federation.md).

## The issuer record

| Member | Required | Meaning |
|---|---|---|
| `entity_id` | Yes | The issuer's identifier: an `https` URL with a host, no userinfo, no query and no fragment, in canonical form (lower-case host, no default port, no dot segments). A bare origin is written without the trailing slash: `https://issuer.example`, not `https://issuer.example/`. It is an OpenID Federation Entity Identifier, so it can stay the same when Federation arrives. Unique in the registry. |
| `did` | No | A DID for the issuer, if it has one. |
| `jwks` | Yes | The public keys the issuer signs passports and attestations with, as a JWK Set (see [Keys](#keys)). |
| `trust_marks` | Yes | The trust mark types the issuer is accredited for, from the [taxonomy](#trust-marks). May be empty. |
| `status_list_base` | Yes | The `https` prefix every status list of the issuer's passports sits under. It must end with `/`. A passport whose status list URL is not under this prefix is not checked against it. |
| `events_endpoint` | No | An `https` endpoint for the issuer's events. Recorded only in Phase 1. |
| `data_residency` | No | A short region label, such as `EU`, for where the issuer keeps subject data. |
| `accreditation_evidence_ref` | Yes | A reference into the operator's own accreditation records, such as a case number: letters, digits and `. _ : / -`, at most 256 characters. Never the evidence itself. |

The registry adds `id`, `status`, `suspended_effective_from`, `accredited_at`,
`revoked_keys`, `created_at` and `updated_at`.

## Trust marks

A trust mark type says what an accredited issuer may attest. Phase 1 has five,
and the registry refuses any other value:

| Trust mark type | The issuer may attest |
|---|---|
| `urn:grantex:tm:provider.entity` | that the agent provider is a registered legal entity |
| `urn:grantex:tm:provider.ownership` | who owns and controls the agent provider |
| `urn:grantex:tm:provider.screening` | that the agent provider has been screened |
| `urn:grantex:tm:agent.identity` | the identity of a specific agent, such as `shopper-01` running Nimbus Shopper 2.4 |
| `urn:grantex:tm:agent.security` | the security review of a specific agent |

An issuer is accredited for a mark only while its record lists it. Removing a
mark from the record ends the accreditation for that mark at once.

## Keys

`jwks` is a JWK Set (RFC 7517 section 5) of **public** signing keys:

- EC keys on P-256, for ES256 (RFC 7518 sections 3.4 and 6.2), are supported.
- OKP keys on Ed25519, for EdDSA (RFC 8037), are supported as well.
- Every key has a `kid`, and no two keys share one.
- No private members: a key carrying `d` (or any RSA private member, or `k`)
  is refused, so a leaked private key is never published.
- `use`, if present, is `sig`; `key_ops`, if present, is `["verify"]`; `alg`, if
  present, matches the curve. The registry fills in `alg`.
- At most 16 keys and 16 KiB.

Revoking a key is done by `kid`. The registry stops serving a revoked key
immediately, and the `kid` cannot be registered again for that issuer: rotate
to a new `kid` instead.

## Status

| `status` | Meaning |
|---|---|
| `active` | Accredited. |
| `suspended` | Not accredited from `suspended_effective_from` on. Before that time the issuer is still accredited, so a suspension can be scheduled. |
| `withdrawn` | Not accredited. The public list publishes no keys for it. |

When a check refuses an issuer it answers `issuer_not_accredited` (unknown or
withdrawn), `issuer_suspended` (a suspension in effect) or `trust_mark_missing`
(the issuer is not accredited for the mark in question).

## How the operator records an issuer

The registry operator's routes take a key from `REGISTRY_OPERATOR_API_KEYS`
(see [self-hosting](../self-hosting.md), section 5). An issuer does not call
them; the operator does, once accreditation is decided. Each change is
recorded on the registry's audit chain with the reason given for it.

Accredit `issuer.example`:

```bash
curl -X POST https://auth.example/v1/registry/issuers \
  -H "Authorization: Bearer $REGISTRY_OPERATOR_API_KEY" \
  -H "Content-Type: application/json" \
  --data @accredit.json
```

```json accredit.json
{
  "entity_id": "https://issuer.example",
  "did": "did:web:issuer.example",
  "jwks": {
    "keys": [
      {
        "kty": "EC",
        "crv": "P-256",
        "x": "UJMlyozQmy63Dzms7EdyYU5RgGHSjzRDJORs392ovGo",
        "y": "hWfvqlTBZPTLdtCaotYFe76vMfTSBYI-fSF2H4Y2dxo",
        "kid": "issuer-2026-01",
        "alg": "ES256",
        "use": "sig"
      },
      {
        "kty": "OKP",
        "crv": "Ed25519",
        "x": "VQTSyMfshu0CiHJZ_zvODFbE2A2cKOxvyYTJlrC8XB4",
        "kid": "issuer-2026-02",
        "alg": "EdDSA"
      }
    ]
  },
  "trust_marks": ["urn:grantex:tm:provider.entity", "urn:grantex:tm:agent.identity"],
  "status_list_base": "https://issuer.example/status/",
  "events_endpoint": "https://issuer.example/events",
  "data_residency": "EU",
  "accreditation_evidence_ref": "accreditation-case-0001"
}
```

The answer is `201` with the whole record, including its `id` (`aiss_...`).
Later changes go to `PATCH /v1/registry/issuers/{id}` with a `reason`.

Suspend it from a given time (a time in the past takes effect at once; leave
`effective_from` out to suspend now):

```json suspend.json
{
  "status": "suspended",
  "effective_from": "2026-10-01T00:00:00Z",
  "reason": "annual review outstanding"
}
```

Revoke one key:

```json revoke-kid.json
{
  "revoke_kids": ["issuer-2026-01"],
  "reason": "key exposed"
}
```

A `PATCH` can also set `status` to `active` or `withdrawn`, replace
`trust_marks` with a new list, or replace `jwks` with a new set.

## Posting attestations

Once accredited, an issuer posts each attestation it makes to the registry. An
attestation is a compact JWS signed with one of the keys in the issuer's
record; the full profile is in
[`spec/attestation-1.0.md`](https://github.com/mishrasanjeev/grantex/blob/main/spec/attestation-1.0.md).
There is no API key: the signature is the authentication.

```bash
curl -X POST https://auth.example/v1/registry/attestations \
  -H "Content-Type: application/jwt" \
  --data-binary @attestation.jwt
```

The protected header is `{"typ": "grantex-attestation+jwt", "alg": "ES256", "kid": "issuer-2026-01"}`,
and the payload, for the agent `shopper-01` running Nimbus Shopper 2.4:

```json attestation-payload
{
  "iss": "https://issuer.example",
  "id": "att-2026-000123",
  "sub": "did:grantex:ag_01J8Z3K4M5N6P7Q8R9S0T1V2W3",
  "type": "urn:grantex:tm:agent.identity",
  "iat": 1790596800,
  "exp": 1822132800,
  "key_thumbprint": "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs",
  "external_credential_id": "case-000123",
  "external_credential_hash": "sha-256:OiVR9AjgZRd6DJ8n_6dpLox_0KzFKt7gZ9MHpgHXOKQ",
  "level": "substantial",
  "declared_limits": { "max_amount": "250.00", "currency": "EUR" },
  "status": { "status_list": { "uri": "https://issuer.example/status/1", "idx": 4211 } }
}
```

Before posting, check:

- **You are accredited for the type.** `type` is one of your trust marks, and
  your record is neither suspended nor withdrawn.
- **The agent has proven its key.** For `agent.identity` and `agent.security`,
  `key_thumbprint` must be a key the agent registered and proved possession of
  (`POST /v1/agents/{id}/keys/{thumbprint}/challenge` and `/prove`). An
  attestation for a key that is not yet proven is refused with `key_unproven`.
- **Your status list is reachable.** `status.status_list.uri` must be under
  your `status_list_base`, and the registry fetches it while it checks the
  attestation: `GET`, `https`, no redirects, served as
  `application/statuslist+jwt`, signed with a key in your record, fresh by
  `exp` (or `iat` + `ttl`), with the entry VALID. Otherwise the answer is
  `status_stale` (or `passport_revoked` for an entry that is not VALID).
- **Your status list stays reachable.** The registry relies on each read of
  your list until the earliest of its `exp`, the time of reading plus its
  `ttl`, and one day, and reads it again shortly before then. A revocation or
  suspension you publish reaches relying parties within that time. While the
  registry cannot read your list, your attestations stop counting toward
  trust levels once the last read runs out, and count again after the next
  successful read. A `ttl` of a few minutes to an hour is a good choice.
- **`id` is new.** Posting the same bytes again is harmless and answers the
  existing record, without checking them again, so a retry after a timeout
  succeeds even while your status list is briefly unreachable; other bytes
  under an `id` you have used are `409`.
- **The hash is `sha-256:` and 43 base64url characters**, the SHA-256 of the
  credential you checked (for an Agent Passport, of its issuer-signed JWT).

The answer is `201` with the registry's record. Keep its `id` (`ratt_...`) to
withdraw or refresh the attestation later, and its `acceptance.status_list`:
that is the registry's own entry saying it accepts the attestation, which
relying parties check next to your status list.

### Withdrawing and refreshing

To take an attestation back, or to renew it with a new external credential,
sign a request with the same key set and send it in `Authorization`:

```bash
curl -X DELETE https://auth.example/v1/registry/attestations/ratt_01J8Z3K4M5N6P7Q8R9S0T1V2W3 \
  -H "Authorization: GrantexIssuer $REQUEST_JWS"

curl -X POST https://auth.example/v1/registry/attestations/ratt_01J8Z3K4M5N6P7Q8R9S0T1V2W3/refresh \
  -H "Authorization: GrantexIssuer $REQUEST_JWS" \
  -H "Content-Type: application/jwt" \
  --data-binary @renewed-attestation.jwt
```

The request's header has `"typ": "grantex-attestation-request+jwt"`, and its
payload names the registry, the attestation (by the `id` you minted) and the
action, with a fresh single-use nonce:

```json withdraw-request
{
  "iss": "https://issuer.example",
  "aud": "https://registry.example",
  "id": "att-2026-000123",
  "action": "withdraw",
  "iat": 1790600400,
  "nonce": "8m3Qf0bJ4wX2yK7pL9sT1v"
}
```

A request is valid for five minutes and only once. A refresh uses
`"action": "refresh"`, and its body is a complete new attestation for the same
subject and type with a new `id` and a new `external_credential_id`. The old
attestation is then superseded, and the registry's entry for it becomes
INVALID. The registry operator can do either with its operator key instead.

### How attestations count

Relying parties do not read attestations one by one: the registry computes a
trust level for each agent. An agent is `attested` when it has an accepted
`agent.identity` attestation bound to a key it has proven and its provider has
an accepted `provider.entity` attestation, both from accredited issuers that
are not the provider itself; `attested_verified` when its provider's domain is
also DNS-verified. A suspension of the agent, its provider, an attestation or
its issuer drops it to `basic`. Renew attestations before they expire:
thirty days before `exp` the agent carries the `attestation_expiring` flag.

## What relying parties see

`GET /v1/registry/issuers` needs no key. It lists every issuer with only
`entity_id`, `trust_marks`, `status` (as it stands at the time of the request),
`status_list_base` and `jwks` without revoked keys. It is rate limited per
client address and carries an `ETag`: send it back in `If-None-Match` and an
unchanged list answers `304`. It is sent with `Cache-Control: no-cache`, so a
cache checks back on every read and never serves a revoked key.

## Trying it locally

The repository has a mock accredited issuer, `https://mock-issuer.example`,
that issues Agent Passports, publishes its passport status lists and builds
attestations with no external party and no network. Accredit it in a local
registry with the entity id, `status_list_base` and JWKS its `keys` command
prints; see [Running the Mock Issuer](running-the-mock-issuer.md).
