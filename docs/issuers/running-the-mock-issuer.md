---
title: "Running the Mock Issuer"
sidebarTitle: "Mock Issuer"
description: "A mock accredited issuer for local runs and CI: static JWKS, Agent Passport issuance, passport status lists and attestations, with no external party and no network."
---

The **mock issuer** (`packages/mock-issuer`, `@grantex/mock-issuer`) stands in
for an accredited issuer so the whole registry flow runs locally and in CI
with no external party and no network. It is at version 0.1.0 and is **not
published**; run it from the repository.

It is `https://mock-issuer.example`. It has:

- **Identity.** One ES256 (P-256) signing key, generated at start, and a
  static JWK Set. In Phase 1 the registry records an issuer's keys as a static
  JWKS (see [Becoming an Accredited Issuer](becoming-an-accredited-issuer.md));
  an OpenID Federation Entity Configuration is Phase 2.
- **Agent Passport issuance.** A passport (`vct`
  `urn:grantex:agent-passport:1`, [spec](https://github.com/mishrasanjeev/grantex/blob/main/spec/agent-passport-1.0.md))
  bound to the agent's key, with the `provider`, `agent`, `verification` and
  `attestation_id` disclosures and a status reference into the issuer's own
  list. It is issued only after the agent proves possession of the key: the
  issuer hands out a challenge, the agent signs it (typ
  `agent-key-proof+jwt`, the same proof the registry uses in
  [spec/agent-keys.md](https://github.com/mishrasanjeev/grantex/blob/main/spec/agent-keys.md)
  section 4), and anything else is refused with the registry's codes:
  `key_unproven` (no proof, or a signature that does not verify with the key),
  `key_binding_mismatch` (a `kid` or `sub` for another key or agent) or
  `audience_mismatch`.
- **Passport status lists.** Lists of 131,072 entries with indices drawn at
  random, published both as a Token Status List token
  (draft-ietf-oauth-status-list-21, two bits per entry) and as W3C Bitstring
  Status List credentials (`revocation` and `suspension`), each built from the
  issuer's store and never one from the other. A passport can be revoked
  (final), suspended and reinstated. Its `urn:grantex:tm:provider.entity`
  attestation has its own entry and follows the passport: revoked or
  suspended with it, and reinstated with it unless it was revoked on its own.
- **Attestations.** The compact JWS the registry takes (typ
  `grantex-attestation+jwt`, ES256, `kid`) for `urn:grantex:tm:agent.identity`
  or `urn:grantex:tm:provider.entity`, with `external_credential_hash` computed
  by the Agent Passport hash rule over the issued passport.

Signal delivery to the registry (an SSF transmitter) is Phase 2 and is not in
the mock.

## Status list ttl

In Phase 1 the status list `ttl` is **1 second** for the mock issuer and CI, so
a revocation reaches relying parties at once, and **600 seconds** otherwise. `serve` uses 1 s unless given `--standard-ttl` (600 s) or
`--ttl SECONDS`.

## Issue, attest, suspend, reinstate and revoke

From `packages/mock-issuer` after `make install` (or `npm ci` here once
`packages/agent-passport` is built with `npm run build`, since the mock uses
the local `@grantex/agent-passport` build linked from the root `package.json`). The state directory holds the
issuer's private key and every passport it issued; it is scratch space for one
run and must never be committed (`.mock-issuer/` is ignored).

{/* example: mock-issuer-cli */}
```bash
export MOCK_ISSUER_DIR=.mock-issuer
mkdir -p "$MOCK_ISSUER_DIR"
node src/cli.ts keys > "$MOCK_ISSUER_DIR/keys.json"
ATTESTATION_ID=$(node src/cli.ts issue-passport --generate-agent-key \
  --agent-did did:web:provider.example:agents:shopper-01 \
  --provider-did did:web:provider.example \
  --software-name "Nimbus Shopper" --software-version 2.4 \
  --level standard --out "$MOCK_ISSUER_DIR/passport.json")
node src/cli.ts attest --attestation-id "$ATTESTATION_ID" > "$MOCK_ISSUER_DIR/attestation.jws"
node src/cli.ts suspend --attestation-id "$ATTESTATION_ID"
node src/cli.ts reinstate --attestation-id "$ATTESTATION_ID"
node src/cli.ts revoke --attestation-id "$ATTESTATION_ID"
```

`keys` prints the entity id, `status_list_base`
(`https://mock-issuer.example/status/`) and the public JWKS: the values to
accredit the mock issuer with in a local registry. `issue-passport` generates an
agent key under the state directory (or takes one with `--agent-key FILE`),
runs both sides of the possession proof, and writes the passport, its
attestation id and its status reference to `--out`. `attest` prints the
attestation JWS; with `--registry URL` it also POSTs the compact JWS itself as
the body, with `Content-Type: application/grantex-attestation+jwt`, to
`URL/v1/registry/attestations` (change the path with `--registry-path`), the
form the registry's attestation route takes (`application/jwt` or
`application/grantex-attestation+jwt`; JSON is refused with 415). No API key is sent: the route has none, and the issuer's
signature is the authentication. It waits at most 10 seconds and reads at most
64 KiB of the answer. A refusal exits with status 1 and prints its code, such as
`passport_revoked` or `attestation_not_registered`.

## Serve the JWKS and the status lists

{/* example: mock-issuer-serve */}
```bash
node src/cli.ts serve --port 56900
```

The server binds **127.0.0.1 only** and prints one JSON line with its origin
and the `origin_map` pair. It serves:

| Path | Content | Media type |
|---|---|---|
| `/.well-known/jwks.json` | The static JWKS | `application/jwk-set+json` |
| `/status/N` | Token Status List token for list `N` | `application/statuslist+jwt` |
| `/status/N/bitstring` | Bitstring Status List credential, `revocation` | `application/vc+jwt` |
| `/status/N/bitstring/suspension` | Bitstring Status List credential, `suspension` | `application/vc+jwt` |

Status list URIs inside passports and attestations always stay
`https://mock-issuer.example/status/N`. To let a local registry fetch them,
start the auth service with the development-and-test origin override, which it
refuses whenever it runs in production:

```bash
REGISTRY_DEV_ISSUER_ORIGIN_MAP=https://mock-issuer.example=http://127.0.0.1:56900
```

## The attestation demo

`make demo-attest` runs Demo 1 end to end with no external party: the mock
issuer serving its JWKS and status lists, a real auth service on a local port
(Postgres in `DATABASE_URL`, Redis in `REDIS_URL`), the mock accredited for
`agent.identity` and `provider.entity`, a developer with a provider
(`did:web:provider.example`) and an agent, the agent's key generated and
proven, `grantex-attest` requesting both attestations through the `mock`
adapter and posting them, the public lookup showing level `attested`, the
issuer revoking the passport, and the lookup showing the level drop and the
revocation within the status list `ttl` (1 s) plus one reconciliation read.
Every step prints `live` (the registry) or `fixture` (the mock issuer). It
runs in CI (`Demos (attest, verify)`); locally it needs `make install`, the
auth service built (`npm --prefix apps/auth-service run build`) and the SDK
installed (`pip install -e packages/sdk-py`). `make demo-verify` continues
from the same point into a passport-bound grant and a relying party's
`verify()`; see [Verifying Agents](../relying-parties/verifying-agents.md).

## Use it from the Python SDK

`GRANTEX_ISSUER_ADAPTER=mock` makes the SDK's `load_issuer_client()` drive this
CLI through the accredited issuer seam, so the registration flow runs against
the mock with the same code that later runs against a real issuer. See
[Implementing an Issuer Adapter](implementing-an-issuer-adapter.md).

## Use it from a test

The package's API does the same in process; its
[README](https://github.com/mishrasanjeev/grantex/blob/main/packages/mock-issuer/README.md)
has an example that its tests run.
