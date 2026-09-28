# Agent request verification

Status: draft (Agent Trust Registry, Phase 1). This document holds the header
specification and the request signing profile only. Implemented by
`@grantex/agent-httpsig` (TypeScript, `packages/agent-httpsig`) and
`grantex-agent-httpsig` (Python, `packages/agent-httpsig-py`), neither of
which is published yet. Both run the shared test vectors in
[`examples/agent-httpsig-vectors.json`](examples/agent-httpsig-vectors.json).

Keywords MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

An agent that pays or acts for a person presents three things to a relying
party (for example a merchant) on every request: its **Agent Passport** (the
credential), its **grant** (the delegation) and, optionally, the registry's
**trust statement** about it. It proves possession of the key its Agent
Passport is bound to by signing the request with HTTP Message Signatures
(RFC 9421). This document defines the headers that carry the three, and the
one signing profile a relying party accepts.

## 1. Headers

### 1.1 `Agent-Passport`, `Agent-Grant` and `Agent-Trust`

| Header | Carries | Required | Covered by the signature |
|---|---|---|---|
| `Agent-Passport` | The Agent Passport presentation, in its compact serialization. | Yes | Yes |
| `Agent-Grant` | The grant, in its compact serialization. | Yes | Yes |
| `Agent-Trust` | The registry's signed trust statement about the agent, in its compact serialization. | No | No (section 4.5) |

Each header is an RFC 9651 **Item** (RFC 9651 section 3.3) in one of two
forms. Only these two forms are defined; anything else, including a
parameter that is not listed here, MUST be refused.

**Inline.** A **Byte Sequence** (RFC 9651 section 3.3.5) whose content is the
octets of the presentation, with no parameters:

<!-- vector: sign 0 Agent-Passport -->
```
Agent-Passport: :cGFzc3BvcnQtcGxhY2Vob2xkZXIuc2hvcHBlci0wMS5pc3N1ZXIuZXhhbXBsZX5kaXNjbG9zdXJlLWdpdmVuLW5hbWV+a2ItcGxhY2Vob2xkZXI=:
```

A Byte Sequence is used rather than a String or Token because a parser
MUST support Byte Sequences of at least 16384 octets (RFC 9651 section
3.3.5), and Strings of only 1024 characters (section 3.3.3), and because the
octets are carried exactly, whatever characters the serialization uses. The
decoded presentation MUST be non-empty and consist of printable ASCII
characters other than space (`%x21-7E`), as every compact serialization
does.

**By reference.** When the presentation is larger than 6144 octets (6 KB),
the header carries the **Token** `body` with one parameter, `sha-256`, a
Byte Sequence holding the SHA-256 digest of the presentation's octets, and
the presentation itself travels in the request content (section 1.2):

<!-- vector: sign 4 Agent-Passport -->
```
Agent-Passport: body;sha-256=:Y+mNP7qv7zRYKdwvzFgbKddREUdyxrPoqiycjqnOFaQ=:
```

The size rule is exact and both ways: a presentation of more than 6144
octets MUST be sent by reference, and one of 6144 octets or fewer MUST be
sent inline. A verifier refuses either the wrong way round
(`presentation_malformed`). So every presentation has one encoding, and a
signed header cannot be swapped for the other form of the same value.

The threshold applies to the decoded octets. Base64 makes the inline field
larger: a 6144-octet presentation is 8192 characters between the colons, so
its field line runs to about 8.2 KB with the field name. Some servers and
proxies limit a request header line to 8 KB by default and refuse a longer
one before the verifier sees the request, so a relying party that accepts
agent requests SHOULD allow header lines of at least 16 KB at every hop in
front of its verifier.

### 1.2 The request content for presentations by reference

A request that carries any presentation by reference MUST have a JSON object
(RFC 8259) as its content, with a member `agent_credentials` whose value is
an object holding each referenced presentation as a string:

| Header | Member of `agent_credentials` |
|---|---|
| `Agent-Passport` | `agent_passport` |
| `Agent-Grant` | `agent_grant` |
| `Agent-Trust` | `agent_trust` |

The content of the vector above, abridged (its presentation runs to 6158
octets):

<!-- vector: sign 4 body abridged -->
```json
{"cart_id":"c-2002","agent_credentials":{"agent_passport":"passport-placeholder.shopper-01.issuer.example~disclosure-0001~..."}}
```

