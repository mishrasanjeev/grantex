# Agent key history and possession proof

Status: draft (Agent Trust Registry, PRD §5 Agent, §6, §7 Keys, §8.8).
Implemented by the auth service (`apps/auth-service`): migration
`122_agent_keys.sql`, `src/lib/registry/jwk-thumbprint.ts`,
`src/lib/registry/agent-keys.ts` and `src/routes/agent-keys.ts`. The routes
are enabled and require the developer API key of the agent's own developer.

Keywords MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Key identity

Every agent key is identified by its JWK Thumbprint (RFC 7638) computed with
SHA-256 and encoded as unpadded base64url (43 characters):

- The hash input contains only the required members of the key, ordered
  lexicographically by member name, with no whitespace (RFC 7638 §3, §3.3):
  `crv`, `kty`, `x`, `y` for EC and `e`, `kty`, `n` for RSA (§3.2);
  `crv`, `kty`, `x` for OKP (RFC 8037 §2). Every other member (`kid`, `alg`,
  `use`, `key_ops` and any extension) is ignored.
- A JWK carrying a private member (`d`, `p`, `q`, `dp`, `dq`, `qi`, `oth`,
  `k`) is refused rather than reduced to its public part, and symmetric keys
  have no registry thumbprint.
- A member value that would need escaping in JSON has no thumbprint
  (RFC 7638 §3.3) and is refused.

The same value is a grant's `cnf.jkt` (RFC 9449 §6.1). The test vectors are
RFC 7638 §3.1 (`NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs`) and RFC 8037
Appendix A.3 (`kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k`).

A thumbprint is unique across the whole history: a key belongs to at most one
agent. A key reported compromised can never be registered again, by any
agent: its thumbprint is recorded in `compromised_agent_keys`, which is kept
when the agent or the developer is deleted, and the registry refuses (with
`key_not_active`) to write a recorded thumbprint to the history in any state
other than `compromised`. `POST` and `PATCH /v1/agents` apply both rules only
while the history mirror is on (§7).

## 2. Key states

| Status | Meaning | Usable at time `t` |
|---|---|---|
| `pending` | Registered; possession not proven | Never (`key_unproven`) |
| `active` | Possession proven | When `valid_from <= t` |
| `rotated` | Replaced by another active key | When `t < valid_to`, the end of the overlap |
| `compromised` | Reported compromised | Never (`key_not_active`) |

A key is usable only if its possession was proven. The boundary is exclusive:
at `t = valid_to` a rotated key is no longer usable. `valid_to` is written by
the registry's clock, and the registry evaluates usability at that clock.

Denials use the PRD Appendix C codes `key_unproven` (possession not proven)
and `key_not_active` (the key has ended or was compromised).

## 3. Declared rails and the P-256 rule

An agent MAY declare the rails it uses: `ap2`, `verifiable_intent`, `acp`,
`ucp`. An agent that declares a payments rail (`ap2` or
`verifiable_intent`) MUST hold only ES256 keys on P-256 (PRD §6): a key of
any other type is refused when it is added, and the rail cannot be declared
while the agent holds such a key that is pending, active or within a rotation
overlap, or while its registered key (`publicJwk`, §7) is of another type,
whatever that key's state in the history. A key of another type that ended
MUST NOT become pending or active again under a payments rail. Otherwise Ed25519 (EdDSA), P-256, P-384, P-521 and RSA (at least
2048 bits) are accepted.

## 4. Possession proof

### 4.1 Challenge

`POST /v1/agents/{id}/keys/{thumbprint}/challenge` issues a challenge for a
`pending` key:

```json
{
  "thumbprint": "<RFC 7638 thumbprint of the key>",
  "challenge": "<43-character base64url nonce>",
  "audience": "<the registry's issuer identifier>",
  "subject": "<the agent id>",
  "typ": "agent-key-proof+jwt",
  "alg": "<the key's JWS algorithm>",
  "expiresAt": "<RFC 3339 time, 300 seconds after issue>"
}
```

The nonce is 256 bits from a cryptographically secure generator. The
registry stores only its SHA-256 hash, bound to the agent and the key. A new
challenge for a key supersedes every earlier unused challenge for it.

### 4.2 Proof

The agent answers with a JWS in Compact Serialization (RFC 7515 §7.1)
whose payload is a JWT Claims Set (RFC 7519), signed with the key being
proven:

Protected header:

| Parameter | Value |
|---|---|
| `alg` | The key's algorithm (`ES256`, `ES384`, `ES512`, `EdDSA` or `RS256`). MUST NOT be `none` or a MAC algorithm. |
| `typ` | `agent-key-proof+jwt`. Explicit typing as RFC 8725 §3.11 recommends, with the `application/` prefix omitted as RFC 7515 §4.1.9 allows. |
| `kid` | OPTIONAL. If present, MUST equal the key's thumbprint. |
| `jwk`, `jku`, `x5u`, `x5c` | MUST NOT be present. The proof is verified with the registered key only. |

Claims:

| Claim | Value |
|---|---|
| `aud` | The challenge's `audience` (RFC 7519 §4.1.3). |
| `sub` | The challenge's `subject`, the agent id. |
| `nonce` | The challenge's `challenge`. |
| `iat` | Time of signing (RFC 7519 §4.1.6). |

### 4.3 Verification

`POST /v1/agents/{id}/keys/{thumbprint}/prove` with `{"proof": "<JWS>"}`.
The registry:

