"""Tests for PassportsClient."""
from __future__ import annotations

import json

import pytest
import respx
import httpx

from grantex import (
    Grantex,
    IssuePassportParams,
    ListPassportsParams,
    MaxTransactionAmount,
)

MOCK_ISSUED_PASSPORT = {
    "passportId": "urn:grantex:passport:01HXYZ",
    "credential": {
        "@context": [
            "https://www.w3.org/ns/credentials/v2",
            "https://grantex.dev/contexts/mpp/v1",
        ],
        "type": ["VerifiableCredential", "AgentPassportCredential"],
        "id": "urn:grantex:passport:01HXYZ",
    },
    "encodedCredential": "eyJAY29udGV4dCI6WyJodHRwczovL3d3dy53My5vcmcvbnM...",
    "expiresAt": "2026-04-06T00:00:00Z",
}

MOCK_GET_PASSPORT = {
    "status": "active",
    "@context": [
        "https://www.w3.org/ns/credentials/v2",
        "https://grantex.dev/contexts/mpp/v1",
    ],
    "type": ["VerifiableCredential", "AgentPassportCredential"],
    "id": "urn:grantex:passport:01HXYZ",
    "issuer": "did:web:grantex.dev",
}

MOCK_REVOKE_RESPONSE = {
    "revoked": True,
    "revokedAt": "2026-04-05T12:00:00Z",
}


@pytest.fixture
def client() -> Grantex:
    return Grantex(api_key="test-key")


@respx.mock
def test_issue_passport(client: Grantex) -> None:
    route = respx.post("https://api.grantex.dev/v1/passport/issue").mock(
        return_value=httpx.Response(201, json=MOCK_ISSUED_PASSPORT)
    )
    result = client.passports.issue(
        IssuePassportParams(
            agent_id="ag_01",
            grant_id="grant_01",
            allowed_mpp_categories=["inference", "compute"],
            max_transaction_amount=MaxTransactionAmount(amount=100.0, currency="USDC"),
            payment_rails=["tempo"],
            expires_in="24h",
        )
    )

    assert result.passport_id == "urn:grantex:passport:01HXYZ"
    assert result.encoded_credential.startswith("eyJ")
    assert result.expires_at == "2026-04-06T00:00:00Z"
    assert "AgentPassportCredential" in result.credential.get("type", [])

    body = json.loads(route.calls[0].request.content)
    assert body["agentId"] == "ag_01"
    assert body["grantId"] == "grant_01"
    assert body["allowedMPPCategories"] == ["inference", "compute"]
    assert body["maxTransactionAmount"] == {"amount": 100.0, "currency": "USDC"}
    assert body["paymentRails"] == ["tempo"]
    assert body["expiresIn"] == "24h"


@respx.mock
def test_issue_passport_minimal(client: Grantex) -> None:
    route = respx.post("https://api.grantex.dev/v1/passport/issue").mock(
        return_value=httpx.Response(201, json=MOCK_ISSUED_PASSPORT)
    )
    result = client.passports.issue(
        IssuePassportParams(
            agent_id="ag_01",
            grant_id="grant_01",
            allowed_mpp_categories=["general"],
            max_transaction_amount=MaxTransactionAmount(amount=50.0, currency="USD"),
        )
    )

    assert result.passport_id == "urn:grantex:passport:01HXYZ"

    body = json.loads(route.calls[0].request.content)
    assert "paymentRails" not in body
    assert "expiresIn" not in body
    assert "parentPassportId" not in body


@respx.mock
def test_get_passport(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/v1/passport/urn%3Agrantex%3Apassport%3A01HXYZ").mock(
        return_value=httpx.Response(200, json=MOCK_GET_PASSPORT)
    )
    result = client.passports.get("urn:grantex:passport:01HXYZ")

    assert result.status == "active"
    assert result.raw["issuer"] == "did:web:grantex.dev"
    assert "AgentPassportCredential" in result.raw["type"]


@respx.mock
def test_revoke_passport(client: Grantex) -> None:
    route = respx.post(
        "https://api.grantex.dev/v1/passport/urn%3Agrantex%3Apassport%3A01HXYZ/revoke"
    ).mock(return_value=httpx.Response(200, json=MOCK_REVOKE_RESPONSE))

    result = client.passports.revoke("urn:grantex:passport:01HXYZ")

    assert result.revoked is True
    assert result.revoked_at == "2026-04-05T12:00:00Z"


@respx.mock
def test_list_passports_with_params(client: Grantex) -> None:
    mock_list = [
        {
            "passportId": "urn:grantex:passport:01HXYZ",
            "credential": {},
            "encodedCredential": "",
            "expiresAt": "2026-04-06T00:00:00Z",
        },
    ]
    respx.get(url__regex=r"/v1/passports\?.*agentId=ag_01").mock(
        return_value=httpx.Response(200, json=mock_list)
    )

    result = client.passports.list(
        ListPassportsParams(agent_id="ag_01", status="active")
    )

    assert len(result.passports) == 1
    assert result.passports[0].passport_id == "urn:grantex:passport:01HXYZ"


@respx.mock
def test_list_passports_without_params(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/v1/passports").mock(
        return_value=httpx.Response(200, json=[])
    )
    result = client.passports.list()
    assert len(result.passports) == 0


@respx.mock
def test_issue_passport_with_parent(client: Grantex) -> None:
    route = respx.post("https://api.grantex.dev/v1/passport/issue").mock(
        return_value=httpx.Response(201, json=MOCK_ISSUED_PASSPORT)
    )
    client.passports.issue(
        IssuePassportParams(
            agent_id="ag_02",
            grant_id="grant_02",
            allowed_mpp_categories=["inference"],
            max_transaction_amount=MaxTransactionAmount(amount=25.0, currency="USDC"),
            parent_passport_id="urn:grantex:passport:PARENT",
        )
    )

    body = json.loads(route.calls[0].request.content)
    assert body["parentPassportId"] == "urn:grantex:passport:PARENT"
