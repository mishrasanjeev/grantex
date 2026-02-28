"""Tests for the Grantex main client."""
from __future__ import annotations

import os

import pytest
import respx
import httpx

from grantex import (
    Grantex,
    AuthorizeParams,
    GrantexApiError,
    GrantexAuthError,
    GrantexNetworkError,
)
from tests.conftest import MOCK_AUTHORIZATION_REQUEST


def test_no_api_key_raises_value_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GRANTEX_API_KEY", raising=False)
    with pytest.raises(ValueError, match="API key"):
        Grantex()


def test_env_var_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GRANTEX_API_KEY", "test-key-from-env")
    client = Grantex()
    assert client is not None


def test_explicit_api_key() -> None:
    client = Grantex(api_key="explicit-key")
    assert client is not None


def test_resource_clients_present() -> None:
    client = Grantex(api_key="test-key")
    assert client.agents is not None
    assert client.grants is not None
    assert client.tokens is not None
    assert client.audit is not None


@respx.mock
def test_authorize_maps_user_id_to_principal_id() -> None:
    route = respx.post("https://api.grantex.dev/v1/authorize").mock(
        return_value=httpx.Response(200, json=MOCK_AUTHORIZATION_REQUEST)
    )
    client = Grantex(api_key="test-key")
    params = AuthorizeParams(
        agent_id="ag_01HXYZ123abc",
        user_id="user_abc123",
        scopes=["calendar:read"],
        expires_in="24h",
    )
    result = client.authorize(params)

    assert result.principal_id == "user_abc123"
    assert result.request_id == "req_01HXYZ"

    sent_body = route.calls[0].request
    import json
    body = json.loads(sent_body.content)
    assert body["principalId"] == "user_abc123"
    assert "userId" not in body


@respx.mock
def test_bearer_header_sent() -> None:
    respx.post("https://api.grantex.dev/v1/authorize").mock(
        return_value=httpx.Response(200, json=MOCK_AUTHORIZATION_REQUEST)
    )
    client = Grantex(api_key="my-secret-key")
    client.authorize(
        AuthorizeParams(
            agent_id="ag_01",
            user_id="u_01",
            scopes=["calendar:read"],
        )
    )
    request = respx.calls[0].request
    assert request.headers["authorization"] == "Bearer my-secret-key"


@respx.mock
def test_user_agent_header_sent() -> None:
    respx.post("https://api.grantex.dev/v1/authorize").mock(
        return_value=httpx.Response(200, json=MOCK_AUTHORIZATION_REQUEST)
    )
    client = Grantex(api_key="test-key")
    client.authorize(
        AuthorizeParams(agent_id="ag_01", user_id="u_01", scopes=[])
    )
    request = respx.calls[0].request
    assert "grantex-python" in request.headers["user-agent"]


@respx.mock
def test_401_raises_auth_error() -> None:
    respx.post("https://api.grantex.dev/v1/authorize").mock(
        return_value=httpx.Response(
            401, json={"message": "Unauthorized"}
        )
    )
    client = Grantex(api_key="bad-key")
    with pytest.raises(GrantexAuthError) as exc_info:
        client.authorize(
            AuthorizeParams(agent_id="ag_01", user_id="u_01", scopes=[])
        )
    assert exc_info.value.status_code == 401


@respx.mock
def test_403_raises_auth_error() -> None:
    respx.post("https://api.grantex.dev/v1/authorize").mock(
        return_value=httpx.Response(403, json={"error": "Forbidden"})
    )
    client = Grantex(api_key="test-key")
    with pytest.raises(GrantexAuthError) as exc_info:
        client.authorize(
            AuthorizeParams(agent_id="ag_01", user_id="u_01", scopes=[])
        )
    assert exc_info.value.status_code == 403


@respx.mock
def test_network_error_raises_grantex_network_error() -> None:
    respx.post("https://api.grantex.dev/v1/authorize").mock(
        side_effect=httpx.ConnectError("connection refused")
    )
    client = Grantex(api_key="test-key")
    with pytest.raises(GrantexNetworkError):
        client.authorize(
            AuthorizeParams(agent_id="ag_01", user_id="u_01", scopes=[])
        )


@respx.mock
def test_timeout_raises_network_error() -> None:
    respx.post("https://api.grantex.dev/v1/authorize").mock(
        side_effect=httpx.TimeoutException("timed out")
    )
    client = Grantex(api_key="test-key")
    with pytest.raises(GrantexNetworkError):
        client.authorize(
            AuthorizeParams(agent_id="ag_01", user_id="u_01", scopes=[])
        )


@respx.mock
def test_error_code_exposed() -> None:
    respx.post("https://api.grantex.dev/v1/authorize").mock(
        return_value=httpx.Response(
            400, json={"message": "Invalid code", "code": "BAD_REQUEST", "requestId": "req_1"}
        )
    )
    client = Grantex(api_key="test-key")
    with pytest.raises(GrantexApiError) as exc_info:
        client.authorize(
            AuthorizeParams(agent_id="ag_01", user_id="u_01", scopes=[])
        )
    assert exc_info.value.code == "BAD_REQUEST"
    assert exc_info.value.status_code == 400
