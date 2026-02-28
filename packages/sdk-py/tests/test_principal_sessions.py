"""Tests for PrincipalSessionsClient."""
from __future__ import annotations

import json

import pytest
import respx
import httpx

from grantex import Grantex, CreatePrincipalSessionParams


@pytest.fixture
def client() -> Grantex:
    return Grantex(api_key="test-key")


@respx.mock
def test_create_principal_session(client: Grantex) -> None:
    payload = {
        "sessionToken": "eyJ...",
        "dashboardUrl": "https://api.grantex.dev/permissions?session=eyJ...",
        "expiresAt": "2026-03-01T00:00:00Z",
    }
    route = respx.post("https://api.grantex.dev/v1/principal-sessions").mock(
        return_value=httpx.Response(201, json=payload)
    )

    response = client.principal_sessions.create(
        CreatePrincipalSessionParams(principal_id="user_123", expires_in="2h")
    )

    assert response.session_token == "eyJ..."
    assert response.dashboard_url.endswith("/permissions?session=eyJ...")
    assert response.expires_at == "2026-03-01T00:00:00Z"

    body = json.loads(route.calls[0].request.content)
    assert body["principalId"] == "user_123"
    assert body["expiresIn"] == "2h"


@respx.mock
def test_create_principal_session_minimal(client: Grantex) -> None:
    payload = {
        "sessionToken": "tok",
        "dashboardUrl": "url",
        "expiresAt": "2026-03-01T00:00:00Z",
    }
    route = respx.post("https://api.grantex.dev/v1/principal-sessions").mock(
        return_value=httpx.Response(201, json=payload)
    )

    response = client.principal_sessions.create(
        CreatePrincipalSessionParams(principal_id="user_456")
    )

    assert response.session_token == "tok"

    body = json.loads(route.calls[0].request.content)
    assert body["principalId"] == "user_456"
    assert "expiresIn" not in body
