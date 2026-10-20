# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
"""The key directory and several signatures on one request (G50).

Mirrors packages/agent-httpsig/tests/directory.test.ts.
"""

from __future__ import annotations

import json

import pytest
from cryptography.hazmat.primitives.asymmetric import ec, ed25519

from grantex_agent_httpsig import (
    AgentHttpSigError,
    HttpRequest,
    HttpResponse,
    InMemoryNonceStore,
    build_signature_directory,
    combine_signatures,
    jwk_thumbprint,
    private_jwk_from_key,
    public_jwk,
    sign_directory_response,
    sign_with_profile,
    verify_directory_response,
    verify_with_profile,
)

NOW = 1_790_000_000
ED = private_jwk_from_key(ed25519.Ed25519PrivateKey.generate())
EC = private_jwk_from_key(ec.generate_private_key(ec.SECP256R1()))


def _served(signing: list) -> HttpResponse:  # type: ignore[type-arg]
    body = json.dumps(build_signature_directory([ED, EC]))
    headers = sign_directory_response(body, authority="agents.example", signing_keys=signing, created=NOW)
    return HttpResponse(200, headers, body)


def test_directory_keys_and_signatures() -> None:
    doc = build_signature_directory([ED, EC, ED])
    assert [k["kid"] for k in doc["keys"]] == [jwk_thumbprint(ED), jwk_thumbprint(EC)]
    assert all("d" not in k and k["use"] == "sig" for k in doc["keys"])
    out = verify_directory_response(_served([ED, EC]), authority="agents.example", now=NOW + 10)
    assert [k["kid"] for k in out.keys] == [jwk_thumbprint(ED), jwk_thumbprint(EC)]


def test_keys_without_their_own_signature_are_ignored() -> None:
    partly = _served([ED])
    out = verify_directory_response(partly, authority="agents.example", now=NOW + 10)
    assert [k["kid"] for k in out.keys] == [jwk_thumbprint(ED)] and out.ignored == [jwk_thumbprint(EC)]
    assert verify_directory_response(partly, authority="elsewhere.example", now=NOW + 10).keys == []
    assert verify_directory_response(partly, authority="agents.example", now=NOW + 400).keys == []
    changed = HttpResponse(200, partly.headers, str(partly.body).replace('"use": "sig"', '"use": "sig" '))
    assert verify_directory_response(changed, authority="agents.example", now=NOW + 10).keys == []
    with pytest.raises(AgentHttpSigError):
        verify_directory_response(
            HttpResponse(200, dict(partly.headers, **{"Content-Type": "application/json"}), partly.body),  # type: ignore[arg-type]
            authority="agents.example",
        )


def test_grantex_and_web_bot_auth_signatures_together() -> None:
    req = HttpRequest("POST", "https://merchant.example/v1/checkout", {}, '{"cart_id":"c-1001"}')
    grantex = sign_with_profile(req, key=ED, agent_passport="passport-placeholder", agent_grant="grant-placeholder", created=NOW)
    wba = sign_with_profile(
        req, profile="web-bot-auth", key=ED, label="sig2", created=NOW,
        components=["@method", "@authority", "@path", "content-digest", "signature-agent"],
        signature_agent_url="https://registry.example",
    )
    headers = combine_signatures(grantex, wba)
    assert headers["Signature-Agent"] == 'sig2="https://registry.example"'
    message = HttpRequest(req.method, req.url, headers, req.body)
    pub = public_jwk(ED)
    g = verify_with_profile(message, expected_authority="merchant.example", now=NOW + 1, nonce_store=InMemoryNonceStore(), resolve_key=lambda _k: pub)
    assert g.ok and g.label == "sig1"
    w = verify_with_profile(
        message, profile="web-bot-auth", expected_authority="merchant.example", now=NOW + 1,
        nonce_store=InMemoryNonceStore(), resolve_key=lambda ref: pub if ref.signature_agent.url == "https://registry.example" else None,
    )
    assert w.ok and w.label == "sig2"
    with pytest.raises(AgentHttpSigError, match="used twice"):
        combine_signatures(wba, wba)
