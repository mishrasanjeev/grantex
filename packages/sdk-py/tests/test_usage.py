"""Tests for UsageClient — current usage and history."""
from __future__ import annotations

import json

import pytest
import respx
import httpx

from grantex import Grantex
from grantex._errors import GrantexApiError


BASE_URL = "https://api.grantex.dev"

MOCK_USAGE = {
    "developerId": "dev_01",
    "period": "2024-06-15",
    "tokenExchanges": 1500,
    "authorizations": 300,
    "verifications": 800,
    "totalRequests": 2600,
}

MOCK_USAGE_ZERO = {
    "developerId": "dev_new",
    "period": "2024-06-15",
    "tokenExchanges": 0,
    "authorizations": 0,
    "verifications": 0,
    "totalRequests": 0,
}

MOCK_HISTORY = {
    "developerId": "dev_01",
    "days": 7,
    "entries": [
        {
            "date": "2024-06-15",
            "tokenExchanges": 200,
            "authorizations": 50,
            "verifications": 100,
            "totalRequests": 350,
        },
        {
            "date": "2024-06-14",
            "tokenExchanges": 220,
            "authorizations": 55,
            "verifications": 110,
            "totalRequests": 385,
        },
        {
            "date": "2024-06-13",
            "tokenExchanges": 180,
            "authorizations": 40,
            "verifications": 90,
            "totalRequests": 310,
        },
    ],
}

MOCK_HISTORY_EMPTY = {
    "developerId": "dev_new",
    "days": 7,
    "entries": [],
}


@pytest.fixture
def client() -> Grantex:
    return Grantex(api_key="test-key")


# ── Current Usage ─────────────────────────────────────────────────────────

@respx.mock
def test_current_usage(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/usage").mock(
        return_value=httpx.Response(200, json=MOCK_USAGE)
    )
    result = client.usage.current()

    assert result.developer_id == "dev_01"
    assert result.period == "2024-06-15"
    assert result.token_exchanges == 1500
    assert result.authorizations == 300
    assert result.verifications == 800
    assert result.total_requests == 2600


@respx.mock
def test_current_usage_total_equals_sum(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/usage").mock(
        return_value=httpx.Response(200, json=MOCK_USAGE)
    )
    result = client.usage.current()
    assert result.total_requests == (
        result.token_exchanges + result.authorizations + result.verifications
    )


@respx.mock
def test_current_usage_zero_values(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/usage").mock(
        return_value=httpx.Response(200, json=MOCK_USAGE_ZERO)
    )
    result = client.usage.current()

    assert result.developer_id == "dev_new"
    assert result.token_exchanges == 0
    assert result.authorizations == 0
    assert result.verifications == 0
    assert result.total_requests == 0


@respx.mock
def test_current_usage_sends_get(client: Grantex) -> None:
    route = respx.get(f"{BASE_URL}/v1/usage").mock(
        return_value=httpx.Response(200, json=MOCK_USAGE)
    )
    client.usage.current()
    assert route.called
    assert route.calls[0].request.method == "GET"


@respx.mock
def test_current_usage_unauthorized(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/usage").mock(
        return_value=httpx.Response(
            401, json={"message": "Invalid API key", "code": "UNAUTHORIZED"}
        )
    )
    from grantex._errors import GrantexAuthError

    with pytest.raises(GrantexAuthError) as exc_info:
        client.usage.current()
    assert exc_info.value.status_code == 401


# ── Usage History ─────────────────────────────────────────────────────────

@respx.mock
def test_usage_history_default_days(client: Grantex) -> None:
    route = respx.get(f"{BASE_URL}/v1/usage/history").mock(
        return_value=httpx.Response(200, json=MOCK_HISTORY)
    )
    result = client.usage.history()

    assert route.called
    # When called without args, no query params should be sent
    request_url = str(route.calls[0].request.url)
    assert "days=" not in request_url
    assert result.developer_id == "dev_01"
    assert result.days == 7  # from mock response
    assert len(result.entries) == 3


@respx.mock
def test_usage_history_custom_days(client: Grantex) -> None:
    route = respx.get(f"{BASE_URL}/v1/usage/history?days=7").mock(
        return_value=httpx.Response(200, json=MOCK_HISTORY)
    )
    result = client.usage.history(days=7)

    assert route.called
    assert result.days == 7


@respx.mock
def test_usage_history_90_days(client: Grantex) -> None:
    route = respx.get(f"{BASE_URL}/v1/usage/history?days=90").mock(
        return_value=httpx.Response(200, json={**MOCK_HISTORY, "days": 90})
    )
    result = client.usage.history(days=90)
    assert route.called
    assert result.days == 90


@respx.mock
def test_usage_history_entry_fields(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/usage/history?days=7").mock(
        return_value=httpx.Response(200, json=MOCK_HISTORY)
    )
    result = client.usage.history(days=7)
    entry = result.entries[0]

    assert entry.date == "2024-06-15"
    assert entry.token_exchanges == 200
    assert entry.authorizations == 50
    assert entry.verifications == 100
    assert entry.total_requests == 350


@respx.mock
def test_usage_history_multiple_entries(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/usage/history?days=7").mock(
        return_value=httpx.Response(200, json=MOCK_HISTORY)
    )
    result = client.usage.history(days=7)

    assert len(result.entries) == 3
    dates = [e.date for e in result.entries]
    assert dates == ["2024-06-15", "2024-06-14", "2024-06-13"]


@respx.mock
def test_usage_history_empty(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/usage/history?days=7").mock(
        return_value=httpx.Response(200, json=MOCK_HISTORY_EMPTY)
    )
    result = client.usage.history(days=7)

    assert result.developer_id == "dev_new"
    assert len(result.entries) == 0


@respx.mock
def test_usage_history_url_format(client: Grantex) -> None:
    route = respx.get(f"{BASE_URL}/v1/usage/history?days=14").mock(
        return_value=httpx.Response(200, json=MOCK_HISTORY)
    )
    client.usage.history(days=14)

    assert route.called
    request_url = str(route.calls[0].request.url)
    assert "days=14" in request_url


@respx.mock
def test_usage_history_server_error(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/usage/history").mock(
        return_value=httpx.Response(
            500, json={"message": "Internal server error", "code": "INTERNAL_ERROR"}
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.usage.history()
    assert exc_info.value.status_code == 500
