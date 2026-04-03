"""Tests for error handling across SDK clients."""
from __future__ import annotations

import pytest
import respx
import httpx

from grantex import Grantex
from grantex._errors import (
    GrantexApiError,
    GrantexAuthError,
    GrantexNetworkError,
)


@pytest.fixture
def client() -> Grantex:
    return Grantex(api_key="test-key")


# ── 400 Bad Request ─────────────────────────────────────────────────────────

@respx.mock
def test_400_raises_api_error(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/v1/agents").mock(
        return_value=httpx.Response(
            400, json={"code": "INVALID_REQUEST", "message": "Missing required field"}
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.agents.list()
    assert exc_info.value.status_code == 400
    assert exc_info.value.code == "INVALID_REQUEST"
    assert "Missing required field" in str(exc_info.value)


# ── 401 Unauthorized ────────────────────────────────────────────────────────

@respx.mock
def test_401_raises_auth_error(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/v1/agents").mock(
        return_value=httpx.Response(
            401, json={"code": "UNAUTHORIZED", "message": "Invalid API key"}
        )
    )
    with pytest.raises(GrantexAuthError) as exc_info:
        client.agents.list()
    assert exc_info.value.status_code == 401
    assert isinstance(exc_info.value, GrantexApiError)  # subclass


# ── 403 Forbidden ───────────────────────────────────────────────────────────

@respx.mock
def test_403_raises_auth_error(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/v1/agents").mock(
        return_value=httpx.Response(
            403, json={"code": "FORBIDDEN", "message": "Insufficient permissions"}
        )
    )
    with pytest.raises(GrantexAuthError) as exc_info:
        client.agents.list()
    assert exc_info.value.status_code == 403


# ── 404 Not Found ───────────────────────────────────────────────────────────

@respx.mock
def test_404_raises_api_error(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/v1/agents/nonexistent").mock(
        return_value=httpx.Response(
            404, json={"code": "NOT_FOUND", "message": "Agent not found"}
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.agents.get("nonexistent")
    assert exc_info.value.status_code == 404
    assert exc_info.value.code == "NOT_FOUND"


# ── 429 Too Many Requests ──────────────────────────────────────────────────

@respx.mock
def test_429_includes_rate_limit_info(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/v1/agents").mock(
        return_value=httpx.Response(
            429,
            json={"code": "RATE_LIMITED", "message": "Too many requests"},
            headers={
                "x-ratelimit-limit": "100",
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": "1700000000",
                "retry-after": "60",
            },
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.agents.list()
    assert exc_info.value.status_code == 429
    assert exc_info.value.rate_limit is not None
    assert exc_info.value.rate_limit.limit == 100
    assert exc_info.value.rate_limit.remaining == 0
    assert exc_info.value.rate_limit.retry_after == 60


# ── 500 Internal Server Error ──────────────────────────────────────────────

@respx.mock
def test_500_raises_api_error(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/v1/agents").mock(
        return_value=httpx.Response(
            500, json={"code": "INTERNAL_ERROR", "message": "Internal server error"}
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.agents.list()
    assert exc_info.value.status_code == 500


# ── Malformed JSON response ────────────────────────────────────────────────

@respx.mock
def test_malformed_json_error_response(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/v1/agents").mock(
        return_value=httpx.Response(502, text="Bad Gateway")
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.agents.list()
    assert exc_info.value.status_code == 502


# ── Network timeout ─────────────────────────────────────────────────────────

@respx.mock
def test_network_timeout_raises_network_error(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/v1/agents").mock(
        side_effect=httpx.ReadTimeout("Connection timed out")
    )
    with pytest.raises(GrantexNetworkError) as exc_info:
        client.agents.list()
    assert "timed out" in str(exc_info.value).lower()
    assert exc_info.value.cause is not None


# ── Connection error ────────────────────────────────────────────────────────

@respx.mock
def test_connection_error_raises_network_error(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/v1/agents").mock(
        side_effect=httpx.ConnectError("Connection refused")
    )
    with pytest.raises(GrantexNetworkError):
        client.agents.list()


# ── Error body without code ─────────────────────────────────────────────────

@respx.mock
def test_error_without_code_field(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/v1/agents").mock(
        return_value=httpx.Response(
            400, json={"message": "Something went wrong"}
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.agents.list()
    assert exc_info.value.code is None
    assert "Something went wrong" in str(exc_info.value)


# ── Error body with 'error' key instead of 'message' ───────────────────────

@respx.mock
def test_error_with_error_key_instead_of_message(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/v1/agents").mock(
        return_value=httpx.Response(
            400, json={"error": "Bad input"}
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.agents.list()
    assert "Bad input" in str(exc_info.value)


# ── Request ID propagation ──────────────────────────────────────────────────

@respx.mock
def test_request_id_in_error(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/v1/agents").mock(
        return_value=httpx.Response(
            500,
            json={"code": "INTERNAL_ERROR", "message": "fail"},
            headers={"x-request-id": "req_12345"},
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.agents.list()
    assert exc_info.value.request_id == "req_12345"
