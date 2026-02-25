"""Tests for AgentsClient."""
from __future__ import annotations

import pytest
import respx
import httpx

from grantex import Grantex
from tests.conftest import MOCK_AGENT


@pytest.fixture
def client() -> Grantex:
    return Grantex(api_key="test-key")


@respx.mock
def test_register_post_body_and_url(client: Grantex) -> None:
    import json

    route = respx.post("https://api.grantex.dev/v1/agents").mock(
        return_value=httpx.Response(200, json=MOCK_AGENT)
    )
    agent = client.agents.register(
        name="travel-booker",
        description="Books flights and hotels",
        scopes=["calendar:read", "payments:initiate:max_500"],
    )

    assert agent.id == "ag_01HXYZ123abc"
    assert agent.did == "did:grantex:ag_01HXYZ123abc"

    body = json.loads(route.calls[0].request.content)
    assert body["name"] == "travel-booker"
    assert body["description"] == "Books flights and hotels"
    assert body["scopes"] == ["calendar:read", "payments:initiate:max_500"]


@respx.mock
def test_register_default_description(client: Grantex) -> None:
    import json

    route = respx.post("https://api.grantex.dev/v1/agents").mock(
        return_value=httpx.Response(200, json=MOCK_AGENT)
    )
    client.agents.register(name="my-agent", scopes=["files:read"])

    body = json.loads(route.calls[0].request.content)
    assert body["description"] == ""


@respx.mock
def test_get_by_id(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/v1/agents/ag_01HXYZ123abc").mock(
        return_value=httpx.Response(200, json=MOCK_AGENT)
    )
    agent = client.agents.get("ag_01HXYZ123abc")
    assert agent.id == "ag_01HXYZ123abc"
    assert agent.name == "travel-booker"


@respx.mock
def test_list_response_model(client: Grantex) -> None:
    payload = {
        "agents": [MOCK_AGENT],
        "total": 1,
        "page": 1,
        "pageSize": 20,
    }
    respx.get("https://api.grantex.dev/v1/agents").mock(
        return_value=httpx.Response(200, json=payload)
    )
    response = client.agents.list()
    assert response.total == 1
    assert response.page == 1
    assert response.page_size == 20
    assert len(response.agents) == 1
    assert response.agents[0].name == "travel-booker"


@respx.mock
def test_update_partial(client: Grantex) -> None:
    import json

    updated = {**MOCK_AGENT, "name": "updated-booker"}
    route = respx.post("https://api.grantex.dev/v1/agents/ag_01HXYZ123abc").mock(
        return_value=httpx.Response(200, json=updated)
    )
    agent = client.agents.update("ag_01HXYZ123abc", name="updated-booker")
    assert agent.name == "updated-booker"

    body = json.loads(route.calls[0].request.content)
    assert body == {"name": "updated-booker"}


@respx.mock
def test_delete_returns_none(client: Grantex) -> None:
    respx.delete("https://api.grantex.dev/v1/agents/ag_01HXYZ123abc").mock(
        return_value=httpx.Response(204)
    )
    result = client.agents.delete("ag_01HXYZ123abc")
    assert result is None