The rest of the object belongs to the application. The verifier checks that
SHA-256 of the member's octets (UTF-8) equals the header's `sha-256`
parameter (`presentation_hash_mismatch`), and refuses a missing member or a
content that is not such an object (`presentation_missing`). Inline
presentations are taken from the headers only; an `agent_credentials`
member for an inline presentation is ignored.

The content is read only when it is UTF-8 and nests arrays and objects at
most 64 deep, counting the content's own object as 1 and not counting
brackets inside strings. Deeper content is treated as carrying no
presentations (`presentation_missing`), and a signer refuses to sign it, so
a JSON parser's own nesting limit never decides the outcome. Numbers are
read whatever their length or magnitude; only the presentation members'
string values are used.

The content is covered through `Content-Digest` (section 2), and the
`sha-256` parameter through the signed header, so a referenced presentation
is bound to the signature twice: replacing it changes both the digest of
the content and the hash the signature covers.

## 2. `Content-Digest`

Every signed request carries `Content-Digest` (RFC 9530 section 2), a
Dictionary with exactly one member, `sha-256`, whose value is a Byte
Sequence holding SHA-256 of the request content, with no parameters:

<!-- vector: content_digest 0 -->
```
Content-Digest: sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:
```

(the content `{"hello": "world"}`, RFC 9530 Appendix D). A request without
content, such as a `GET`, carries the digest of empty content
(`sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:`), as RFC 9530
section 6.3 allows, so the profile has one shape for every request. The
digest is over the content as sent, after any content coding.

RFC 9530 lets a sender add digests for other algorithms. This profile does
not: a verifier refuses a field with any other member, or none
(`content_digest_malformed`), and a digest that does not match the content
(`content_digest_mismatch`).

## 3. The signing profile

### 3.1 Covered components and parameters

A request is signed with one RFC 9421 signature whose covered components
are exactly, in this order:

<!-- profile: covered components -->
```
("@method" "@authority" "@path" "content-digest" "agent-passport" "agent-grant")
```

with exactly these signature parameters, in this order, and no others:

| Parameter | Type (RFC 9421 section 2.3) | Value |
|---|---|---|
| `created` | Integer | Creation time, UNIX seconds. |
| `expires` | Integer | Expiry, UNIX seconds. `expires - created` MUST be at least 1 and at most 300. |
| `nonce` | String | A unique value for this signature: 22 to 128 characters from the base64url alphabet (`A-Z a-z 0-9 - _`). The libraries use 32 random octets, base64url encoded without padding. |
| `keyid` | String | The RFC 7638 JWK thumbprint (SHA-256, base64url without padding, 43 characters) of the agent's public key. |
| `tag` | String | `agent-payer-auth`. |

There is no `alg` parameter: the algorithm is determined by the key (RFC
9421 section 3.2 step 6.3), and a signature that carries `alg` is refused
(section 3.2.1 allows an application to prohibit it). The components carry
no parameters. The derived components are taken as RFC 9421 section 2.2
specifies: `@method` is the method as sent, case preserved (section 2.2.1);
`@authority` is the target URI's host, lowercased, and port, omitted when it
is the scheme's default (section 2.2.3); `@path` is the target's absolute
path before percent-decoding, without the query, and `/` when empty
(section 2.2.6). The three header components are the field values as sent
(section 2.1): each instance trimmed of surrounding whitespace, several
instances joined with `, `.

The signature is labelled `sig1` by default. A verifier does not rely on the
label: it selects the signature whose `tag` is `agent-payer-auth` (RFC 9421
section 7.2.7) and ignores signatures with other tags, so the agent may add
other signatures next to it (section 4.3).

### 3.2 Algorithms and keys

| Key | Algorithm (RFC 9421) | Signature value |
|---|---|---|
| JWK `kty` `EC`, `crv` `P-256` | `ecdsa-p256-sha256` (section 3.3.4) | 64 octets: `r` then `s`, each a 32-octet big-endian unsigned integer. **Not** DER; a DER-encoded signature is refused. |
| JWK `kty` `OKP`, `crv` `Ed25519` (RFC 8037 section 2) | `ed25519` (section 3.3.6) | 64 octets: `R` then `S` (RFC 8032 section 5.1.6). |

