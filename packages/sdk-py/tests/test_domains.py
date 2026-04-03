"""Tests for DomainsClient — create, list, verify, delete."""
from __future__ import annotations

import json

import pytest
import respx
import httpx

from grantex import Grantex
from grantex._errors import GrantexApiError
from grantex.resources._domains import CreateDomainParams


BASE_URL = "https://api.grantex.dev"

MOCK_DOMAIN_CREATE = {
    "id": "dom_01",
    "domain": "example.com",
    "verified": False,
    "verificationToken": "grantex-verify-abc123",
    "instructions": "Add a DNS TXT record: _grantex.example.com = grantex-verify-abc123",
}

MOCK_DOMAIN_ENTRY = {
    "id": "dom_01",
    "domain": "example.com",
    "verified": True,
    "verifiedAt": "2024-06-01T12:00:00Z",
    "createdAt": "2024-06-01T10:00:00Z",
}

MOCK_DOMAIN_ENTRY_UNVERIFIED = {
    "id": "dom_02",
    "domain": "staging.example.com",
    "verified": False,
    "verifiedAt": None,
    "createdAt": "2024-06-02T10:00:00Z",
}

MOCK_VERIFY_SUCCESS = {"verified": True, "message": "Domain verified successfully"}
MOCK_VERIFY_FAILURE = {"verified": False, "message": "DNS verification failed. Ensure TXT record is set."}


@pytest.fixture
def client() -> Grantex:
    return Grantex(api_key="test-key")


# ── Create Domain ─────────────────────────────────────────────────────────

@respx.mock
def test_create_domain(client: Grantex) -> None:
    route = respx.post(f"{BASE_URL}/v1/domains").mock(
        return_value=httpx.Response(200, json=MOCK_DOMAIN_CREATE)
    )
    result = client.domains.create(CreateDomainParams(domain="example.com"))

    assert result.id == "dom_01"
    assert result.domain == "example.com"
    assert result.verified is False
    assert result.verification_token == "grantex-verify-abc123"
    assert "TXT record" in result.instructions
    assert "example.com" in result.instructions

    body = json.loads(route.calls[0].request.content)
    assert body["domain"] == "example.com"


@respx.mock
def test_create_domain_sends_correct_body(client: Grantex) -> None:
    route = respx.post(f"{BASE_URL}/v1/domains").mock(
        return_value=httpx.Response(200, json=MOCK_DOMAIN_CREATE)
    )
    client.domains.create(CreateDomainParams(domain="api.mysite.io"))

    body = json.loads(route.calls[0].request.content)
    assert body == {"domain": "api.mysite.io"}


@respx.mock
def test_create_domain_plan_limit_error(client: Grantex) -> None:
    respx.post(f"{BASE_URL}/v1/domains").mock(
        return_value=httpx.Response(
            402,
            json={
                "message": "Custom domains require Enterprise plan",
                "code": "PLAN_LIMIT_EXCEEDED",
            },
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.domains.create(CreateDomainParams(domain="premium.example.com"))
    assert exc_info.value.status_code == 402
    assert exc_info.value.code == "PLAN_LIMIT_EXCEEDED"


@respx.mock
def test_create_domain_conflict_error(client: Grantex) -> None:
    respx.post(f"{BASE_URL}/v1/domains").mock(
        return_value=httpx.Response(
            409,
            json={"message": "Domain already registered", "code": "CONFLICT"},
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.domains.create(CreateDomainParams(domain="duplicate.example.com"))
    assert exc_info.value.status_code == 409
    assert exc_info.value.code == "CONFLICT"


# ── List Domains ──────────────────────────────────────────────────────────

@respx.mock
def test_list_domains(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/domains").mock(
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
def test_list_domains_multiple(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/domains").mock(
        return_value=httpx.Response(
            200, json={"domains": [MOCK_DOMAIN_ENTRY, MOCK_DOMAIN_ENTRY_UNVERIFIED]}
        )
    )
    result = client.domains.list()

    assert len(result.domains) == 2
    assert result.domains[0].verified is True
    assert result.domains[1].verified is False
    assert result.domains[1].verified_at is None
    assert result.domains[1].domain == "staging.example.com"


@respx.mock
def test_list_domains_empty(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/domains").mock(
        return_value=httpx.Response(200, json={"domains": []})
    )
    result = client.domains.list()
    assert len(result.domains) == 0


# ── Verify Domain ────────────────────────────────────────────────────────

@respx.mock
def test_verify_domain_success(client: Grantex) -> None:
    respx.post(f"{BASE_URL}/v1/domains/dom_01/verify").mock(
        return_value=httpx.Response(200, json=MOCK_VERIFY_SUCCESS)
    )
    result = client.domains.verify("dom_01")

    assert result.verified is True
    assert result.message == "Domain verified successfully"


@respx.mock
def test_verify_domain_failure(client: Grantex) -> None:
    respx.post(f"{BASE_URL}/v1/domains/dom_01/verify").mock(
        return_value=httpx.Response(
            400,
            json={
                "message": "DNS verification failed. Ensure TXT record is set.",
                "code": "VERIFICATION_FAILED",
            },
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.domains.verify("dom_01")
    assert exc_info.value.status_code == 400
    assert exc_info.value.code == "VERIFICATION_FAILED"


@respx.mock
def test_verify_domain_already_verified(client: Grantex) -> None:
    respx.post(f"{BASE_URL}/v1/domains/dom_01/verify").mock(
        return_value=httpx.Response(
            200, json={"verified": True, "message": "Domain already verified"}
        )
    )
    result = client.domains.verify("dom_01")
    assert result.verified is True
    assert result.message == "Domain already verified"


@respx.mock
def test_verify_domain_not_found(client: Grantex) -> None:
    respx.post(f"{BASE_URL}/v1/domains/dom_nonexistent/verify").mock(
        return_value=httpx.Response(
            404, json={"message": "Domain not found", "code": "NOT_FOUND"}
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.domains.verify("dom_nonexistent")
    assert exc_info.value.status_code == 404


@respx.mock
def test_verify_domain_sends_post_to_correct_url(client: Grantex) -> None:
    route = respx.post(f"{BASE_URL}/v1/domains/dom_xyz/verify").mock(
        return_value=httpx.Response(200, json=MOCK_VERIFY_SUCCESS)
    )
    client.domains.verify("dom_xyz")
    assert route.called
    assert str(route.calls[0].request.url) == f"{BASE_URL}/v1/domains/dom_xyz/verify"


# ── Delete Domain ────────────────────────────────────────────────────────

@respx.mock
def test_delete_domain(client: Grantex) -> None:
    route = respx.delete(f"{BASE_URL}/v1/domains/dom_01").mock(
        return_value=httpx.Response(204)
    )
    result = client.domains.delete("dom_01")
    assert result is None
    assert route.called


@respx.mock
def test_delete_domain_not_found(client: Grantex) -> None:
    respx.delete(f"{BASE_URL}/v1/domains/dom_nonexistent").mock(
        return_value=httpx.Response(
            404, json={"message": "Domain not found", "code": "NOT_FOUND"}
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.domains.delete("dom_nonexistent")
    assert exc_info.value.status_code == 404


@respx.mock
def test_delete_domain_sends_correct_method(client: Grantex) -> None:
    route = respx.delete(f"{BASE_URL}/v1/domains/dom_abc").mock(
        return_value=httpx.Response(204)
    )
    client.domains.delete("dom_abc")
    assert route.calls[0].request.method == "DELETE"
