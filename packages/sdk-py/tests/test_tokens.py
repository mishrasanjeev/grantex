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
def test_exchange(client: Grantex) -> None:
    payload = {
        "grantToken": "eyJ...",
        "expiresAt": "2026-03-01T00:00:00Z",
        "scopes": ["calendar:read"],
        "refreshToken": "rt_abc",
        "grantId": "grnt_01HXYZ",
    }
    import json

    route = respx.post("https://api.grantex.dev/v1/token").mock(
        return_value=httpx.Response(200, json=payload)
    )

    from grantex import ExchangeTokenParams

    response = client.tokens.exchange(
        ExchangeTokenParams(code="auth_code_123", agent_id="ag_01")
    )

    assert response.grant_token == "eyJ..."
    assert response.grant_id == "grnt_01HXYZ"
    assert response.scopes == ("calendar:read",)
    assert response.refresh_token == "rt_abc"

    body = json.loads(route.calls[0].request.content)
    assert body["code"] == "auth_code_123"
    assert body["agentId"] == "ag_01"


@respx.mock
def test_refresh(client: Grantex) -> None:
    payload = {
        "grantToken": "eyJ.new...",
        "expiresAt": "2026-03-01T00:00:00Z",
        "scopes": ["calendar:read"],
        "refreshToken": "rt_new",
        "grantId": "grnt_01HXYZ",
    }
    import json

    route = respx.post("https://api.grantex.dev/v1/token/refresh").mock(
        return_value=httpx.Response(200, json=payload)
    )

    from grantex import RefreshTokenParams

    response = client.tokens.refresh(
        RefreshTokenParams(refresh_token="rt_old", agent_id="ag_01")
    )

    assert response.grant_token == "eyJ.new..."
    assert response.grant_id == "grnt_01HXYZ"
    assert response.refresh_token == "rt_new"

    body = json.loads(route.calls[0].request.content)
    assert body["refreshToken"] == "rt_old"
    assert body["agentId"] == "ag_01"


@respx.mock
def test_verify_inactive_token(client: Grantex) -> None:
    respx.post("https://api.grantex.dev/v1/tokens/verify").mock(
        return_value=httpx.Response(200, json={"valid": False})
    )
    response = client.tokens.verify("expired.jwt.token")
    assert response.valid is False
    assert response.scopes is None
