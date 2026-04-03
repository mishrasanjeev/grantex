"""Tests for UsageClient."""
from __future__ import annotations

import pytest
import respx
import httpx

from grantex import Grantex

MOCK_USAGE = {
    "developerId": "dev_01",
    "period": "2024-06",
    "tokenExchanges": 1500,
    "authorizations": 300,
    "verifications": 800,
    "totalRequests": 2600,
}

MOCK_HISTORY = {
    "developerId": "dev_01",
    "days": 7,
    "entries": [
        {
            "date": "2024-06-01",
            "tokenExchanges": 200,
            "authorizations": 50,
            "verifications": 100,
            "totalRequests": 350,
        },
        {
            "date": "2024-06-02",
            "tokenExchanges": 220,
            "authorizations": 55,
            "verifications": 110,
            "totalRequests": 385,
        },
    ],
}


@pytest.fixture
def client() -> Grantex:
    return Grantex(api_key="test-key")


@respx.mock
def test_current_usage(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/v1/usage").mock(
        return_value=httpx.Response(200, json=MOCK_USAGE)
    )
    result = client.usage.current()
    assert result.developer_id == "dev_01"
    assert result.period == "2024-06"
    assert result.token_exchanges == 1500
    assert result.authorizations == 300
    assert result.verifications == 800
    assert result.total_requests == 2600


@respx.mock
def test_usage_history_default_days(client: Grantex) -> None:
    route = respx.get("https://api.grantex.dev/v1/usage/history?days=30").mock(
        return_value=httpx.Response(200, json=MOCK_HISTORY)
    )
    result = client.usage.history()
    assert route.called
    assert result.developer_id == "dev_01"
    assert len(result.entries) == 2


@respx.mock
def test_usage_history_custom_days(client: Grantex) -> None:
    route = respx.get("https://api.grantex.dev/v1/usage/history?days=7").mock(
        return_value=httpx.Response(200, json=MOCK_HISTORY)
    )
    result = client.usage.history(days=7)
    assert route.called
    assert result.days == 7
    entry = result.entries[0]
    assert entry.date == "2024-06-01"
    assert entry.token_exchanges == 200
    assert entry.authorizations == 50
    assert entry.verifications == 100
    assert entry.total_requests == 350
