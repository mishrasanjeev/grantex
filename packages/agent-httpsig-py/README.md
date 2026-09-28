# grantex-agent-httpsig

> **Not yet published.** Version 0.1.0 lives in this repository only; it is
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
- `ecdsa-p256-sha256` (P-256 JWKs) and `ed25519` (Ed25519 JWKs);
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

## Also exported

- `content_digest(body)`, `jwk_thumbprint(jwk)`, `public_jwk(jwk)`,
  `private_jwk_from_key(key)`;
- `signature_base_for(message, label)` and `verify_signature_value(jwk, base,
  signature)`: RFC 9421 section 2.5 and section 3.3 for any request or
  response whose covered components are `@method`, `@authority`, `@scheme`,
  `@path`, `@query`, `@status` or header fields without component
  parameters;
- `parse_dictionary`, `parse_list`, `parse_item` and the matching
  serializers (RFC 9651).

## Development

```bash
pip install -e ".[dev]"
mypy --strict src
pytest
```

License: Apache-2.0.
