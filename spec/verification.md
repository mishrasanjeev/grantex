# Agent request verification

Status: draft (Agent Trust Registry, Phase 1). Sections 1 to 6 hold the
header specification and the request signing profile, implemented by
`@grantex/agent-httpsig` (TypeScript, `packages/agent-httpsig`) and
`grantex-agent-httpsig` (Python, `packages/agent-httpsig-py`), neither of
which is published yet. Both run the shared test vectors in
[`examples/agent-httpsig-vectors.json`](examples/agent-httpsig-vectors.json).
Section 7 is what a relying party checks around the signature (the Agent
Passport, the grant, both status sources and the staleness matrix),
implemented by `grantex-verifier` (Python, `packages/verifier-py`, 0.1.0, not
published).

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

## 7. Relying-party verification

This section says what a relying party checks, besides the request
signature of section 4, before it acts on an agent's request: the Agent
Passport ([agent-passport-1.0.md](agent-passport-1.0.md)), the grant
([grant-token-0.6.md](grant-token-0.6.md), bound to the passport as
[passport-binding.md](passport-binding.md) section 5 describes), both status
sources, the key, and the transaction. `grantex-verifier`
(`packages/verifier-py`) implements it; its tests build a registry, an
issuer and an agent and exercise every row below.

Two rules frame it:

- **Two status sources.** A passport is usable only while its issuer holds
  it VALID in the issuer's Token Status List *and* the registry holds its
  attestation VALID in the registry's acceptance list
  (draft-ietf-oauth-status-list-21 §7.1). Either one alone is not enough.
- **Key equality** ([agent-passport-1.0.md](agent-passport-1.0.md) §7). The
  passport's `cnf` key, the grant's `cnf.jkt` (RFC 9449 §6.1), the grant's
  `passport.key_thumbprint` and the request's `keyid` are the same key: their
  RFC 7638 SHA-256 thumbprints are equal.

### 7.1 Inputs

The relying party configures:

- **its origin** (`https://merchant.example`), from which the `@authority` of
  section 4.1 is derived, and optionally a separate **audience** for root
  grants (default: the origin);
- **the registry**: its issuer identifier, its JWK Set (the set itself, or its
  URL) and the URL of its signed manifest
  ([registry-federation.md](registry-federation.md), "Registry manifest").
  Keys are taken from nowhere else: an issuer's keys come only from the
  manifest, never from a URL or a key named in a token;
