"""Tests for DomainsClient."""
from __future__ import annotations

import pytest
import respx
import httpx

from grantex import Grantex


MOCK_DOMAIN_CREATE = {
    "id": "dom_01",
    "domain": "example.com",
    "verified": False,
    "verificationToken": "gx-verify-abc123",
    "instructions": "Add a TXT record with value gx-verify-abc123 to _grantex.example.com",
}

MOCK_DOMAIN_ENTRY = {
    "id": "dom_01",
    "domain": "example.com",
    "verified": True,
    "verifiedAt": "2024-06-01T12:00:00Z",
    "createdAt": "2024-06-01T10:00:00Z",
}

MOCK_VERIFY_RESPONSE = {"verified": True, "message": "Domain verified successfully"}


@pytest.fixture
def client() -> Grantex:
    return Grantex(api_key="test-key")


@respx.mock
def test_create_domain(client: Grantex) -> None:
    import json

    route = respx.post("https://api.grantex.dev/v1/domains").mock(
        return_value=httpx.Response(200, json=MOCK_DOMAIN_CREATE)
    )
    from grantex.resources._domains import CreateDomainParams

    result = client.domains.create(CreateDomainParams(domain="example.com"))
    assert result.id == "dom_01"
    assert result.domain == "example.com"
    assert result.verified is False
    assert result.verification_token == "gx-verify-abc123"
    assert "TXT record" in result.instructions

    body = json.loads(route.calls[0].request.content)
    assert body["domain"] == "example.com"


@respx.mock
def test_list_domains(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/v1/domains").mock(
        return_value=httpx.Response(200, json={"domains": [MOCK_DOMAIN_ENTRY]})
    )
    result = client.domains.list()
    assert len(result.domains) == 1
    assert result.domains[0].id == "dom_01"
    assert result.domains[0].domain == "example.com"
    assert result.domains[0].verified is True
    assert result.domains[0].verified_at == "2024-06-01T12:00:00Z"
    assert result.domains[0].created_at == "2024-06-01T10:00:00Z"


@respx.mock
def test_list_domains_empty(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/v1/domains").mock(
        return_value=httpx.Response(200, json={"domains": []})
    )
    result = client.domains.list()
    assert len(result.domains) == 0


@respx.mock
def test_verify_domain_success(client: Grantex) -> None:
    respx.post("https://api.grantex.dev/v1/domains/dom_01/verify").mock(
        return_value=httpx.Response(200, json=MOCK_VERIFY_RESPONSE)
    )
    result = client.domains.verify("dom_01")
    assert result.verified is True
    assert result.message == "Domain verified successfully"


@respx.mock
def test_verify_domain_not_verified(client: Grantex) -> None:
    respx.post("https://api.grantex.dev/v1/domains/dom_01/verify").mock(
        return_value=httpx.Response(
            200, json={"verified": False, "message": "TXT record not found"}
        )
    )
    result = client.domains.verify("dom_01")
    assert result.verified is False


@respx.mock
def test_delete_domain(client: Grantex) -> None:
    route = respx.delete("https://api.grantex.dev/v1/domains/dom_01").mock(
        return_value=httpx.Response(204)
    )
    client.domains.delete("dom_01")
    assert route.called
