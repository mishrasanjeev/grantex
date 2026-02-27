"""Tests for SsoClient."""
from __future__ import annotations

import pytest
import respx
import httpx

from grantex import Grantex
from grantex._types import CreateSsoConfigParams

MOCK_SSO_CONFIG = {
    "issuerUrl": "https://idp.example.com",
    "clientId": "client_abc",
    "redirectUri": "https://app.grantex.dev/sso/callback",
    "createdAt": "2026-02-27T00:00:00Z",
    "updatedAt": "2026-02-27T00:00:00Z",
}


@pytest.fixture
def client() -> Grantex:
    return Grantex(api_key="test-key")


@respx.mock
def test_create_config(client: Grantex) -> None:
    route = respx.post("https://api.grantex.dev/v1/sso/config").mock(
        return_value=httpx.Response(201, json=MOCK_SSO_CONFIG)
    )
    params = CreateSsoConfigParams(
        issuer_url="https://idp.example.com",
        client_id="client_abc",
        client_secret="secret_xyz",
        redirect_uri="https://app.grantex.dev/sso/callback",
    )
    result = client.sso.create_config(params)

    assert result.issuer_url == "https://idp.example.com"
    assert result.client_id == "client_abc"
    assert result.redirect_uri == "https://app.grantex.dev/sso/callback"
    body = route.calls[0].request.read()
    assert b"client_abc" in body


@respx.mock
def test_get_config(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/v1/sso/config").mock(
        return_value=httpx.Response(200, json=MOCK_SSO_CONFIG)
    )
    result = client.sso.get_config()

    assert result.issuer_url == "https://idp.example.com"
    assert result.created_at == "2026-02-27T00:00:00Z"


@respx.mock
def test_delete_config(client: Grantex) -> None:
    route = respx.delete("https://api.grantex.dev/v1/sso/config").mock(
        return_value=httpx.Response(204)
    )
    client.sso.delete_config()

    assert route.called


@respx.mock
def test_get_login_url(client: Grantex) -> None:
    route = respx.get("https://api.grantex.dev/sso/login").mock(
        return_value=httpx.Response(
            200,
            json={"authorizeUrl": "https://idp.example.com/authorize?client_id=abc"},
        )
    )
    result = client.sso.get_login_url("dev_TEST")

    assert "https://idp.example.com/authorize" in result.authorize_url
    url = str(route.calls[0].request.url)
    assert "org=dev_TEST" in url


@respx.mock
def test_handle_callback(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/sso/callback").mock(
        return_value=httpx.Response(
            200,
            json={
                "email": "alice@corp.com",
                "name": "Alice Smith",
                "sub": "idp_user_01",
                "developerId": "dev_TEST",
            },
        )
    )
    result = client.sso.handle_callback("auth_code_xyz", "state_abc")

    assert result.email == "alice@corp.com"
    assert result.name == "Alice Smith"
    assert result.developer_id == "dev_TEST"