1. Refuses a key that is `rotated` or `compromised` (`key_not_active`).
2. Verifies the signature with the registered key and only its algorithm,
   then checks `typ`, `aud` (`audience_mismatch` on a mismatch), `sub` and
   `kid` (`key_binding_mismatch`), and that `iat` is at most 300 seconds old
   and not in the future, with 30 seconds of tolerance. Any failure is
   `key_unproven`.
3. In one transaction, sets `consumed_at` on the challenge whose hash matches
   `nonce`, only if it belongs to this agent and key, is unused and has not
   expired. If no row changes, the proof is refused with `key_unproven`
   (unknown, superseded, already used or expired challenge).
4. In the same transaction, sets the key `active` with
   `possession_proved_at`, and appends `grantex.agent_key.proved` to the
   developer's audit chain.

Replay is impossible by construction: step 3 moves `consumed_at` from NULL at
most once for a nonce, a proof for one key cannot answer another key's
challenge (both the signature and the challenge binding fail), and a proof
for one registry does not verify at another (`aud`). A failed signature does
not use the challenge up, so only the key's holder can.

## 5. Rotation

`POST /v1/agents/{id}/keys/{thumbprint}/rotate` with
`{"replacementThumbprint": "...", "overlapSeconds": 604800}`. The key MUST be
`active`, and the replacement MUST be another `active` key of the same agent
(`key_unproven` while it is pending, `key_not_active` when it has ended). The
key becomes `rotated` with `valid_to = now + overlap`; the replacement records
`rotated_from`. The overlap defaults to `AGENT_KEY_ROTATION_OVERLAP_SECONDS`
(7 days) and may be 0 to 30 days.

Rotation changes the history only. It does not change the agent's registered
key (§7), which the auth service's token endpoints still bind to: until the
provider sets `publicJwk` to the replacement with `PATCH /v1/agents`, the
rotated key remains usable at those endpoints after `valid_to`, and the
replacement is not usable there (FINDINGS G-85). That `PATCH` leaves the
history as it is (the replacement stays `active`, the rotated key keeps its
`valid_to`) and takes effect at the token endpoints at once, without an
overlap.

## 6. Compromise

`POST /v1/agents/{id}/keys/{thumbprint}/compromise` with an optional
`reason`. In one transaction the key becomes `compromised` with
`valid_to = now`, its thumbprint is recorded in `compromised_agent_keys`
(§1), its unused challenges are deleted, authorization requests
and pushed authorization requests bound to it are denied, and
`grantex.agent_key.compromised` is appended to the audit chain. If the key is
the agent's registered key (`publicJwk`), the newest active replacement
becomes the registered key; with none, the registered key is cleared and the
agent is suspended. Then every grant whose `cnf.jkt` is the key, and every
grant delegated beneath one, is revoked through the cascade revocation, with
one `grantex.grant.revoked` audit entry per grant. Reporting the same key
again is safe and completes a cascade that did not finish.

The grants bound to the key are looked up under the developer's cascade lock,
the lock `POST /v1/grants/delegate` holds while it binds a new grant to the
sub-agent's registered key. A delegation holding that lock is waited for, and
the grant it commits is found and revoked. A delegation that takes the lock
after the lookup re-checks the sub-agent's key against
`compromised_agent_keys` and is refused with `409 key_not_active`. Either way,
no grant bound to the key outlives the compromise.

## 7. Relation to the registered key

`publicJwk` on `POST` and `PATCH /v1/agents` remains the registered key that
the token endpoints bind grants to.

With `AGENT_KEY_HISTORY_MIRROR_ENABLED=true` (the history mirror), every key
written there also enters the history as `pending`, in the same transaction.
They then refuse a key another agent holds in its history (pending, active or
within a rotation overlap) with the same `AGENT_KEY_CONFLICT` as before, a key
reported compromised with `key_not_active`, and a key other than ES256 on
P-256 for an agent that declares a payments rail with
`KEY_ALGORITHM_NOT_ALLOWED`. `PATCH` replaces the registered key at once: the
old one becomes `rotated` with `valid_to = now` if it was still pending or
active, and keeps its `valid_to` if it was already rotated.

The mirror is off by default, and only the exact value `true` turns it on.
Off, `POST` and `PATCH /v1/agents` behave as they did before the history
existed: they write only the agent, the keys they write are not in the
history, and they refuse none of the above; only the registered-key index
decides a conflict. The history then holds the backfilled keys (below) and
the keys added through `POST /v1/agents/{id}/keys`, which is also how the
agent's registered key is brought into it. The key routes still apply every
rule of §1 to §6 to what they write, and delegation still refuses a
compromised key (§6).

In both states, a DPoP proof of the registered key verified at the OAuth
endpoints counts as possession: the key routes record it (the history entry
becomes `active`) before they read the agent's history. The token endpoints
write only the columns they always wrote.

Until the token endpoints evaluate keys against the history (FINDINGS G-85),
the states and the overlap in §2 and §5 apply to the key routes and to
relying parties that read the history. The token endpoints accept the
registered key, and only it, for as long as it is registered; a compromise
(§6) is the one change of the history that also changes the registered key.

Migration 122 backfilled every key registered before it: `active` when it had
been proven with DPoP, `pending` otherwise. A registered key whose algorithm
it cannot derive cannot enter the history; the migration reports each one with
a warning rather than leaving it out silently.
