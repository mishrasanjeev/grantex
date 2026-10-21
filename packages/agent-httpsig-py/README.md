# grantex-agent-httpsig

> **Not yet published.** Version 0.2.0 (unreleased) lives in this repository only; it is
> not on PyPI, and its API may change before the first release.

RFC 9421 HTTP Message Signatures for agent requests. An agent signs each
request with the key its Agent Passport is bound to and sends its Agent
Passport, its grant and, optionally, the registry's trust statement in the
`Agent-Passport`, `Agent-Grant` and `Agent-Trust` headers; a relying party
verifies the request before it looks at those credentials.

The header specification and the signing profile are in
[`spec/verification.md`](../../spec/verification.md). In short:

- covered components, exactly: `("@method" "@authority" "@path"
  "content-digest" "agent-passport" "agent-grant")`, with the parameters
  `created`, `expires`, `nonce`, `keyid` (the RFC 7638 thumbprint of the key)
  and `tag="agent-payer-auth"`, and at most 300 seconds between `created` and
  `expires`;
- `ecdsa-p256-sha256` (P-256 JWKs) and `ed25519` (Ed25519 JWKs); the
  `tap` and `web-bot-auth` profiles also take `rsa-pss-sha512` (RSA JWKs);
- `Content-Digest` (RFC 9530) with SHA-256, computed by `sign()` and checked
  by `verify()`;
- the three headers are RFC 9651 Byte Sequences, or, for a presentation over
  6 KB, a `body` token with a `sha-256` parameter and the presentation in the
  JSON content under `agent_credentials`;
- denials are `request_signature_invalid` or `request_signature_stale`, with
  a reason from the specification's list.

The TypeScript package `@grantex/agent-httpsig` (`packages/agent-httpsig`)
behaves identically; both run the shared vectors in
[`spec/examples/agent-httpsig-vectors.json`](../../spec/examples/agent-httpsig-vectors.json).
Requires Python 3.9 or later and `cryptography`.

## Example

<!-- snippet: packages/agent-httpsig-py/tests/docs/examples/sign_and_verify.py -->
```python
from __future__ import annotations

import json
from typing import Any, Optional

from cryptography.hazmat.primitives.asymmetric import ed25519

from grantex_agent_httpsig import (
    HttpRequest,
    InMemoryNonceStore,
    VerifyResult,
    jwk_thumbprint,
    private_jwk_from_key,
    public_jwk,
    sign,
    verify,
)


def sign_and_verify(agent_passport: str, agent_grant: str) -> VerifyResult:
    # The agent's key. In production it is the key its Agent Passport is bound to.
    agent_key = private_jwk_from_key(ed25519.Ed25519PrivateKey.generate())

    # Agent side: sign the request and send the headers sign() returns.
    headers = {"content-type": "application/json"}
    body = json.dumps({"cart_id": "c-1001"}).encode()
    unsigned = HttpRequest("POST", "https://merchant.example/v1/checkout", headers, body)
    signed = sign(unsigned, key=agent_key, agent_passport=agent_passport, agent_grant=agent_grant)
    request = HttpRequest(unsigned.method, unsigned.url, {**headers, **signed.headers}, body)

    # Relying party: verify it. The resolver returns the public key the
    # relying party trusts for the keyid, or None.
    trusted_key = public_jwk(agent_key)
    trusted_keyid = jwk_thumbprint(trusted_key)

    def resolve_key(keyid: str) -> Optional[dict[str, Any]]:
        return trusted_key if keyid == trusted_keyid else None

    return verify(
        request,
        expected_authority="merchant.example",
        resolve_key=resolve_key,
        nonce_store=InMemoryNonceStore(),
    )
```

`verify()` answers a request that fails with a `VerifyResult` whose `ok` is
false and whose `code` and `reason` say why. An exception from the key
resolver or the nonce store propagates; refuse the request then.
`verify()` raises `AgentHttpSigError` when `now` is not a finite,
non-negative number of seconds. `InMemoryNonceStore` is for one process
(it is safe to share between threads) and for tests: a deployment with
several instances needs a shared, atomic store (see section 4.4 of the
specification).

## Profiles: Grantex, Visa TAP and Web Bot Auth

`sign_with_profile(request, profile=..., ...)` and
`verify_with_profile(request, profile=..., ...)`
run one RFC 9421 signer and verifier under the profile named in
`profile`. With the default `profile="grantex"` they are `sign()` and `verify()`
unchanged: the shared vectors pass through both
paths.

| Profile | `tag` | Covered components | Window | `nonce` | `keyid` |
|---|---|---|---|---|---|
| `grantex` (default) | `agent-payer-auth` | exactly `@method @authority @path content-digest agent-passport agent-grant` | at most 300 s | required, 22 to 128 base64url | RFC 7638 thumbprint |
| `tap` (Visa Trusted Agent Protocol) | `agent-payer-auth` (payment) or `agent-browser-auth` (browsing) | at least `@authority @path`; more on request (`@method`, `content-digest`, fields) | `expires - created` at most 8 minutes | required; equal in every signature of the message; refused when seen in the last 8 minutes | the key's identifier in the network's key store (opaque) |
| `web-bot-auth` (draft-ietf-webbotauth-httpsig-protocol-00) | `web-bot-auth` | `@authority` or `@target-uri`, and `"signature-agent";key="<label>"` | at most 24 hours (configurable lower) | optional | RFC 7638 thumbprint |

