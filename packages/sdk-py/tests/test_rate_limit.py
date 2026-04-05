"""Tests for rate limit header parsing."""
from __future__ import annotations

import pytest
import respx
import httpx

from grantex import Grantex, GrantexApiError, RateLimit


@pytest.fixture
def client() -> Grantex:
    return Grantex(api_key="test-key", max_retries=0)


@respx.mock
def test_last_rate_limit_populated_on_success(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/v1/agents").mock(
        return_value=httpx.Response(
            200,
            json={"agents": [], "total": 0, "page": 1, "pageSize": 20},
            headers={
                "x-ratelimit-limit": "100",
                "x-ratelimit-remaining": "97",
                "x-ratelimit-reset": "1709337600",
            },
        )
    )

    client.agents.list()

    assert client.last_rate_limit is not None
    assert client.last_rate_limit == RateLimit(
        limit=100, remaining=97, reset=1709337600
    )


@respx.mock
def test_rate_limit_on_429_with_retry_after(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/v1/agents").mock(
        return_value=httpx.Response(
            429,
            json={"message": "Rate limit exceeded"},
            headers={
                "x-ratelimit-limit": "20",
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": "1709337600",
                "retry-after": "42",
            },
        )
    )

    with pytest.raises(GrantexApiError) as exc_info:
        client.agents.list()

    err = exc_info.value
    assert err.status_code == 429
    assert err.rate_limit is not None
    assert err.rate_limit == RateLimit(
        limit=20, remaining=0, reset=1709337600, retry_after=42
    )


@respx.mock
def test_last_rate_limit_none_when_headers_missing(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/v1/agents").mock(
        return_value=httpx.Response(
            200,
            json={"agents": [], "total": 0, "page": 1, "pageSize": 20},
        )
    )

    client.agents.list()

    assert client.last_rate_limit is None
