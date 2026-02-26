from __future__ import annotations

import hashlib
import hmac

import httpx
import respx

from grantex import Grantex
from grantex._webhook import verify_webhook_signature

BASE_URL = "http://test.local"

MOCK_WEBHOOK = {
    "id": "wh_01",
    "url": "https://example.com/hooks",
    "events": ["grant.created", "grant.revoked"],
    "createdAt": "2026-02-26T00:00:00Z",
}

MOCK_WEBHOOK_WITH_SECRET = {**MOCK_WEBHOOK, "secret": "abc123secret"}


def _make_sig(payload: str | bytes, secret: str) -> str:
    raw = payload.encode() if isinstance(payload, str) else payload
    mac = hmac.new(secret.encode(), raw, hashlib.sha256)
    return "sha256=" + mac.hexdigest()


@respx.mock
def test_create_webhook() -> None:
    respx.post(f"{BASE_URL}/v1/webhooks").mock(
        return_value=httpx.Response(201, json=MOCK_WEBHOOK_WITH_SECRET)
    )
    client = Grantex(api_key="test-key", base_url=BASE_URL)
    result = client.webhooks.create(url="https://example.com/hooks", events=["grant.created"])

    assert result.id == "wh_01"
    assert result.secret == "abc123secret"
    assert "grant.created" in result.events


@respx.mock
def test_list_webhooks() -> None:
    respx.get(f"{BASE_URL}/v1/webhooks").mock(
        return_value=httpx.Response(200, json={"webhooks": [MOCK_WEBHOOK]})
    )
    client = Grantex(api_key="test-key", base_url=BASE_URL)
    result = client.webhooks.list()

    assert len(result.webhooks) == 1
    assert result.webhooks[0].id == "wh_01"
    assert result.webhooks[0].url == "https://example.com/hooks"


@respx.mock
def test_delete_webhook() -> None:
    respx.delete(f"{BASE_URL}/v1/webhooks/wh_01").mock(
        return_value=httpx.Response(204)
    )
    client = Grantex(api_key="test-key", base_url=BASE_URL)
    assert client.webhooks.delete("wh_01") is None


def test_verify_signature_valid() -> None:
    payload = '{"id":"evt_01","type":"grant.created","data":{}}'
    secret = "my-webhook-secret"
    sig = _make_sig(payload, secret)
    assert verify_webhook_signature(payload, sig, secret) is True


def test_verify_signature_invalid() -> None:
    assert verify_webhook_signature("payload", "sha256=badsig", "secret") is False


def test_verify_signature_wrong_secret() -> None:
    payload = '{"id":"evt_01"}'
    sig = _make_sig(payload, "correct-secret")
    assert verify_webhook_signature(payload, sig, "wrong-secret") is False


def test_verify_signature_bytes_payload() -> None:
    payload = b'{"id":"evt_01","type":"grant.created"}'
    secret = "my-secret"
    sig = _make_sig(payload, secret)
    assert verify_webhook_signature(payload, sig, secret) is True
