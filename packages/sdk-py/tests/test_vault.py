"""Tests for the VaultClient resource."""
from __future__ import annotations

import json

import httpx
import respx

from grantex import (
    Grantex,
    StoreCredentialParams,
    ExchangeCredentialParams,
    ListVaultCredentialsParams,
)

BASE_URL = "https://api.grantex.dev"

MOCK_CREDENTIAL = {
    "id": "vault_01",
    "principalId": "user_123",
    "service": "google",
    "credentialType": "oauth2",
    "tokenExpiresAt": "2026-04-01T00:00:00Z",
    "metadata": {"email": "test@example.com"},
    "createdAt": "2026-03-01T00:00:00Z",
    "updatedAt": "2026-03-01T00:00:00Z",
}


@respx.mock
def test_store_credential() -> None:
    respx.post(f"{BASE_URL}/v1/vault/credentials").mock(
        return_value=httpx.Response(201, json={
            "id": "vault_01",
            "principalId": "user_123",
            "service": "google",
            "credentialType": "oauth2",
            "createdAt": "2026-03-01T00:00:00Z",
        })
    )

    client = Grantex(api_key="test_key", base_url=BASE_URL)
    result = client.vault.store(StoreCredentialParams(
        principal_id="user_123",
        service="google",
        access_token="ya29.access_token",
        refresh_token="rt_refresh",
    ))

    assert result.id == "vault_01"
    assert result.service == "google"
    assert result.credential_type == "oauth2"

    request = respx.calls.last.request
    body = json.loads(request.content)
    assert body["principalId"] == "user_123"
    assert body["accessToken"] == "ya29.access_token"


@respx.mock
def test_list_credentials_with_filters() -> None:
    respx.get(f"{BASE_URL}/v1/vault/credentials?principalId=user_123&service=google").mock(
        return_value=httpx.Response(200, json={"credentials": [MOCK_CREDENTIAL]})
    )

    client = Grantex(api_key="test_key", base_url=BASE_URL)
    result = client.vault.list(ListVaultCredentialsParams(
        principal_id="user_123",
        service="google",
    ))

    assert len(result.credentials) == 1
    assert result.credentials[0].service == "google"


@respx.mock
def test_get_credential() -> None:
    respx.get(f"{BASE_URL}/v1/vault/credentials/vault_01").mock(
        return_value=httpx.Response(200, json=MOCK_CREDENTIAL)
    )

    client = Grantex(api_key="test_key", base_url=BASE_URL)
    result = client.vault.get("vault_01")

    assert result.id == "vault_01"
    assert result.principal_id == "user_123"


@respx.mock
def test_delete_credential() -> None:
    respx.delete(f"{BASE_URL}/v1/vault/credentials/vault_01").mock(
        return_value=httpx.Response(204)
    )

    client = Grantex(api_key="test_key", base_url=BASE_URL)
    client.vault.delete("vault_01")


@respx.mock
def test_exchange_credential() -> None:
    respx.post(f"{BASE_URL}/v1/vault/credentials/exchange").mock(
        return_value=httpx.Response(200, json={
            "accessToken": "ya29.real_token",
            "service": "google",
            "credentialType": "oauth2",
            "tokenExpiresAt": "2026-04-01T00:00:00Z",
            "metadata": {},
        })
    )

    client = Grantex(api_key="test_key", base_url=BASE_URL)
    result = client.vault.exchange(
        "grant.jwt.token",
        ExchangeCredentialParams(service="google"),
    )

    assert result.access_token == "ya29.real_token"
    assert result.service == "google"

    request = respx.calls.last.request
    assert request.headers["authorization"] == "Bearer grant.jwt.token"
    body = json.loads(request.content)
    assert body["service"] == "google"


@respx.mock
def test_list_credentials_without_filters() -> None:
    respx.get(f"{BASE_URL}/v1/vault/credentials").mock(
        return_value=httpx.Response(200, json={"credentials": []})
    )

    client = Grantex(api_key="test_key", base_url=BASE_URL)
    result = client.vault.list()

    assert len(result.credentials) == 0