- a **fetcher** for the manifest, the JWK Set and the status lists (https, no
  redirects, as the registry's own fetcher);
- a **registry lookup** by key thumbprint
  (`GET /v1/registry/agents?key_thumbprint=`);
- a **grant status source**: the auth service's revocation status endpoint
  (`GET /v1/revocations/status`), read on every verification, or the
  revocation feed;
- a **nonce store** (section 4.4), optionally the **HITL threshold** (minor
  units) and a **minimum trust level**.

For each request it passes the Agent Passport and grant the request presents
(section 1), the request, and the transaction: when it happens, the amount in
minor units, the currency, the merchant's origin and, if it knows, whether
the Principal is present. The transaction is read from the signed content,
never from the query string (section 4.5).

### 7.2 Checks

Every check is evaluated and reported with `ok`, a `detail` and `cached_at`
(when the data it relied on was read). A check that depends on one that
failed is reported as failed and "not evaluated", without a code of its own.
The **first failing check in this order sets the denial code**; the result is
`ok` only when every check passes.

| # | Check | Rule | Denial codes |
|---|---|---|---|
| 1 | `issuer.accredited` | The passport's `iss` is an issuer of a valid manifest (7.3), its status there is `active`, and its `trust_marks` include `urn:grantex:tm:agent.identity`. Read before the signature, as at grant issuance, so an unknown or suspended issuer is refused as such. The status is the one in effect when the manifest was issued, at most an hour earlier (FINDINGS G-138). | `issuer_not_accredited` (absent, `withdrawn` or any other status), `issuer_suspended`, `trust_mark_missing`; a manifest that does not verify: `passport_invalid_signature`; one that is stale or cannot be read: `status_stale` |
| 2 | `passport.signature` | The passport verifies as [agent-passport-1.0.md](agent-passport-1.0.md) §4 describes, with the key of the issuer's manifest `jwks` whose `kid` is the header's (a passport without `kid` has no key), 60 seconds of clock skew, a P-256 `cnf` key, and no KB-JWT (the request signature proves possession). | `passport_invalid_signature`, `passport_expired`, `passport_malformed`, `passport_not_accepted` |
| 3 | `passport.status` | The passport's `status.status_list.uri` is under the issuer's `status_list_base` and already in its URL-serialised form (https, no query, fragment or dot segments, as the registry's rule for status URIs); the list there is a `statuslist+jwt` (draft-ietf-oauth-status-list-21 §5.1) signed by the issuer's manifest key for its `kid`, with `sub` equal to the URI (§8.3), fresh (7.3), and the entry at `idx` is VALID. | `passport_revoked` (INVALID, SUSPENDED or any other value), `status_stale` |
| 4 | `attestation.registered` | The grant carries one `urn:grantex:commerce:v1` entry whose `passport` names the passport's issuer, its disclosed `attestation_id` and its hash ([agent-passport-1.0.md](agent-passport-1.0.md) §6). | `attestation_not_registered` (no binding, no disclosed `attestation_id`, another id), `attestation_mismatch` (another issuer), `attestation_hash_mismatch` |
| 5 | `attestation.accepted` | The entry's `acceptance_status` `{uri, idx}` names one of the registry's acceptance lists (under the manifest's `acceptance_status_list` endpoint); the list is a `statuslist+jwt` signed with the registry JWK Set, `iss` the registry and `sub` the URI, fresh, and the entry is VALID. | `attestation_not_accepted` (`acceptance_invalid`, `acceptance_suspended`), `attestation_not_registered` (not a registry list), `status_stale` |
| 6 | `grant.signature` | The grant is a JWS with `typ` `at+jwt`, `RS256` or `ES256`, verified with the registry JWK Set key for its `kid`; `iss` is the registry; `exp`, `iat` and `nbf` hold with 60 seconds of skew; `jti` and `sub` are present; at most one commerce entry. | `token_invalid`; registry keys that cannot be read: `status_stale` |
| 7 | `grant.status` | The grant status source says the grant (by `urn:grantex:grant.grant_id`, `jti` and `parent_grant_id`) is not revoked. An unknown or unreadable state is a refusal. | `grant_revoked` (revoked or suspended), `status_stale` |
| 8 | `grant.audience` | `aud` contains the configured audience exactly; for a child grant (one that names `parent_grant_id`), the merchant's origin. | `audience_mismatch` |
| 9 | `key.binding` | Key equality: passport `cnf`, grant `cnf.jkt`, the commerce entry's `passport.key_thumbprint` and the request's `keyid`. | `key_binding_mismatch` |
| 10 | `key.status` | The registry lookup for the passport's key thumbprint names the passport's `sub`, and the key is `active` or `rotated` with `key_current` true. | `key_unproven` (no agent holds the key, or `pending`), `key_not_active` (`compromised`, rotated past its overlap, any other status), `key_binding_mismatch` (held by another agent), `status_stale` (lookup failed) |
| 11 | `request.signature` | Section 4, with the passport's `cnf` key as the only key and the origin's authority; and the presentations it signed are the ones being verified. | `request_signature_invalid`, `request_signature_stale` |
| 12 | `level` | When a minimum is configured, the lookup's `level` is at least it (`basic` < `verified` < `attested` < `attested_verified`). | `level_below_policy`, `status_stale` |
| 13 | `constraints` | The transaction is within the commerce entry's `constraints` (7.5). | `cap_exceeded` (window, currency, amount), `audience_mismatch` (merchant), `token_invalid` (unreadable) |
| 14 | `budget.remaining` | The grant's `urn:grantex:params:oauth:authorization-details:budget` entry is reported. The authorization server enforces the budget; the verifier does not. | `token_invalid` (unreadable) |

A failure of the nonce store is not a denial: it is raised to the caller,
which refuses the request with a server error (section 4.2).

### 7.3 Staleness matrix

How old the relying party's copy of each source may be when it relies on it
(PRD §9). Beyond its bound a source is read again; one that cannot be read
again, or that does not verify, is `status_stale`. An older copy is never
used in its place.

| Source | Maximum age |
|---|---|
| Registry JWK Set (the key set for the manifest, the acceptance lists and grants) | 24 hours; read early, at most every five minutes, when a token names a `kid` it lacks |
| Registry manifest (issuer keys, accreditation, trust marks) | 1 hour after its `iat`, before its `exp`, `iat` not more than 60 s in the future; reread every five minutes, and a copy still inside its hour is used while the registry cannot be reached |
| Status lists (the issuer's and the registry's) | the list's `ttl`, and at most 5 minutes; **60 seconds** when the amount is above the HITL threshold or the transaction is human-not-present Tier A (7.6). A list is also unusable from its `exp` (or, without `exp`, `iat` + `ttl`) |
| Registry lookup (key status, level, flags) | the status-list bound, and at most 60 seconds (the public answer's `max-age`) |
| Revocation feed (when used) | heartbeat every second; the grant's state is unknown, and refused, 10 seconds after the last heartbeat |
| Online revocation status | read on every verification |

The HITL threshold is the lower of the relying party's and the grant's
`constraints.hitl_threshold_minor`. An unknown amount is treated as above a
configured threshold.

### 7.4 Denial taxonomy and HTTP status

The codes are PRD Appendix C's. Three refusals have no Appendix C code; they
use the codes the grantex SDKs' `enforce()` already returns (FINDINGS G-135):
`token_invalid` (a grant that does not verify or cannot be read),
`grant_revoked` and `cap_exceeded` (a transaction outside the grant's
constraints). The Agent Passport profile's `passport_malformed` and
`passport_not_accepted` pass through as at grant issuance.

The middleware answers a refusal with `401` for `request_signature_invalid`
and `request_signature_stale` (and a request without both presentations),
`503` for `status_stale` (the request may be good; the relying party could
not establish it), and `403` for every other code, with a JSON body
`{"denial_code": ..., "check": ...}`. Each mapping can be changed.

### 7.5 What the verifier reads from the grant

The commerce entry (`urn:grantex:commerce:v1`) carries `passport` and
`acceptance_status` ([passport-binding.md](passport-binding.md) §5) and, for
a grant with commerce limits, `constraints`, an object with these members:

| Member | Type | Rule |
|---|---|---|
| `amount_range` | object with `min_minor` and `max_minor`, non-negative integers | The amount, in minor units, is at least `min_minor` and at most `max_minor`. |
| `currency` | ISO 4217 code, upper case | The transaction's currency is this one. |
| `allowed_merchants` | array of origins | The transaction's merchant is one of them. |
| `window` | object with `not_before` and `not_after`, integers (UNIX seconds) | The transaction happens at or after `not_before` and before `not_after`. |
| `human_present` | boolean | Whether the Principal is present (7.6). |
| `hitl_threshold_minor` | non-negative integer | The grant's HITL threshold (7.3). |

Every member is optional. A member the verifier does not know, or one of the
wrong type, makes the constraints unreadable (`token_invalid`): a
restriction is never ignored. The transaction must be inside the window
(`not_before` inclusive, `not_after` exclusive), its merchant (default: the
relying party's origin) in `allowed_merchants`, its currency the
`currency`, and its amount within `amount_range`; an unknown amount against
an `amount_range` is refused. A grant without `constraints` is limited by
its scopes and budget only. The issuing side of these members belongs to
per-merchant child grants, which are not in this tree yet (FINDINGS G-136).

### 7.6 Tier (information only in Phase 1)

The verifier reports a tier for the transaction; in Phase 1 it only chooses
the status staleness bound (7.3), and no policy acts on it. Tier policy
enforcement is Phase 3. The default rules:

| Tier | When |
|---|---|
| A | The Principal is not present (the transaction's `human_present`, else the grant's `constraints.human_present`, else not present). |
| B | The Principal is present and the amount is at or below the HITL threshold, or no threshold applies. |
| C | The Principal is present and the amount is above the threshold, or unknown. |

A relying party may supply its own rules; the 60-second bound still applies
above the threshold whatever the tier.

### 7.7 Evidence

With every result the verifier returns an evidence record (PRD §8.10): the
time of verification and of the transaction, the agent's DID, the issuer,
the passport's hash, the attestation id, the key thumbprint, the grant id,
both status results (`uri`, `idx`, the status read and when it was read),
the level and flags at verification time, the tier, the budget reported, the
manifest's `iat` and the denial code. The hash identifies the exact bytes of
the issuer-signed JWT; do not key a deny list on it alone
([agent-passport-1.0.md](agent-passport-1.0.md) §6).

### 7.8 Payment-protocol rendering (Phase 1 preview)

The library renders a verified grant into two payment protocols, as pure
functions with no network call and no signature: a per-merchant child
grant's limits as an ACP delegated payment `allowance` and a Stripe Shared
Payment Token `usage_limits` (the earlier of the grant's `exp` and its
window's end), and claims for AP2 v0.2 open Checkout and Payment Mandates
whose `cnf` is the agent's key (RFC 7800 §3.2), with the grant's passport
reference as a selectively disclosable claim (RFC 9901 §4.2). They are
previews: their member names follow those public specifications as
published and must be checked against the current texts before a later
phase relies on them (FINDINGS G-137).
