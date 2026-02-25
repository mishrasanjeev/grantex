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
def test_introspect(client: Grantex) -> None:
    payload = {
        "active": True,
        "tokenId": "tok_01HXYZ",
        "grantId": "grant_01HXYZ",
        "principalId": "user_abc123",
        "agentDid": "did:grantex:ag_01HXYZ123abc",
        "developerId": "org_test",
        "scopes": ["calendar:read"],
        "issuedAt": 1709000000,
        "expiresAt": 9999999999,
    }
    import json

    route = respx.post("https://api.grantex.dev/v1/tokens/introspect").mock(
        return_value=httpx.Response(200, json=payload)
    )
    response = client.tokens.introspect("my.jwt.token")

    assert response.active is True
    assert response.token_id == "tok_01HXYZ"
    assert response.grant_id == "grant_01HXYZ"
    assert response.scopes == ("calendar:read",)

    body = json.loads(route.calls[0].request.content)
    assert body["token"] == "my.jwt.token"


@respx.mock
def test_revoke(client: Grantex) -> None:
    respx.delete("https://api.grantex.dev/v1/tokens/tok_01HXYZ").mock(
        return_value=httpx.Response(200, json={"revoked": True, "tokenId": "tok_01HXYZ"})
    )
    response = client.tokens.revoke("tok_01HXYZ")
    assert response.revoked is True
    assert response.token_id == "tok_01HXYZ"


@respx.mock
def test_introspect_inactive_token(client: Grantex) -> None:
    respx.post("https://api.grantex.dev/v1/tokens/introspect").mock(
        return_value=httpx.Response(200, json={"active": False})
    )
    response = client.tokens.introspect("expired.jwt.token")
    assert response.active is False
    assert response.token_id is None
    assert response.scopes is None
