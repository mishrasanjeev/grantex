"""Tests for AuditClient."""
from __future__ import annotations

import json

import pytest
import respx
import httpx

from grantex import Grantex
from grantex._types import ListAuditParams
from tests.conftest import MOCK_AUDIT_ENTRY


@pytest.fixture
def client() -> Grantex:
    return Grantex(api_key="test-key")


@respx.mock
def test_log_body_fields(client: Grantex) -> None:
    route = respx.post("https://api.grantex.dev/v1/audit/log").mock(
        return_value=httpx.Response(200, json=MOCK_AUDIT_ENTRY)
    )
    entry = client.audit.log(
        agent_id="ag_01HXYZ123abc",
        grant_id="grant_01HXYZ",
        action="payment.initiated",
        metadata={"amount": 420, "currency": "USD"},
        status="success",
    )
    assert entry.entry_id == "audit_01HXYZ"
    assert entry.action == "payment.initiated"
    assert entry.metadata == {"amount": 420, "currency": "USD"}
    assert entry.status == "success"
    assert entry.prev_hash is None

    body = json.loads(route.calls[0].request.content)
    assert body["agentId"] == "ag_01HXYZ123abc"
    assert body["grantId"] == "grant_01HXYZ"
    assert body["action"] == "payment.initiated"
    assert body["metadata"] == {"amount": 420, "currency": "USD"}
    assert body["status"] == "success"


@respx.mock
def test_log_without_metadata(client: Grantex) -> None:
    route = respx.post("https://api.grantex.dev/v1/audit/log").mock(
        return_value=httpx.Response(200, json=MOCK_AUDIT_ENTRY)
    )
    client.audit.log(
        agent_id="ag_01HXYZ123abc",
        grant_id="grant_01HXYZ",
        action="data.read",
    )
    body = json.loads(route.calls[0].request.content)
    assert "metadata" not in body


@respx.mock
def test_list_and_query_params(client: Grantex) -> None:
    payload = {
        "entries": [MOCK_AUDIT_ENTRY],
        "total": 1,
        "page": 1,
        "pageSize": 20,
    }
    route = respx.get("https://api.grantex.dev/v1/audit/entries").mock(
        return_value=httpx.Response(200, json=payload)
    )
    params = ListAuditParams(agent_id="ag_01HXYZ123abc", action="payment.initiated")
    response = client.audit.list(params)

    assert response.total == 1
    assert len(response.entries) == 1

    url = str(route.calls[0].request.url)
    assert "agentId=ag_01HXYZ123abc" in url
    assert "action=payment.initiated" in url


@respx.mock
def test_list_no_params(client: Grantex) -> None:
    payload = {"entries": [], "total": 0, "page": 1, "pageSize": 20}
    route = respx.get("https://api.grantex.dev/v1/audit/entries").mock(
        return_value=httpx.Response(200, json=payload)
    )
    client.audit.list()
    url = str(route.calls[0].request.url)
    assert url == "https://api.grantex.dev/v1/audit/entries"


@respx.mock
def test_get_by_id(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/v1/audit/audit_01HXYZ").mock(
        return_value=httpx.Response(200, json=MOCK_AUDIT_ENTRY)
    )
    entry = client.audit.get("audit_01HXYZ")
    assert entry.entry_id == "audit_01HXYZ"
    assert entry.prev_hash is None
    assert entry.status == "success"
