# @grantex/mock-issuer

> **Not yet published.** This package is in the repository at version 0.1.0,
> marked private, and is not on npm. It runs from the repository only.

A mock accredited issuer, `https://mock-issuer.example`, so the registry flow
runs locally and in CI with no external party and no network:

- a static JWKS with one ES256 key generated at start (optionally kept in a
  directory you name for one run; never commit it);
- Agent Passport issuance with
  [`@grantex/agent-passport`](../agent-passport/README.md), bound to the agent's
  key only after the agent signs the issuer's possession challenge;
- the issuer's own passport status lists, 131,072 entries each with random
  indices, published as a Token Status List token
  ([draft-ietf-oauth-status-list-21](https://datatracker.ietf.org/doc/draft-ietf-oauth-status-list/))
  and as [W3C Bitstring Status List](https://www.w3.org/TR/vc-bitstring-status-list/)
  credentials, each built from the store; ttl 1 s by default, 600 s with
  `ttlProfile: 'standard'`;
- revoke (final), suspend and reinstate; a passport's
  `urn:grantex:tm:provider.entity` attestation has a status entry of its own
  and follows the passport (revoked or suspended with it, reinstated with it
  unless it was revoked on its own);
- attestations (typ `grantex-attestation+jwt`) for
  `urn:grantex:tm:agent.identity` and `urn:grantex:tm:provider.entity`, and
  `postAttestation`, which POSTs the compact JWS itself as
  `application/grantex-attestation+jwt` to
  `<registry>/v1/registry/attestations` (no API key: the issuer's signature is
  the authentication), waits at most 10 s and reads at most 64 KiB of the
  answer;
- a server bound to 127.0.0.1 only for the registry's
  `REGISTRY_DEV_ISSUER_ORIGIN_MAP`, and a CLI (`node src/cli.ts`).

An SSF transmitter (signals to the registry) is **Phase 2** and is not here.
OpenID Federation Entity Configuration is Phase 2 as well; Phase 1 uses the
static JWKS.

The CLI, the server's paths and media types and the ttl rules are described in
[docs/issuers/running-the-mock-issuer.md](../../docs/issuers/running-the-mock-issuer.md).

## Use it from a test

```ts
import { MockIssuer, signPossessionProof, startMockIssuerServer } from '@grantex/mock-issuer';

const issuer = MockIssuer.create(); // a new ES256 key; status list ttl 1 s
// Agent side: prove possession of the key the passport will bind.
const challenge = issuer.createPossessionChallenge({ agentDid, agentPublicJwk });
const possessionProof = signPossessionProof({ challenge, agentPrivateJwk });
// Issuer side: refused with key_unproven without a valid proof.
const passport = issuer.issuePassport({
  agentDid,
  agentPublicJwk,
  possessionProof,
  provider: { did: 'did:web:provider.example' },
  agent: { software_name: 'Nimbus Shopper', software_version: '2.4' },
  verification: { level: 'standard' },
});
const attestation = issuer.buildAttestation({ attestationId: passport.attestationId });
const server = await startMockIssuerServer({ issuer }); // 127.0.0.1, ephemeral port
console.log(server.originMapEntry); // for REGISTRY_DEV_ISSUER_ORIGIN_MAP
issuer.revokePassport(passport.attestationId);
await server.close();
```

Inside this repository, import it from the sources
(`packages/mock-issuer/src/index.ts`); it is not installable by name. It
depends on `@grantex/agent-passport` by name, as `@grantex/mcp-auth` depends
on `@grantex/sdk`: the root `package.json` links the local package, and
`make install` (or `npm run build` in `packages/agent-passport`) builds it
first. It uses only that package's exported API; the compact JWS for its own
lists, attestations and possession proofs is in `src/jose.ts`.

## Refusals

Every refusal is a `MockIssuerError` with a `code`, the registry's own code
where there is one: `key_unproven` for a missing possession proof or one whose
signature does not verify with the key to be bound, `key_binding_mismatch` for
a proof whose `kid` or `sub` names another key or agent, and
`audience_mismatch` for a proof made for another audience; `passport_revoked` for a change to, or an attestation of, a
revoked (or, for an attestation, suspended) passport;
`attestation_not_registered` for an id the mock never issued;
`status_list_not_found`; `registry_refused` and `registry_unreachable` from
`postAttestation`; `state_unreadable` for a state directory it cannot read
(it never falls back to an empty list); `invalid_request` otherwise.

## Development

```bash
npm --prefix ../agent-passport ci && npm --prefix ../agent-passport run build
npm ci
npm run typecheck
npm test
```
