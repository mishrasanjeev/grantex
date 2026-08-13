from __future__ import annotations

import hashlib
import hmac
import time

import httpx
import pytest
import respx

from grantex import Grantex
from grantex._webhook import verify_webhook, verify_webhook_signature

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


# ── Timestamped verification (replay-bounded) ──────────────────────────────

_TS_SECRET = "whsec_test"
_TS_PAYLOAD = '{"id":"evt_1","type":"grant.created"}'


def _sign(timestamp: str, payload: str, secret: str = _TS_SECRET) -> str:
    signed = timestamp.encode() + b"." + payload.encode()
    return "sha256=" + hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()


def _now() -> int:
    return int(time.time())


def test_verify_webhook_accepts_fresh_delivery():
    ts = str(_now())
    assert verify_webhook(_TS_PAYLOAD, _sign(ts, _TS_PAYLOAD), ts, _TS_SECRET) is True


def test_verify_webhook_accepts_bytes_body():
    ts = str(_now())
    assert verify_webhook(
        _TS_PAYLOAD.encode(), _sign(ts, _TS_PAYLOAD), ts, _TS_SECRET
    ) is True


def test_verify_webhook_rejects_replay_after_window():
    # The whole point: a delivery captured today must not verify tomorrow.
    ts = str(_now() - 301)
    assert verify_webhook(_TS_PAYLOAD, _sign(ts, _TS_PAYLOAD), ts, _TS_SECRET) is False


def test_verify_webhook_accepts_inside_window():
    ts = str(_now() - 299)
    assert verify_webhook(_TS_PAYLOAD, _sign(ts, _TS_PAYLOAD), ts, _TS_SECRET) is True


def test_verify_webhook_honours_custom_tolerance():
    ts = str(_now() - 60)
    sig = _sign(ts, _TS_PAYLOAD)
    assert verify_webhook(_TS_PAYLOAD, sig, ts, _TS_SECRET, tolerance_seconds=30) is False
    assert verify_webhook(_TS_PAYLOAD, sig, ts, _TS_SECRET, tolerance_seconds=120) is True


def test_verify_webhook_rejects_future_dated_delivery():
    ts = str(_now() + 3600)
    assert verify_webhook(_TS_PAYLOAD, _sign(ts, _TS_PAYLOAD), ts, _TS_SECRET) is False


def test_verify_webhook_rejects_rewritten_timestamp():
    # The signature covers the timestamp, so refreshing the header alone fails.
    signed_at = str(_now() - 3600)
    sig = _sign(signed_at, _TS_PAYLOAD)
    assert verify_webhook(_TS_PAYLOAD, sig, str(_now()), _TS_SECRET) is False


def test_verify_webhook_rejects_tampered_body():
    ts = str(_now())
    sig = _sign(ts, _TS_PAYLOAD)
    assert verify_webhook('{"id":"evt_1","type":"grant.deleted"}', sig, ts, _TS_SECRET) is False


def test_verify_webhook_rejects_wrong_secret():
    ts = str(_now())
    sig = _sign(ts, _TS_PAYLOAD, "whsec_other")
    assert verify_webhook(_TS_PAYLOAD, sig, ts, _TS_SECRET) is False


def test_verify_webhook_rejects_legacy_payload_only_signature():
    ts = str(_now())
    legacy = "sha256=" + hmac.new(
        _TS_SECRET.encode(), _TS_PAYLOAD.encode(), hashlib.sha256
    ).hexdigest()
    assert verify_webhook(_TS_PAYLOAD, legacy, ts, _TS_SECRET) is False


@pytest.mark.parametrize("timestamp", ["", "not-a-time", "-100", "9" * 40])
def test_verify_webhook_rejects_bad_timestamps(timestamp):
    assert verify_webhook(
        _TS_PAYLOAD, _sign(timestamp, _TS_PAYLOAD), timestamp, _TS_SECRET
    ) is False


@pytest.mark.parametrize("signature", ["", "garbage", "sha256=", "sha256=zz"])
def test_verify_webhook_rejects_bad_signatures(signature):
    ts = str(_now())
    assert verify_webhook(_TS_PAYLOAD, signature, ts, _TS_SECRET) is False
