---
title: "Becoming an Accredited Issuer"
sidebarTitle: "Accredited Issuers"
description: "What the registry records about an accredited issuer in Phase 1: the entity identifier, trust marks, static signing keys and status list base."
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

## What relying parties see

`GET /v1/registry/issuers` needs no key, so it is served only when the
operator sets `REGISTRY_PUBLIC_ENDPOINTS_ENABLED=true` (exactly `true`; the
default is off). Off, the route is not registered and a request is answered
as for any unknown route: `401` without an API key, `404` with one. The
operator routes and the accreditation lookups work either way.

It lists the issuers with only `entity_id`, `trust_marks`, `status` (as it
stands at the time of the request), `status_list_base` and `jwks` without
revoked keys, ordered by `entity_id`. It is paged with `page` (from 1,
default 1) and `pageSize` (1 to 500, default 100), and reports `total`, the
number of issuers in all; a page past the end is empty and still carries
`total`, and any other value answers `400`. Read pages until you have `total`
issuers, or until a page comes back empty:

```json
{
  "issuers": [
    {
      "entity_id": "https://issuer.example",
      "trust_marks": ["urn:grantex:tm:agent.identity"],
      "status": "active",
      "status_list_base": "https://issuer.example/status/",
      "jwks": { "keys": [] }
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 100
}
```

It is rate limited per client address and carries an `ETag` for each page:
send it back in `If-None-Match` and an unchanged page answers `304`. It is
sent with `Cache-Control: no-cache`, so a cache checks back on every read and
never serves a revoked key.

## Trying it locally

The repository has a mock accredited issuer, `https://mock-issuer.example`,
that issues Agent Passports, publishes its passport status lists and builds
attestations with no external party and no network. Accredit it in a local
registry with the entity id, `status_list_base` and JWKS its `keys` command
prints; see [Running the Mock Issuer](running-the-mock-issuer.md).
