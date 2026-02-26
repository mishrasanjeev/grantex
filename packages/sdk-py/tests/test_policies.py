from __future__ import annotations

import json

import httpx
import respx

from grantex import Grantex
from grantex._types import CreatePolicyParams, UpdatePolicyParams

BASE_URL = "http://test.local"

MOCK_POLICY = {
    "id": "pol_01",
    "name": "Block all",
    "effect": "deny",
    "priority": 0,
    "agentId": None,
    "principalId": None,
    "scopes": None,
    "timeOfDayStart": None,
    "timeOfDayEnd": None,
    "createdAt": "2026-01-01T00:00:00Z",
    "updatedAt": "2026-01-01T00:00:00Z",
}


@respx.mock
def test_create_policy_posts_to_v1_policies() -> None:
    respx.post(f"{BASE_URL}/v1/policies").mock(
        return_value=httpx.Response(201, json=MOCK_POLICY)
    )

    client = Grantex(api_key="test_key", base_url=BASE_URL)
    params = CreatePolicyParams(name="Block all", effect="deny")
    result = client.policies.create(params)

    assert result.id == "pol_01"
    assert result.effect == "deny"
    assert result.name == "Block all"
    assert result.agent_id is None
    request = respx.calls.last.request
    body = json.loads(request.content)
    assert body["name"] == "Block all"
    assert body["effect"] == "deny"


@respx.mock
def test_list_policies_returns_all() -> None:
    respx.get(f"{BASE_URL}/v1/policies").mock(
        return_value=httpx.Response(200, json={"policies": [MOCK_POLICY], "total": 1})
    )

    client = Grantex(api_key="test_key", base_url=BASE_URL)
    result = client.policies.list()

    assert result.total == 1
    assert len(result.policies) == 1
    assert result.policies[0].id == "pol_01"


@respx.mock
def test_get_policy_by_id() -> None:
    respx.get(f"{BASE_URL}/v1/policies/pol_01").mock(
        return_value=httpx.Response(200, json=MOCK_POLICY)
    )

    client = Grantex(api_key="test_key", base_url=BASE_URL)
    result = client.policies.get("pol_01")

    assert result.id == "pol_01"


@respx.mock
def test_update_policy_patches_name() -> None:
    updated = {**MOCK_POLICY, "name": "Updated"}
    respx.patch(f"{BASE_URL}/v1/policies/pol_01").mock(
        return_value=httpx.Response(200, json=updated)
    )

    client = Grantex(api_key="test_key", base_url=BASE_URL)
    params = UpdatePolicyParams(name="Updated")
    result = client.policies.update("pol_01", params)

    assert result.name == "Updated"
    request = respx.calls.last.request
    body = json.loads(request.content)
    assert body["name"] == "Updated"


@respx.mock
def test_delete_policy() -> None:
    respx.delete(f"{BASE_URL}/v1/policies/pol_01").mock(
        return_value=httpx.Response(204)
    )

    client = Grantex(api_key="test_key", base_url=BASE_URL)
    result = client.policies.delete("pol_01")

    assert result is None
