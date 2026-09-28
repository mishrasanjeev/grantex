---
title: "Agent Passport and Grant"
sidebarTitle: "Passport vs Grant"
description: "An Agent Passport says who an agent is; a grant says what a person lets it do. How a grant is bound to a passport."
---

<Warning>
Passport binding ships behind `PASSPORT_BOUND_GRANTS_ENABLED`, off by default.
It is part of the Agent Trust Registry, Phase 1, and is not yet enabled on the
hosted service. The normative text is
[spec/passport-binding.md](https://github.com/mishrasanjeev/grantex/blob/main/spec/passport-binding.md).
</Warning>

## Two credentials, two questions

An **Agent Passport** answers *who is this agent?* An accredited issuer gives
it to the agent after checking who provides it, what software it is and which
key it holds. It is an SD-JWT VC signed by the issuer, and the registry keeps
the issuer's attestation of it.

A **grant** answers *what may this agent do, for whom?* A Principal gives it
to the agent, for some scopes, a purpose and a time. It is issued by Grantex
after the Principal's consent, as a grant token.

| | Agent Passport | Grant |
|---|---|---|
| Issued by | An accredited issuer | Grantex, on a Principal's consent |
| Says | Who the agent and its provider are, which key it holds | What it may do, for whom, until when |
| Lifetime | Up to a year | Hours to days |
| Revoked by | The issuer (its status list) or the registry (its acceptance list) | The Principal, the developer, an emergency stop |

A passport never authorizes anything. A grant may be **bound** to one.

## A bound grant

With the flag on, the developer passes the passport when requesting the grant,
with the rail or verifier the grant is for as `audience`:

```json
{
  "agentId": "ag_01J8Z3K4M5N6P7Q8R9S0T1V2W3",
  "principalId": "user_shopper",
  "scopes": ["read"],
  "audience": "https://merchant.example/checkout",
  "passport": "<the Agent Passport SD-JWT, with the disclosures the agent chooses>"
}
```

Before the request is recorded, the registry checks that the passport is
genuine and current, that its issuer is accredited, that the issuer's
attestation of it is registered and still accepted by both the issuer and the
registry, that its key is a proven key of the agent, and that the request stays
within the limits the issuer checked. The consent page then shows the agent's
trust level, the issuers and the declared limits before the Principal decides.

The grant token carries a reference to the passport, never the passport:

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

and `cnf.jkt` equal to the same key thumbprint, so only the holder of the
passport's key can use the grant. A relying party that trusts the registry
resolves `acceptance_status` to learn whether the registry still stands behind
the passport, and the key rule tells it that the key presenting the grant is
the key the issuer checked.

## When the passport goes away

A bound grant never outlives its passport: it ends at the passport's `exp`,
or its attestation's if that is earlier, whatever lifetime was requested.

A bound grant's token is not issued or refreshed once the passport or its
attestation has expired, the issuer revokes or suspends the passport, the
registry withdraws its acceptance, the issuer is suspended, or the key is
compromised or rotated out. The issuer's status is read again when the
registry's last read of it is no longer fresh; if the issuer's list cannot be
read, no token is issued (`status_stale`). Revoking grants that were
already issued when that happens is the registry cascade, a later milestone;
it finds them through the binding recorded for each grant.
