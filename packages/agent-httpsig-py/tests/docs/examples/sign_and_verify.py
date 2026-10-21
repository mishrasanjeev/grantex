# SPDX-License-Identifier: Apache-2.0
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
