# SPDX-License-Identifier: Apache-2.0
"""RSA-PSS (RFC 9421 section 3.3.1, ``rsa-pss-sha512``).

Round trips under the tap and web-bot-auth profiles and for TAP body
objects, the 2048-bit minimum, and the grantex profile staying P-256 /
Ed25519 only. The RFC's own RSA-PSS signatures are verified in
test_rfc9421.py. Mirrors packages/agent-httpsig/tests/rsa-pss.test.ts.
"""

from __future__ import annotations

from typing import Any, Dict

import pytest
from cryptography.hazmat.primitives.asymmetric import ed25519, rsa

from grantex_agent_httpsig import (
    AgentHttpSigError,
    HttpRequest,
    InMemoryNonceStore,
    build_agentic_payment_container,
    jwk_thumbprint,
    private_jwk_from_key,
    public_jwk,
    sign,
    sign_with_profile,
    verify,
    verify_signature_value,
    verify_tap_body_objects,
    verify_with_profile,
)

NOW = 1_790_000_000
KEY = private_jwk_from_key(rsa.generate_private_key(public_exponent=65537, key_size=2048))


def _req(**headers: str) -> HttpRequest:
    h: Dict[str, str] = {"content-type": "application/json"}
    h.update(headers)
    return HttpRequest("POST", "https://merchant.example/v1/checkout", h, '{"cart_id":"c-1001"}')


def _signed(result_headers: Dict[str, str], url: str = "https://merchant.example/v1/checkout") -> HttpRequest:
    h: Dict[str, Any] = {"content-type": "application/json"}
    h.update(result_headers)
    return HttpRequest("POST", url, h, '{"cart_id":"c-1001"}')


def test_tap_round_trip_randomized() -> None:
    a = sign_with_profile(_req(), profile="tap", key=KEY, keyid="rsa-key-01", created=NOW, nonce="n-1")
    b = sign_with_profile(_req(), profile="tap", key=KEY, keyid="rsa-key-01", created=NOW, nonce="n-1")
    assert a.alg == "rsa-pss-sha512" and 'alg="rsa-pss-sha512"' in a.headers["Signature-Input"]
    assert a.signature_base == b.signature_base and a.headers["Signature"] != b.headers["Signature"]
    kw: Dict[str, Any] = dict(profile="tap", expected_authority="merchant.example", now=NOW + 1,
                              resolve_key=lambda ref: public_jwk(KEY))
    assert verify_with_profile(_signed(a.headers), nonce_store=InMemoryNonceStore(), **kw).ok
    out = verify_with_profile(_signed(a.headers, "https://merchant.example/v1/other"), nonce_store=InMemoryNonceStore(), **kw)
    assert out.reason == "signature_mismatch"


def test_web_bot_auth_round_trip() -> None:
    s = sign_with_profile(_req(), profile="web-bot-auth", key=KEY, created=NOW, signature_agent_url="https://agents.example")
    assert s.keyid == jwk_thumbprint(KEY)
    out = verify_with_profile(
        _signed(s.headers), profile="web-bot-auth", expected_authority="merchant.example", now=NOW + 1,
        nonce_store=InMemoryNonceStore(), resolve_key=lambda ref: public_jwk(KEY),
    )
    assert out.ok and out.alg == "rsa-pss-sha512"


def test_minimum_2048_bits() -> None:
    small_key = rsa.generate_private_key(public_exponent=65537, key_size=1024)
    with pytest.raises(AgentHttpSigError, match="2048"):
        private_jwk_from_key(small_key)
    n = small_key.public_key().public_numbers().n
    import base64

    small_pub = {"kty": "RSA", "n": base64.urlsafe_b64encode(n.to_bytes(128, "big")).rstrip(b"=").decode(), "e": "AQAB"}
    with pytest.raises(AgentHttpSigError):
        public_jwk(small_pub)
    assert verify_signature_value(small_pub, "x", b"\0" * 128) is False
    s = sign_with_profile(_req(), profile="tap", key=KEY, keyid="k", created=NOW)
    out = verify_with_profile(
        _signed(s.headers), profile="tap", expected_authority="merchant.example", now=NOW + 1,
        nonce_store=InMemoryNonceStore(), resolve_key=lambda ref: small_pub,
    )
    assert out.reason == "key_mismatch"


def test_grantex_profile_stays_p256_ed25519() -> None:
    with pytest.raises(AgentHttpSigError, match="P-256 or Ed25519"):
        sign(_req(), key=KEY, agent_passport="p", agent_grant="g")
    ed = private_jwk_from_key(ed25519.Ed25519PrivateKey.generate())
    s = sign(_req(), key=ed, agent_passport="passport-placeholder", agent_grant="grant-placeholder", created=NOW)
    out = verify(
        _signed(s.headers), expected_authority="merchant.example", now=NOW + 1,
        nonce_store=InMemoryNonceStore(), resolve_key=lambda _k: public_jwk(KEY),
    )
    assert out.reason == "key_mismatch"


def test_tap_body_object_ps512() -> None:
    container = build_agentic_payment_container(key=KEY, kid="rsa-key-01", nonce="n-1", payment_credentials_hash="h")
    assert container["alg"] == "PS512"
    out = verify_tap_body_objects(
        {"agenticPaymentContainer": container}, nonce="n-1", keyid="rsa-key-01", resolve_key=lambda _k: public_jwk(KEY)
    )
    assert out.usable_for_payment
