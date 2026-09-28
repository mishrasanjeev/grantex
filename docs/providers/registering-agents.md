---
title: "Registering Agents and Their Keys"
sidebarTitle: "Registering Agents"
description: "Register an agent's keys, prove possession with a signed challenge, rotate with an overlap, and report a compromised key."
---

Every agent in the registry signs with keys it holds. The registry keeps the
history of those keys: which are proven, which were replaced and until when
they still count, and which were reported compromised. The normative text is
[`spec/agent-keys.md`](https://github.com/mishrasanjeev/grantex/blob/main/spec/agent-keys.md).

All routes on this page take the developer API key, and only work on the
developer's own agents: another developer's agent answers `404`.

## Key identity

A key is identified by its JWK Thumbprint (RFC 7638, SHA-256, base64url). Only
the required members count (`crv`, `kty`, `x`, `y` for EC; `e`, `kty`, `n` for
RSA; `crv`, `kty`, `x` for Ed25519), so adding `kid`, `alg` or `use` to a JWK
never changes its thumbprint. Send public keys only: a JWK with a private
member such as `d` is refused.

One key belongs to one agent. A key already in another agent's history is
refused with `409 AGENT_KEY_CONFLICT`.

## Adding a key

```http
POST /v1/agents/{agentId}/keys
Authorization: Bearer <developer API key>
Content-Type: application/json

{ "publicJwk": { "kty": "EC", "crv": "P-256", "x": "<x>", "y": "<y>" } }
```

The key starts `pending`. It cannot be used until its possession is proven.
An agent may hold at most 10 keys that are pending, active or within a
rotation overlap.

A key registered as `publicJwk` on `POST` or `PATCH /v1/agents` enters the
history too. It becomes proven when the agent presents a DPoP proof with it at
the OAuth endpoints, or through the challenge below.

## Payments rails need P-256

Declare the rails the agent uses:

```http
PUT /v1/agents/{agentId}/declared-rails
Authorization: Bearer <developer API key>
Content-Type: application/json

{ "declaredRails": ["ap2", "ucp"] }
```

The rails are `ap2`, `verifiable_intent`, `acp` and `ucp`. An agent that
declares a payments rail (`ap2` or `verifiable_intent`) may hold only ES256
keys on P-256: any other key is refused with `KEY_ALGORITHM_NOT_ALLOWED`, and
the rail cannot be declared while the agent still holds another key type,
either in its history (pending, active or within a rotation overlap) or as its
registered `publicJwk`.
Without a payments rail, Ed25519 keys are accepted as well.

## Proving possession

Ask for a challenge for the pending key:

```http
POST /v1/agents/{agentId}/keys/{thumbprint}/challenge
Authorization: Bearer <developer API key>
```

```json
{
  "thumbprint": "<thumbprint>",
  "challenge": "<43-character nonce>",
  "audience": "https://grantex.dev",
  "subject": "<agentId>",
  "typ": "agent-key-proof+jwt",
  "alg": "ES256",
  "expiresAt": "<five minutes from now>"
}
```

Sign it with the key, inside the agent, where the private key lives:

```js
import { SignJWT } from 'jose';

export async function signPossessionProof(privateKey, challenge) {
  return new SignJWT({ nonce: challenge.challenge, sub: challenge.subject })
    .setProtectedHeader({ alg: challenge.alg, typ: challenge.typ, kid: challenge.thumbprint })
    .setAudience(challenge.audience)
    .setIssuedAt()
    .sign(privateKey);
}
```

and send the result:

```http
POST /v1/agents/{agentId}/keys/{thumbprint}/prove
Authorization: Bearer <developer API key>
Content-Type: application/json

{ "proof": "<compact JWS>" }
```

The key becomes `active`. A challenge proves possession once: a replayed or
expired proof, a proof signed by another key, or a proof for another
registry is refused with `key_unproven` (or `audience_mismatch`). Asking for a
new challenge cancels the previous one.

## Rotating a key

Add the new key and prove it first, then rotate the old one:

```http
POST /v1/agents/{agentId}/keys/{oldThumbprint}/rotate
Authorization: Bearer <developer API key>
Content-Type: application/json

{ "replacementThumbprint": "<newThumbprint>", "overlapSeconds": 604800 }
```

In the key history the old key stays usable for the overlap (7 days by
default, set by `AGENT_KEY_ROTATION_OVERLAP_SECONDS`, at most 30 days per
request) and is not usable from `validTo` on. A replacement that is still
pending is refused with `key_unproven`.

### The registered key is not changed by a rotation

The auth service's own token endpoints (the OAuth PAR, code exchange,
refresh and token exchange, `POST /v1/authorize` and `POST /v1/token`,
delegation) and the agent's DID document do not read the key history yet.
They bind grants to the agent's registered key, `publicJwk`, and to nothing
else (FINDINGS G-85). A rotation does not change `publicJwk`, so until you
change it:

- the rotated key keeps working at those endpoints, after its `validTo` too,
  for as long as it stays the registered key;
- the replacement is not accepted there.

When the agent has switched to signing with the replacement, make it the
registered key:

```http
PATCH /v1/agents/{agentId}
Authorization: Bearer <developer API key>
Content-Type: application/json

{ "publicJwk": { "kty": "EC", "crv": "P-256", "x": "<replacement x>", "y": "<replacement y>" } }
```

The history is unchanged by this: the replacement stays `active` and the
rotated key keeps its `validTo`. At the token endpoints the change is
immediate, with no overlap: from then on they accept only the replacement,
and `keyPossessionVerified` is `false` until the agent presents a DPoP proof
with it at the OAuth endpoints, as after any change of `publicJwk`.

## Reporting a compromised key

```http
POST /v1/agents/{agentId}/keys/{thumbprint}/compromise
Authorization: Bearer <developer API key>
Content-Type: application/json

{ "reason": "device lost" }
```

The key ends immediately and can never be registered again, by any agent,
including after the agent that held it is deleted: compromised keys are kept
in a record that outlives the agent. Registering one through `POST` or
`PATCH /v1/agents` or `POST /v1/agents/{agentId}/keys` is refused with
`409 key_not_active`.
Every grant bound to it (`cnf.jkt`) is revoked, with every grant delegated
from those, and each revocation is written to the audit chain. The response
says how many grants were revoked. If the key was the agent's registered
`publicJwk`, the newest proven replacement takes its place (`agentKey:
"promoted"`); with no replacement the registered key is cleared and the agent
is suspended (`agentSuspended: true`) until a new key is registered. Calling
it again is safe.

## Reading the history

```http
GET /v1/agents/{agentId}/keys
Authorization: Bearer <developer API key>
```

Each key carries its `status` (`pending`, `active`, `rotated`,
`compromised`), `validFrom`, `validTo`, `possessionProvedAt`, `rotatedFrom`
and whether it is `usable` now; a key that is not usable says why in `denial`
(`key_unproven` or `key_not_active`).