- TAP signatures carry `alg` (the RFC 9421 algorithm name; the verifier also
  accepts the TAP example's spelling `Ed25519`). The TAP sample code writes
  `keyId`; the specification and RFC 9421 use `keyid`, and this library
  follows them.
- Web Bot Auth signers send `Signature-Agent` in the Dictionary form
  (`sig1="https://agents.example"`, with `;type=jwks_uri` or `;type=cimd`
  when not a directory). The verifier hands the resolver a `KeyReference`
  (`profile`, `tag`, `keyid`, `signature_agent`) with the Signature-Agent URL and type, so keys are looked up by the
  (URL, keyid) pair, never keyid alone (section 5.4).
- Both profiles verify a covered `Content-Digest` (`sha-256` or `sha-512`);
  require it with `required_components=["content-digest"]` when the body
  matters.
- Denials add `tag_not_accepted`, `nonce_missing`, `nonce_mismatch`,
  `algorithm_mismatch`, `signature_agent_missing` and
  `signature_agent_unsupported` to the reasons above.
- Algorithms: `ecdsa-p256-sha256`, `ed25519` and `rsa-pss-sha512` (RFC 9421
  section 3.3.1: RSASSA-PSS with SHA-512, MGF1 SHA-512, 64-octet salt; RSA
  keys of at least 2048 bits). The grantex profile stays P-256 and Ed25519
  only. TAP's sample code names an `rsa-pss-sha256` algorithm, which is not
  in the RFC 9421 registry and is not accepted. The RFC's RSA-PSS example
  signatures are verification vectors in the shared vector file (PSS is
  randomized, so they cannot be reproduced).

The signature base now implements the RFC 9421 component parameters `key`
(section 2.1.2) and `req` (section 2.4, given the related request) and the
derived component `@target-uri` (section 2.2.2).

## TAP body objects and the Grantex consent record

TAP carries two signed objects in the request body beside the message
signature. `build_agentic_consumer` (consumer recognition: `nonce`, `idToken`,
`contextualData`, `kid`, `alg`, `signature`) and
`build_agentic_payment_container` (`nonce`, `kid`, `alg`, `signature`, and
optionally `paymentCredentialsHash`, `cardMetadata`, `credentialHash`, an
already encrypted `payload`, `browsingIOU`) build them;
`with_tap_body_objects` places them in a JSON body; `verify_tap_body_objects`
checks them after the message signature verified under the `tap` profile:
each object's `nonce` must equal the signature's nonce and its `kid` the
signature's keyid. A consumer object that fails is reported (soft: its
content may be inaccurate). A payment container that fails, or whose key
cannot be found, is `usable_for_payment` false.

UNCONFIRMED by the published TAP specification, and therefore configurable:

- where the objects sit in the body (`members`; defaults
  `agenticConsumer`, `agenticPaymentContainer` as top-level members);
- what the object signature covers (default: RFC 8785 JCS of the object
  without `signature`, signature base64url; pass `canonicalize`).

Objects are signed with ES256 (P-256), EdDSA (Ed25519) or PS512 (RSA). TAP's
examples use PS256, which this library reports as `algorithm_unsupported`.

`build_grantex_consent_record(consent, nonce=...)` builds the
`grantexConsentRecord` object from a granted, unexpired Grantex commerce
consent: consent id, merchant, agent, passport type, approved scopes, amount
cap, consent text version, presented payload hash, approval and expiry
times, and the message nonce. It carries no principal identifier and is a
Grantex extension, not part of TAP; the relying party checks the consent
with Grantex by its id.

[`spec/examples/agent-httpsig-profile-vectors.json`](../../spec/examples/agent-httpsig-profile-vectors.json)
holds deterministic Ed25519 vectors for both profiles and both body objects;
the TypeScript and Python packages reproduce them byte for byte.

## Key directory and several signatures

- `build_signature_directory(keys)`, `sign_directory_response(body,
  authority=..., signing_keys=...)` and `verify_directory_response(response,
  authority=...)`
  implement draft-meunier-webbotauth-httpsig-directory-00: a JWK Set at
  `/.well-known/http-message-signatures-directory`, media type
  `application/http-message-signatures-directory+json`, `kid` = thumbprint,
  one response signature per key over `"@authority";req` and
  `content-digest` with `tag="http-message-signatures-directory"`. The
  verifier returns only the keys with their own valid, current signature and
  lists the others as ignored (section 5.2).
- `combine_signatures(*results)` merges several signatures of one request,
  for example a grantex signature and a web-bot-auth signature whose
  `Signature-Agent` names the agent's directory.

## Also exported

- `content_digest(body)`, `jwk_thumbprint(jwk)`, `public_jwk(jwk)`,
  `private_jwk_from_key(key)`;
- `signature_base_for(message, label)` and `verify_signature_value(jwk, base,
  signature)`: RFC 9421 section 2.5 and section 3.3 for any request or
  response whose covered components are `@method`, `@target-uri`,
  `@authority`, `@scheme`, `@path`, `@query`, `@status` or header fields,
  with the component parameters `key` and `req`;
- `parse_dictionary`, `parse_list`, `parse_item` and the matching
  serializers (RFC 9651).

## Development

```bash
pip install -e ".[dev]"
mypy --strict src
pytest
```

## License

Apache-2.0 ([LICENSE](https://github.com/mishrasanjeev/grantex/blob/main/packages/agent-httpsig-py/LICENSE)).
This package is open source and free for any use, including commercial use.
The Grantex auth service, developer portal and hosted services are licensed
separately under the PolyForm Noncommercial License 1.0.0; commercial use of
those needs a written agreement with Orchestrum Technologies LLP (see
[licensing](https://github.com/mishrasanjeev/grantex/blob/main/LICENSING.md)).
"Grantex" is a trademark of Orchestrum Technologies LLP
([trademarks](https://github.com/mishrasanjeev/grantex/blob/main/TRADEMARKS.md)).
