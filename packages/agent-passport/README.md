# @grantex/agent-passport

> **Not yet published.** This package is in the repository at version 0.1.0 and
> is not on npm. Its API may change before the first release.

The Agent Passport is the credential an accredited issuer gives an AI agent: an
SD-JWT VC ([RFC 9901](https://www.rfc-editor.org/rfc/rfc9901.html),
[draft-ietf-oauth-sd-jwt-vc](https://datatracker.ietf.org/doc/draft-ietf-oauth-sd-jwt-vc/))
with `typ` `dc+sd-jwt` and `vct` `urn:grantex:agent-passport:1`. This package
issues it (for the mock issuer and tests), verifies it, creates and checks Key
Binding JWTs, and implements the profile's hash rule and key rule. The profile
is specified in [spec/agent-passport-1.0.md](../../spec/agent-passport-1.0.md);
the Python package `grantex-agent-passport` implements the same rules and both
pass the vectors in
[spec/examples/agent-passport-vectors.json](../../spec/examples/agent-passport-vectors.json).

## Verify a presentation

```ts
import { verifyPassport, PassportError } from '@grantex/agent-passport';

try {
  const passport = await verifyPassport({
    compact: presentation,
    // Issuer keys come only from your own trust configuration, never from the token.
    issuerKeys: (issuer) => registry.issuerKeys(issuer),
    keyBinding: { aud: 'https://merchant.example', nonce },
    paymentsRails: true,
  });
  console.log(passport.sub, passport.disclosed.agent?.software_name);
  console.log(passport.externalCredentialHash, passport.cnfThumbprint);
} catch (error) {
  if (error instanceof PassportError) console.log(error.code, error.reason);
  else throw error;
}
```

`verifyPassport` refuses, with a `PassportError`, a wrong `typ` or `vct`, a bad
issuer signature (`passport_invalid_signature`), an expired passport
(`passport_expired`), `exp` more than one year after `iat`, disclosures whose
digests are not in `_sd`, duplicate disclosures, a missing `cnf` or one with
private key members, a non-P-256 `cnf` key when `paymentsRails` is set, a
header that names a key (`jku`, `x5u`, `jwk`, `x5c`), and every Key Binding
failure. EdDSA is accepted only with `allowEdDSA: true`.

`verifyPassport` does **not** check revocation. It checks only that `status` is a Token
Status List reference; it does not fetch the status list, so a revoked or
suspended passport passes it. Before you accept a passport, resolve
`passport.status.status_list` (`uri`, `idx`) with your own status-list
component
([draft-ietf-oauth-status-list](https://datatracker.ietf.org/doc/draft-ietf-oauth-status-list/))
and refuse with `passport_revoked` when the value is not `VALID`, or with
`status_stale` when you have no fresh status list. See section 4 of the
[spec](../../spec/agent-passport-1.0.md).

## Present selected claims

```ts
import { createKeyBindingJwt, selectDisclosures } from '@grantex/agent-passport';

const presentation = createKeyBindingJwt({
  sdJwt: selectDisclosures(passportCompact, ['provider', 'agent']),
  holderKey: agentPrivateJwk,
  aud: 'https://merchant.example',
  nonce,
});
```

## Hash rule and key rule

```ts
import { externalCredentialHash, keysEqual } from '@grantex/agent-passport';

externalCredentialHash(presentation); // 'sha-256:' + base64url(sha256(issuer-signed JWT))
keysEqual(passport.cnfJwk, registeredAgentKey); // RFC 7638 thumbprints are equal
```

The hash covers only the issuer-signed JWT, so every presentation of one
passport has the same hash, whatever it discloses.
It identifies the exact issuer-signed JWT bytes: an ES256 signature can be
re-encoded (`s` to `n - s`) into a second valid JWT with another hash, so do
not key a deny list or a single-use rule on the hash alone (spec section 6).

These examples are exercised by `tests/readme.test.ts`.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run vectors   # regenerate spec/examples/agent-passport-vectors.json
```

## License

Apache-2.0
