"""Tests for ScimClient."""
from __future__ import annotations

import pytest
import respx
import httpx

from grantex import Grantex
from grantex._types import CreateScimUserParams

MOCK_SCIM_USER = {
    "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
    "id": "scimuser_01",
    "userName": "alice@corp.com",
    "displayName": "Alice Smith",
    "externalId": "ext_abc",
    "active": True,
    "emails": [{"value": "alice@corp.com", "primary": True}],
    "meta": {
        "resourceType": "User",
        "created": "2026-02-27T00:00:00Z",
        "lastModified": "2026-02-27T00:00:00Z",
    },
}

MOCK_TOKEN = {
    "id": "scimtok_01",
    "label": "Okta",
    "token": "raw_secret_abc",
    "createdAt": "2026-02-27T00:00:00Z",
    "lastUsedAt": None,
}


@pytest.fixture
def client() -> Grantex:
    return Grantex(api_key="test-key")


# ── SCIM token management ─────────────────────────────────────────────────────

@respx.mock
def test_create_token(client: Grantex) -> None:
    respx.post("https://api.grantex.dev/v1/scim/tokens").mock(
        return_value=httpx.Response(201, json=MOCK_TOKEN)
    )
    result = client.scim.create_token("Okta")

    assert result.id == "scimtok_01"
    assert result.label == "Okta"
    assert result.token == "raw_secret_abc"
    assert result.last_used_at is None


@respx.mock
def test_list_tokens(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/v1/scim/tokens").mock(
        return_value=httpx.Response(200, json={"tokens": [MOCK_TOKEN]})
    )
    result = client.scim.list_tokens()

    assert len(result.tokens) == 1
    assert result.tokens[0].id == "scimtok_01"


@respx.mock
def test_revoke_token(client: Grantex) -> None:
    route = respx.delete("https://api.grantex.dev/v1/scim/tokens/scimtok_01").mock(
        return_value=httpx.Response(204)
    )
    client.scim.revoke_token("scimtok_01")

    assert route.called


# ── SCIM 2.0 Users ────────────────────────────────────────────────────────────

@respx.mock
def test_list_users(client: Grantex) -> None:
    list_resp = {
        "totalResults": 1,
        "startIndex": 1,
        "itemsPerPage": 100,
        "Resources": [MOCK_SCIM_USER],
    }
    respx.get("https://api.grantex.dev/scim/v2/Users").mock(
        return_value=httpx.Response(200, json=list_resp)
    )
    result = client.scim.list_users()

    assert result.total_results == 1
    assert result.resources[0].user_name == "alice@corp.com"
    assert result.resources[0].active is True


@respx.mock
def test_list_users_with_pagination(client: Grantex) -> None:
    route = respx.get("https://api.grantex.dev/scim/v2/Users").mock(
        return_value=httpx.Response(
            200,
            json={"totalResults": 0, "startIndex": 11, "itemsPerPage": 10, "Resources": []},
        )
    )
    client.scim.list_users(start_index=11, count=10)

    url = str(route.calls[0].request.url)
    assert "startIndex=11" in url
    assert "count=10" in url


@respx.mock
def test_get_user(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/scim/v2/Users/scimuser_01").mock(
        return_value=httpx.Response(200, json=MOCK_SCIM_USER)
    )
    result = client.scim.get_user("scimuser_01")

    assert result.id == "scimuser_01"
    assert result.external_id == "ext_abc"
    assert result.display_name == "Alice Smith"
    assert result.meta.resource_type == "User"


@respx.mock
def test_create_user(client: Grantex) -> None:
    route = respx.post("https://api.grantex.dev/scim/v2/Users").mock(
        return_value=httpx.Response(201, json=MOCK_SCIM_USER)
    )
    params = CreateScimUserParams(
        user_name="alice@corp.com",
        display_name="Alice Smith",
        emails=[{"value": "alice@corp.com", "primary": True}],
    )
    result = client.scim.create_user(params)

    assert result.id == "scimuser_01"
    body = route.calls[0].request.read()
    assert b"alice@corp.com" in body


@respx.mock
def test_replace_user(client: Grantex) -> None:
    route = respx.put("https://api.grantex.dev/scim/v2/Users/scimuser_01").mock(
        return_value=httpx.Response(200, json=MOCK_SCIM_USER)
    )
    params = CreateScimUserParams(user_name="alice@corp.com")
    client.scim.replace_user("scimuser_01", params)

    assert route.called


@respx.mock
def test_update_user(client: Grantex) -> None:
    deactivated = {**MOCK_SCIM_USER, "active": False}
    respx.patch("https://api.grantex.dev/scim/v2/Users/scimuser_01").mock(
        return_value=httpx.Response(200, json=deactivated)
    )
    result = client.scim.update_user(
        "scimuser_01",
        [{"op": "replace", "path": "active", "value": False}],
    )

    assert result.active is False


@respx.mock
def test_delete_user(client: Grantex) -> None:
    route = respx.delete("https://api.grantex.dev/scim/v2/Users/scimuser_01").mock(
        return_value=httpx.Response(204)
    )
    client.scim.delete_user("scimuser_01")

    assert route.called
