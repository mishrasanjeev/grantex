"""Tests for Grantex.signup() and Grantex.rotate_key()."""
from __future__ import annotations

import pytest
import respx
import httpx

from grantex import Grantex, SignupParams

MOCK_SIGNUP_RESPONSE = {
    "developerId": "dev_NEW01",
    "apiKey": "gx_live_abc123",
    "name": "Acme Corp",
    "email": None,
    "mode": "live",
    "createdAt": "2026-02-27T00:00:00Z",
}

MOCK_ROTATE_RESPONSE = {
    "apiKey": "gx_live_newkey456",
    "rotatedAt": "2026-02-27T01:00:00Z",
}


@pytest.fixture
def client() -> Grantex:
    return Grantex(api_key="test-key")


@respx.mock
def test_signup_happy_path() -> None:
    route = respx.post("https://api.grantex.dev/v1/signup").mock(
        return_value=httpx.Response(201, json=MOCK_SIGNUP_RESPONSE)
    )
    result = Grantex.signup(SignupParams(name="Acme Corp"))

    assert result.developer_id == "dev_NEW01"
    assert result.api_key == "gx_live_abc123"
    assert result.name == "Acme Corp"
    assert result.mode == "live"


@respx.mock
def test_signup_with_email() -> None:
    payload = {**MOCK_SIGNUP_RESPONSE, "email": "dev@acme.com"}
    respx.post("https://api.grantex.dev/v1/signup").mock(
        return_value=httpx.Response(201, json=payload)
    )
    result = Grantex.signup(SignupParams(name="Acme Corp", email="dev@acme.com"))

    assert result.email == "dev@acme.com"


@respx.mock
def test_signup_custom_base_url() -> None:
    route = respx.post("https://custom.api.dev/v1/signup").mock(
        return_value=httpx.Response(201, json=MOCK_SIGNUP_RESPONSE)
    )
    Grantex.signup(SignupParams(name="Acme Corp"), base_url="https://custom.api.dev")

    assert route.called


@respx.mock
def test_signup_conflict_raises() -> None:
    respx.post("https://api.grantex.dev/v1/signup").mock(
        return_value=httpx.Response(409, json={"message": "A developer with this email already exists"})
    )
    with pytest.raises(ValueError, match="A developer with this email already exists"):
        Grantex.signup(SignupParams(name="Acme Corp", email="taken@acme.com"))


@respx.mock
def test_rotate_key_happy_path(client: Grantex) -> None:
    respx.post("https://api.grantex.dev/v1/keys/rotate").mock(
        return_value=httpx.Response(200, json=MOCK_ROTATE_RESPONSE)
    )
    result = client.rotate_key()

    assert result.api_key == "gx_live_newkey456"
    assert result.rotated_at == "2026-02-27T01:00:00Z"
