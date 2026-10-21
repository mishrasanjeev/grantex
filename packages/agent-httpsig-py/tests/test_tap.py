# SPDX-License-Identifier: Apache-2.0
"""TAP body objects bound to a TAP message signature, and the consent record (G49).

Mirrors packages/agent-httpsig/tests/tap.test.ts.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Dict

import pytest
from cryptography.hazmat.primitives.asymmetric import ec, ed25519

from grantex_agent_httpsig import (
    DEFAULT_TAP_BODY_MEMBERS,
    AgentHttpSigError,
    HttpRequest,
    InMemoryNonceStore,
    build_agentic_consumer,
    build_agentic_payment_container,
    build_grantex_consent_record,
    canonical_json,
    private_jwk_from_key,
    public_jwk,
    sign_with_profile,
    verify_tap_body_objects,
    verify_with_profile,
    with_tap_body_objects,
)

NOW = 1_790_000_000
ID_TOKEN = "eyJhbGciOiJQUzI1NiJ9.eyJzdWIiOiJzaG9wcGVyLTAxIn0.c2lnbmF0dXJlLXBsYWNlaG9sZGVy"
KEYS = {
    "ed25519": private_jwk_from_key(ed25519.Ed25519PrivateKey.generate()),
    "p256": private_jwk_from_key(ec.generate_private_key(ec.SECP256R1())),
}
CONSENT: Dict[str, Any] = {
    "id": "ccr_01J9EXAMPLE",
    "merchantId": "mer_example",
    "agentId": "shopper-01",
    "passportType": "checkout",
    "status": "granted",
    "approvedScopes": ["commerce:checkout"],
    "maxAmount": 250000,
    "currency": "INR",
    "consentTextVersion": "2026-05-01",
    "presentedPayloadHash": "sha-256:placeholder",
    "approvedAt": "2026-10-20T10:00:00.000Z",
    "expiresAt": "2026-10-20T10:10:00.000Z",
    "userPrincipalId": "user-secret",
}
AT = datetime(2026, 10, 20, 10, 5, tzinfo=timezone.utc)


def test_canonical_json_sorts_by_utf16_code_units() -> None:
    names = ["€", "\r", "דּ", "1", "\U0001f600", "\u0080", "ö"]
    text = canonical_json({n: i for i, n in enumerate(names)})
    expected = ["\r", "1", "\u0080", "ö", "€", "\U0001f600", "דּ"]
    positions = [text.index(json.dumps(k, ensure_ascii=False) + ":") for k in expected]
    assert positions == sorted(positions)
    assert canonical_json({"b": [True, None, "x"], "a": 1}) == '{"a":1,"b":[true,null,"x"]}'
    with pytest.raises(AgentHttpSigError):
        canonical_json({"amount": 1.5})


@pytest.mark.parametrize("name", sorted(KEYS))
def test_body_objects_bound_to_the_message_signature(name: str) -> None:
    key = KEYS[name]
    nonce = "b1c3e5f7-0000-4000-8000-000000000001"
    consumer = build_agentic_consumer(
        key=key, kid="primary-key-01", nonce=nonce, id_token=ID_TOKEN,
        contextual_data={"countryCode": "IN", "zip": "560001"},
    )
    container = build_agentic_payment_container(
        key=key, kid="primary-key-01", nonce=nonce, payment_credentials_hash="hash-placeholder"
    )
    record = build_grantex_consent_record(CONSENT, nonce=nonce, now=AT)
    body = json.dumps(
        with_tap_body_objects(
            {"cart_id": "c-1001"}, consumer=consumer, payment_container=container, consent_record=record
        )
    )
    headers = {"content-type": "application/json"}
    req = HttpRequest("POST", "https://merchant.example/v1/checkout", headers, body)
    signed = sign_with_profile(
        req, profile="tap", key=key, keyid="primary-key-01", nonce=nonce, created=NOW,
        components=["@method", "@authority", "@path", "content-digest"],
    )
    pub = public_jwk(key)
    verified = verify_with_profile(
        HttpRequest(req.method, req.url, {**headers, **signed.headers}, body),
        profile="tap", expected_authority="merchant.example", now=NOW + 1,
        nonce_store=InMemoryNonceStore(), resolve_key=lambda ref: pub,
        required_components=["content-digest"],
    )
    assert verified.ok and verified.nonce == nonce
    out = verify_tap_body_objects(
        json.loads(body), nonce=nonce, keyid="primary-key-01",
        resolve_key=lambda kid: pub if kid == "primary-key-01" else None,
    )
    assert out.consumer.verified and out.payment_container.verified and out.usable_for_payment
    assert out.consent_record_nonce_matches and out.consent_id == "ccr_01J9EXAMPLE"
    assert consumer["alg"] == ("ES256" if name == "p256" else "EdDSA")


def test_body_object_failures() -> None:
    key = KEYS["ed25519"]
    pub = public_jwk(key)
    resolve = lambda kid: pub if kid == "k1" else None  # noqa: E731
    consumer = build_agentic_consumer(key=key, kid="k1", nonce="n-1", id_token=ID_TOKEN)
    container = build_agentic_payment_container(key=key, kid="k1", nonce="n-1", credential_hash="h")

    out = verify_tap_body_objects(
        {"agenticConsumer": consumer, "agenticPaymentContainer": container},
        nonce="n-2", keyid="k1", resolve_key=resolve,
    )
    assert out.consumer.problems == ["nonce_mismatch"] and not out.usable_for_payment

    tampered = dict(container, credentialHash="other")
    out = verify_tap_body_objects({"agenticPaymentContainer": tampered}, nonce="n-1", keyid="k1", resolve_key=resolve)
    assert out.payment_container.problems == ["signature_invalid"] and not out.consumer.present

    unsigned = {k: v for k, v in container.items() if k != "signature"}
    out = verify_tap_body_objects({"agenticPaymentContainer": unsigned}, nonce="n-1", keyid="k1", resolve_key=resolve)
    assert out.payment_container.problems == ["missing_fields"]
    out = verify_tap_body_objects({"agenticPaymentContainer": container}, nonce="n-1", keyid="k1", resolve_key=lambda _k: None)
    assert out.payment_container.problems == ["key_unavailable"]
    out = verify_tap_body_objects({"agenticConsumer": dict(consumer, alg="PS256")}, nonce="n-1", keyid="k1", resolve_key=resolve)
    assert out.consumer.problems == ["algorithm_unsupported"]

    # Configurable canonicalization and placement (UNCONFIRMED in the specification).
    canon = lambda o: json.dumps(o).encode()  # noqa: E731
    custom = build_agentic_payment_container(key=key, kid="k1", nonce="n-1", canonicalize=canon)
    members = dict(DEFAULT_TAP_BODY_MEMBERS, payment_container="payment_container")
    body = with_tap_body_objects({}, payment_container=custom, members=members)
    assert list(body) == ["payment_container"]
    assert verify_tap_body_objects(body, nonce="n-1", keyid="k1", resolve_key=resolve, members=members, canonicalize=canon).usable_for_payment
    assert not verify_tap_body_objects(body, nonce="n-1", keyid="k1", resolve_key=resolve, members=members).usable_for_payment

    with pytest.raises(AgentHttpSigError):
        build_agentic_consumer(key=key, kid="k1", nonce="n-1", id_token="not-a-jwt")
    with pytest.raises(AgentHttpSigError, match="alpha-2"):
        build_agentic_consumer(key=key, kid="k1", nonce="n-1", id_token=ID_TOKEN, contextual_data={"countryCode": "india"})


def test_consent_record_object() -> None:
    record = build_grantex_consent_record(CONSENT, nonce="n-1", now=AT)
    assert record == {
        "type": "grantex-consent-record",
        "consent_id": "ccr_01J9EXAMPLE",
        "merchant_id": "mer_example",
        "agent_id": "shopper-01",
        "passport_type": "checkout",
        "scopes": ["commerce:checkout"],
        "max_amount": 250000,
        "currency": "INR",
        "consent_text_version": "2026-05-01",
        "presented_payload_hash": "sha-256:placeholder",
        "approved_at": "2026-10-20T10:00:00.000Z",
        "expires_at": "2026-10-20T10:10:00.000Z",
        "nonce": "n-1",
    }
    assert "user-secret" not in json.dumps(record)
    with pytest.raises(AgentHttpSigError, match="granted"):
        build_grantex_consent_record(dict(CONSENT, status="requested"), nonce="n-1", now=AT)
    with pytest.raises(AgentHttpSigError, match="scopes"):
        build_grantex_consent_record(dict(CONSENT, approvedScopes=[]), nonce="n-1", now=AT)
    with pytest.raises(AgentHttpSigError, match="expired"):
        build_grantex_consent_record(CONSENT, nonce="n-1", now=datetime(2026, 10, 20, 10, 10, tzinfo=timezone.utc))
