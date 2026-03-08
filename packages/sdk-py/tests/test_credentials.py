"""Tests for CredentialsClient."""
from __future__ import annotations

import json

import pytest
import respx
import httpx

from grantex import Grantex, ListCredentialsParams, SDJWTPresentParams

MOCK_VC_RECORD = {
    "id": "vc_01",
    "grantId": "grant_01",
    "credentialType": "GrantCredential",
    "format": "vc+sd-jwt",
    "credential": "eyJ0eXAiOiJ2YytzZC1qd3QiLCJhbGciOiJFUzI1NiJ9...",
    "status": "active",
    "issuedAt": "2026-03-01T00:00:00Z",
    "expiresAt": "2026-03-02T00:00:00Z",
}

MOCK_VERIFY_RESULT = {
    "valid": True,
    "credentialType": "GrantCredential",
    "issuer": "did:web:grantex.dev",
    "subject": {"principalId": "user_abc123", "agentDid": "did:grantex:ag_01"},
    "expiresAt": "2026-03-02T00:00:00Z",
    "revoked": False,
}


@pytest.fixture
def client() -> Grantex:
    return Grantex(api_key="test-key")


@respx.mock
def test_get_credential(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/v1/credentials/vc_01").mock(
        return_value=httpx.Response(200, json=MOCK_VC_RECORD)
    )
    result = client.credentials.get("vc_01")

    assert result.id == "vc_01"
    assert result.credential_type == "GrantCredential"
    assert result.format == "vc+sd-jwt"


@respx.mock
def test_list_with_params(client: Grantex) -> None:
    respx.get(
        url__regex=r"/v1/credentials\?.*grantId=grant_01"
    ).mock(return_value=httpx.Response(200, json={"credentials": [MOCK_VC_RECORD]}))

    result = client.credentials.list(
        ListCredentialsParams(grant_id="grant_01", status="active")
    )

    assert len(result.credentials) == 1
    assert result.credentials[0].grant_id == "grant_01"


@respx.mock
def test_list_without_params(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/v1/credentials").mock(
        return_value=httpx.Response(200, json={"credentials": []})
    )
    result = client.credentials.list()
    assert len(result.credentials) == 0


@respx.mock
def test_verify_credential(client: Grantex) -> None:
    route = respx.post("https://api.grantex.dev/v1/credentials/verify").mock(
        return_value=httpx.Response(200, json=MOCK_VERIFY_RESULT)
    )
    result = client.credentials.verify("eyJ...")

    assert result.valid is True
    assert result.credential_type == "GrantCredential"
    assert result.issuer == "did:web:grantex.dev"
    assert result.revoked is False

    body = json.loads(route.calls[0].request.content)
    assert body == {"credential": "eyJ..."}


@respx.mock
def test_present_sd_jwt(client: Grantex) -> None:
    mock_result = {
        "valid": True,
        "disclosedClaims": {
            "principalId": "user_abc123",
            "scopes": ["read"],
        },
    }
    route = respx.post("https://api.grantex.dev/v1/credentials/present").mock(
        return_value=httpx.Response(200, json=mock_result)
    )
    result = client.credentials.present(
        SDJWTPresentParams(sd_jwt="eyJ...~disc1~disc2~", nonce="abc123")
    )

    assert result.valid is True
    assert result.disclosed_claims is not None
    assert result.disclosed_claims["principalId"] == "user_abc123"

    body = json.loads(route.calls[0].request.content)
    assert body["sdJwt"] == "eyJ...~disc1~disc2~"
    assert body["nonce"] == "abc123"


@respx.mock
def test_present_sd_jwt_invalid(client: Grantex) -> None:
    mock_result = {
        "valid": False,
        "error": "Invalid SD-JWT signature",
    }
    respx.post("https://api.grantex.dev/v1/credentials/present").mock(
        return_value=httpx.Response(200, json=mock_result)
    )
    result = client.credentials.present(SDJWTPresentParams(sd_jwt="invalid~"))

    assert result.valid is False
    assert result.error == "Invalid SD-JWT signature"
