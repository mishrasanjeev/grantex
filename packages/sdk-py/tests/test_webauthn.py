"""Tests for WebAuthnClient."""
from __future__ import annotations

import json

import pytest
import respx
import httpx

from grantex import Grantex

MOCK_REGISTRATION_OPTIONS = {
    "challengeId": "ch_01",
    "publicKey": {
        "rp": {"name": "Grantex", "id": "grantex.dev"},
        "challenge": "dGVzdC1jaGFsbGVuZ2U",
        "pubKeyCredParams": [{"type": "public-key", "alg": -7}],
    },
}

MOCK_CREDENTIAL = {
    "id": "cred_01",
    "principalId": "user_abc123",
    "deviceName": "YubiKey 5",
    "backedUp": False,
    "transports": ["usb"],
    "createdAt": "2026-03-01T00:00:00Z",
    "lastUsedAt": None,
}


@pytest.fixture
def client() -> Grantex:
    return Grantex(api_key="test-key")


@respx.mock
def test_register_options(client: Grantex) -> None:
    route = respx.post("https://api.grantex.dev/v1/webauthn/register/options").mock(
        return_value=httpx.Response(200, json=MOCK_REGISTRATION_OPTIONS)
    )
    result = client.webauthn.register_options(principal_id="user_abc123")

    assert result.challenge_id == "ch_01"
    assert "rp" in result.public_key

    body = json.loads(route.calls[0].request.content)
    assert body["principalId"] == "user_abc123"


@respx.mock
def test_register_verify(client: Grantex) -> None:
    route = respx.post("https://api.grantex.dev/v1/webauthn/register/verify").mock(
        return_value=httpx.Response(200, json=MOCK_CREDENTIAL)
    )
    from grantex import WebAuthnRegistrationVerifyParams

    result = client.webauthn.register_verify(
        WebAuthnRegistrationVerifyParams(
            challenge_id="ch_01",
            response={"id": "rawId", "rawId": "rawId", "type": "public-key"},
            device_name="YubiKey 5",
        )
    )

    assert result.id == "cred_01"
    assert result.principal_id == "user_abc123"
    assert result.device_name == "YubiKey 5"

    body = json.loads(route.calls[0].request.content)
    assert body["challengeId"] == "ch_01"
    assert body["deviceName"] == "YubiKey 5"


@respx.mock
def test_list_credentials(client: Grantex) -> None:
    respx.get(
        "https://api.grantex.dev/v1/webauthn/credentials?principalId=user_abc123"
    ).mock(return_value=httpx.Response(200, json={"credentials": [MOCK_CREDENTIAL]}))

    result = client.webauthn.list_credentials("user_abc123")

    assert len(result.credentials) == 1
    assert result.credentials[0].device_name == "YubiKey 5"


@respx.mock
def test_delete_credential(client: Grantex) -> None:
    respx.delete("https://api.grantex.dev/v1/webauthn/credentials/cred_01").mock(
        return_value=httpx.Response(204)
    )
    result = client.webauthn.delete_credential("cred_01")
    assert result is None