A JWK that carries `alg` MUST carry `ES256` (P-256) or `EdDSA` or `Ed25519`
(Ed25519); any other value is refused (RFC 9421 section 3.2 step 6.5). The
`keyid` is the key's RFC 7638 thumbprint, computed over the required members
in lexicographic order: `crv`, `kty`, `x`, `y` for P-256 (RFC 7638 section
3.2) and `crv`, `kty`, `x` for Ed25519 (RFC 8037 Appendix A.3).

### 3.3 Example

The first `sign` vector: an Ed25519 key, a checkout request with both
presentations inline.

<!-- vector: sign 0 -->
```http
POST /v1/checkout?cart=c-1001 HTTP/1.1
Host: merchant.example
Content-Digest: sha-256=:ou0HmWKvYXh5e6SAheM4yXuFVOLEEQQICH4DTeBOiN4=:
Agent-Passport: :cGFzc3BvcnQtcGxhY2Vob2xkZXIuc2hvcHBlci0wMS5pc3N1ZXIuZXhhbXBsZX5kaXNjbG9zdXJlLWdpdmVuLW5hbWV+a2ItcGxhY2Vob2xkZXI=:
Agent-Grant: :Z3JhbnQtcGxhY2Vob2xkZXIuc2hvcHBlci0wMS5uaW1idXMtc2hvcHBlci0yLjQucHJvdmlkZXIuZXhhbXBsZQ==:
Signature-Input: sig1=("@method" "@authority" "@path" "content-digest" "agent-passport" "agent-grant");created=1790000000;expires=1790000300;nonce="n0nce-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1";keyid="L5d-U2k4C-PU3btGPZH_EES9tK5GNxadBYz5Md91Q9E";tag="agent-payer-auth"
Signature: sig1=:b9LPqC+fsDY+ev4/FwRvy4hKGpoxlY26nVqLleOk8us6WzYfMUTcBSy+9FEDUiV44iRv3hgMCnUd/EJ0KHUcCg==:

{"cart_id":"c-1001","amount":{"value":"42.00","currency":"USD"}}
```

Its signature base (RFC 9421 section 2.5; no newline after the last line):

<!-- vector: sign 0 signature_base -->
```
"@method": POST
"@authority": merchant.example
"@path": /v1/checkout
"content-digest": sha-256=:ou0HmWKvYXh5e6SAheM4yXuFVOLEEQQICH4DTeBOiN4=:
"agent-passport": :cGFzc3BvcnQtcGxhY2Vob2xkZXIuc2hvcHBlci0wMS5pc3N1ZXIuZXhhbXBsZX5kaXNjbG9zdXJlLWdpdmVuLW5hbWV+a2ItcGxhY2Vob2xkZXI=:
"agent-grant": :Z3JhbnQtcGxhY2Vob2xkZXIuc2hvcHBlci0wMS5uaW1idXMtc2hvcHBlci0yLjQucHJvdmlkZXIuZXhhbXBsZQ==:
"@signature-params": ("@method" "@authority" "@path" "content-digest" "agent-passport" "agent-grant");created=1790000000;expires=1790000300;nonce="n0nce-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1";keyid="L5d-U2k4C-PU3btGPZH_EES9tK5GNxadBYz5Md91Q9E";tag="agent-payer-auth"
```

## 4. Verification

### 4.1 Inputs

The verifier supplies, besides the request:

- **its own authority** (`merchant.example`, or `merchant.example:8443` for a
  non-default port), used as `@authority` in the signature base. A request
  that names another authority in an absolute URL is refused, and one sent
  to another authority fails the signature. `@authority` omits the default
  port (RFC 9421 section 2.2.3), so the libraries refuse a configured
  authority ending in `:80` or `:443` as a configuration error rather than
  deny every request;
- **a key resolver**, which returns the public JWK the verifier trusts for a
  `keyid` (for example the key the agent's Agent Passport is bound to, from
  the registry), or nothing;
- **a nonce store** (section 4.4);
- optionally **the current time** and a **clock skew** in seconds (default
  10, at most 60).

### 4.2 Steps

A verifier MUST apply these steps in this order, and stop at the first that
fails with the denial code and reason shown. The order is part of the
profile: the shared vectors check the reason as well as the code.

