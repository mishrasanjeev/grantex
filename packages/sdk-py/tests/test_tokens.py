"""Tests for TokensClient."""
from __future__ import annotations

import pytest
import respx
import httpx

from grantex import Grantex


@pytest.fixture
def client() -> Grantex:
    return Grantex(api_key="test-key")


@respx.mock
def test_verify(client: Grantex) -> None:
    payload = {
        "valid": True,
        "grantId": "grant_01HXYZ",
        "scopes": ["calendar:read"],
        "principal": "user_abc123",
        "agent": "did:grantex:ag_01HXYZ123abc",
        "expiresAt": "2024-01-02T00:00:00Z",
    }
    import json

    route = respx.post("https://api.grantex.dev/v1/tokens/verify").mock(
        return_value=httpx.Response(200, json=payload)
    )
    response = client.tokens.verify("my.jwt.token")

    assert response.valid is True
    assert response.grant_id == "grant_01HXYZ"
    assert response.scopes == ("calendar:read",)
    assert response.principal == "user_abc123"
    assert response.agent == "did:grantex:ag_01HXYZ123abc"

    body = json.loads(route.calls[0].request.content)
    assert body["token"] == "my.jwt.token"


@respx.mock
def test_revoke(client: Grantex) -> None:
    respx.post("https://api.grantex.dev/v1/tokens/revoke").mock(
        return_value=httpx.Response(204)
    )
    response = client.tokens.revoke("tok_01HXYZ")
    assert response is None


@respx.mock
def test_verify_inactive_token(client: Grantex) -> None:
    respx.post("https://api.grantex.dev/v1/tokens/verify").mock(
        return_value=httpx.Response(200, json={"valid": False})
    )
    response = client.tokens.verify("expired.jwt.token")
    assert response.valid is False
    assert response.scopes is None