| # | Check | Code | Reason |
|---|---|---|---|
| 1 | `Signature-Input` and `Signature` are both present. | `request_signature_invalid` | `signature_missing` |
| 2 | Both parse as RFC 9651 Dictionaries (RFC 9421 sections 4.1, 4.2). | `request_signature_invalid` | `signature_malformed` |
| 3 | Exactly one `Signature-Input` member is an Inner List whose `tag` parameter is the String `agent-payer-auth`. None: | `request_signature_invalid` | `signature_not_found` |
|   | More than one: | `request_signature_invalid` | `signature_ambiguous` |
| 4 | `Signature` has a member with the same label, a Byte Sequence without parameters (RFC 9421 section 3.2 step 1.2). | `request_signature_invalid` | `signature_malformed` |
| 5 | The covered components are exactly the six of section 3.1, in order, as Strings without parameters. | `request_signature_invalid` | `covered_components_mismatch` |
| 6 | The parameters are exactly `created`, `expires`, `nonce`, `keyid`, `tag` in that order, with the types of section 3.1; `created` is not negative, `expires` is after `created`, and `nonce` and `keyid` have the formats of section 3.1. | `request_signature_invalid` | `signature_params_mismatch` |
| 7 | `expires - created` is at most 300. | `request_signature_invalid` | `window_too_long` |
| 8 | `created` is not later than now plus the skew. | `request_signature_invalid` | `created_in_future` |
| 9 | Now is earlier than `expires` plus the skew. | `request_signature_stale` | `expired` |
| 10 | If the request's target is an absolute URL, its authority (normalised as in section 3.1) is the verifier's. | `request_signature_invalid` | `authority_mismatch` |
| 11 | `Content-Digest` is present and has the shape of section 2. | `request_signature_invalid` | `content_digest_malformed` |
| 12 | `Agent-Passport` and `Agent-Grant` are present, and those two and `Agent-Trust` (if present) each parse as one of the two forms of section 1.1; an inline presentation is at most 6144 octets. | `request_signature_invalid` | `presentation_malformed` |
| 13 | The resolver returns a key for `keyid`. | `request_signature_invalid` | `key_unknown` |
| 14 | The key is a public P-256 or Ed25519 JWK (section 3.2) whose thumbprint is `keyid`. | `request_signature_invalid` | `key_mismatch` |
| 15 | The signature verifies over the signature base recreated from the request (RFC 9421 section 3.2 steps 7 and 8), with the verifier's authority as `@authority`. | `request_signature_invalid` | `signature_mismatch` |
| 16 | The digest in `Content-Digest` is SHA-256 of the content. | `request_signature_invalid` | `content_digest_mismatch` |
| 17 | Each presentation by reference is in the content (section 1.2) | `request_signature_invalid` | `presentation_missing` |
|    | and is more than 6144 octets of printable ASCII other than space | `request_signature_invalid` | `presentation_malformed` |
|    | and its SHA-256 is the header's `sha-256`. | `request_signature_invalid` | `presentation_hash_mismatch` |
| 18 | The nonce store has not seen this `nonce` for this `keyid`, and records it until `expires` plus the skew. | `request_signature_invalid` | `nonce_replayed` |

The content is read (steps 16 and 17) only after the signature has been
verified, and a nonce is recorded (step 18) only for a request that passed
every other check, so a forged request cannot use up an agent's nonce.

The codes are those of the registry's denial list (`request_signature_invalid`,
`request_signature_stale`). A failure of the key resolver or the nonce store
is not a denial: the libraries raise it to the caller, which MUST refuse the
request (and answer with a server error, since the request may be good).

On success the verifier has: the `keyid` and the key, the algorithm, the
signature's `created`, `expires` and `nonce`, and the Agent Passport, grant
and (if sent) trust statement, each as a string. Checking those credentials
(the Agent Passport's signature, status and key binding to `keyid`, the
grant, the trust statement) is the next step of verification and is not part
of this profile.

### 4.3 Time

`created` more than the skew in the future is refused (`created_in_future`).
A signature is stale (`request_signature_stale`) from `expires` plus the
skew. With the window capped at 300 seconds, no signature is accepted more
than 300 seconds plus the skew after it was made.

### 4.4 Nonces

A signature can be replayed until it expires (RFC 9421 section 7.2.2), so
the verifier keeps every nonce it accepts, keyed by `keyid` and `nonce`,
until the signature's `expires` plus the skew, and refuses a second request
with the same pair (`nonce_replayed`). The check and the record MUST be one
atomic operation, or two copies of a request sent at once can both pass. A
deployment with more than one verifier instance MUST share the store (for
example a Redis `SET key value NX PXAT`); the in-memory store the libraries
ship is for a single process and for tests.

### 4.5 What the signature does not cover

- **The query string.** `@path` does not include the query (RFC 9421 section
  2.2.6), and `@query` is not covered, so the query of a signed request can
  be changed without breaking the signature. A relying party MUST NOT take
  anything that affects authority, amount or payee from the query of a signed
  request; carry it in the content, which `Content-Digest` covers
  (FINDINGS G-95).
- **`Agent-Trust`.** The trust statement is signed by the registry, so it
  cannot be altered, but it is not bound to this request: a relying party
  MUST check that it names the key or the Agent Passport of the signature it
  accompanies (FINDINGS G-96). A trust statement by reference is carried in
  the content, which is covered.
- **Other headers**, including `Content-Type`. The content is covered as
  octets, not as a media type.

## 5. Libraries

Both libraries implement this document, the parts of RFC 9421 it relies on
(the signature base for requests and responses with the derived components
`@method`, `@authority`, `@scheme`, `@path`, `@query` and `@status` and
header fields without component parameters; `ecdsa-p256-sha256` and
`ed25519`), and an RFC 9651 parser and serializer.

TypeScript:

<!-- snippet: packages/agent-httpsig/tests/docs/examples/sign-and-verify.ts -->
```typescript
import { generateKeyPairSync } from 'node:crypto';
import { InMemoryNonceStore, jwkThumbprint, publicJwk, sign, verify } from '@grantex/agent-httpsig';
import type { AgentJwk, VerifyResult } from '@grantex/agent-httpsig';

export async function signAndVerify(agentPassport: string, agentGrant: string): Promise<VerifyResult> {
  // The agent's key. In production it is the key its Agent Passport is bound to.
  const agentKey: AgentJwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });

  // Agent side: sign the request and send the headers sign() returns.
  const request = {
    method: 'POST',
    url: 'https://merchant.example/v1/checkout',
    headers: { 'content-type': 'application/json' } as Record<string, string>,
    body: JSON.stringify({ cart_id: 'c-1001' }),
  };
  const signed = sign(request, { key: agentKey, agentPassport, agentGrant });
  Object.assign(request.headers, signed.headers);

  // Relying party: verify it. The resolver returns the public key the
  // relying party trusts for the keyid, or null.
  const trustedKey = publicJwk(agentKey);
  const trustedKeyid = jwkThumbprint(trustedKey);
  return verify(request, {
    expectedAuthority: 'merchant.example',
    resolveKey: async (keyid) => (keyid === trustedKeyid ? trustedKey : null),
    nonceStore: new InMemoryNonceStore(),
  });
}
```

Python:

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

## 6. Test vectors

[`examples/agent-httpsig-vectors.json`](examples/agent-httpsig-vectors.json)
holds, for both libraries:

- `sign`: Ed25519 requests that MUST be reproduced byte for byte (Ed25519 is
  deterministic), including a non-default port, authority and path
  normalisation, an empty path, a request without content, `Agent-Trust`, and
  an Agent Passport over 6 KB carried by reference;
- `ecdsa`: an ECDSA P-256 request to verify (ECDSA is not deterministic);
- `verify`: accepted and refused requests with the expected code and reason
  of section 4.2, among them `Agent-Passport` and `Agent-Grant` values
  swapped under a valid signature, a replayed nonce, a foreign authority, an
  expired signature, a window over 300 seconds, a different tag, missing,
  extra and reordered components and parameters, a DER-encoded ECDSA
  signature, each presentation-by-reference failure, and content at and
  beyond the nesting limit of section 1.2 or holding a 5000-digit number;
- `rfc9421`: the signature bases of RFC 9421 section 2.5 and Appendix B.2.1,
  B.2.3, B.2.4, B.2.5 and B.2.6 rebuilt from the RFC's messages, with the
  B.2.4 (ECDSA P-256) and B.2.6 (Ed25519) signatures verified with the RFC's
  public test keys. B.2.2 is not reproduced: it uses `@query-param`, which
  the libraries do not implement;
- `thumbprints` (RFC 8037 Appendix A.3 and the RFC 9421 P-256 test key) and
  `content_digest` (RFC 9530 Appendix D).

The test keys are for tests only. The Ed25519 key is derived when the tests
run from a published seed label, and only the public half of the P-256 key
exists.
