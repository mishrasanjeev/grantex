"""Tests for HttpClient edge cases."""
from __future__ import annotations

import pytest
import respx
import httpx

from grantex._http import HttpClient, _parse_rate_limit_headers, _extract_error_code, _extract_error_message


# ── 204 No Content ─────────────────────────────────────────────────────────

@respx.mock
def test_204_returns_none() -> None:
    respx.delete("https://api.grantex.dev/v1/agents/a1").mock(
        return_value=httpx.Response(204)
    )
    client = HttpClient("https://api.grantex.dev", "test-key")
    result = client.delete("/v1/agents/a1")
    assert result is None
    client.close()


# ── Rate limit header parsing ──────────────────────────────────────────────

def test_parse_rate_limit_headers_complete() -> None:
    headers = httpx.Headers({
        "x-ratelimit-limit": "100",
        "x-ratelimit-remaining": "42",
        "x-ratelimit-reset": "1700000000",
        "retry-after": "30",
    })
    rl = _parse_rate_limit_headers(headers)
    assert rl is not None
    assert rl.limit == 100
    assert rl.remaining == 42
    assert rl.reset == 1700000000
    assert rl.retry_after == 30


def test_parse_rate_limit_headers_without_retry_after() -> None:
    headers = httpx.Headers({
        "x-ratelimit-limit": "100",
        "x-ratelimit-remaining": "99",
        "x-ratelimit-reset": "1700000000",
    })
    rl = _parse_rate_limit_headers(headers)
    assert rl is not None
    assert rl.retry_after is None


def test_parse_rate_limit_headers_missing_returns_none() -> None:
    headers = httpx.Headers({"content-type": "application/json"})
    rl = _parse_rate_limit_headers(headers)
    assert rl is None


def test_parse_rate_limit_partial_headers_returns_none() -> None:
    headers = httpx.Headers({"x-ratelimit-limit": "100"})
    rl = _parse_rate_limit_headers(headers)
    assert rl is None


# ── Error extraction helpers ───────────────────────────────────────────────

def test_extract_error_code_from_dict() -> None:
    assert _extract_error_code({"code": "INVALID"}) == "INVALID"


def test_extract_error_code_missing() -> None:
    assert _extract_error_code({"message": "fail"}) is None


def test_extract_error_code_non_dict() -> None:
    assert _extract_error_code("just a string") is None
    assert _extract_error_code(None) is None


def test_extract_error_message_from_message_key() -> None:
    assert _extract_error_message({"message": "Bad request"}, 400) == "Bad request"


def test_extract_error_message_from_error_key() -> None:
    assert _extract_error_message({"error": "Something broke"}, 500) == "Something broke"


def test_extract_error_message_fallback() -> None:
    assert _extract_error_message({}, 502) == "HTTP 502"
    assert _extract_error_message(None, 503) == "HTTP 503"


# ── Custom base_url ────────────────────────────────────────────────────────

@respx.mock
def test_custom_base_url() -> None:
    respx.get("https://custom.example.com/v1/agents").mock(
        return_value=httpx.Response(200, json={"agents": []})
    )
    client = HttpClient("https://custom.example.com", "test-key")
    result = client.get("/v1/agents")
    assert result == {"agents": []}
    client.close()


@respx.mock
def test_base_url_trailing_slash_stripped() -> None:
    respx.get("https://custom.example.com/v1/agents").mock(
        return_value=httpx.Response(200, json={"agents": []})
    )
    client = HttpClient("https://custom.example.com/", "test-key")
    result = client.get("/v1/agents")
    assert result == {"agents": []}
    client.close()


# ── Context manager ────────────────────────────────────────────────────────

@respx.mock
def test_context_manager() -> None:
    respx.get("https://api.grantex.dev/v1/agents").mock(
        return_value=httpx.Response(200, json={"agents": []})
    )
    with HttpClient("https://api.grantex.dev", "test-key") as client:
        result = client.get("/v1/agents")
    assert result == {"agents": []}


# ── Rate limit stored after request ────────────────────────────────────────

@respx.mock
def test_rate_limit_stored_after_successful_request() -> None:
    respx.get("https://api.grantex.dev/v1/agents").mock(
        return_value=httpx.Response(
            200,
            json={"agents": []},
            headers={
                "x-ratelimit-limit": "100",
                "x-ratelimit-remaining": "99",
                "x-ratelimit-reset": "1700000000",
            },
        )
    )
    client = HttpClient("https://api.grantex.dev", "test-key")
    client.get("/v1/agents")
    assert client.last_rate_limit is not None
    assert client.last_rate_limit.remaining == 99
    client.close()


# ── POST with JSON body ───────────────────────────────────────────────────

@respx.mock
def test_post_sends_json_body() -> None:
    import json

    route = respx.post("https://api.grantex.dev/v1/agents").mock(
        return_value=httpx.Response(200, json={"id": "ag_01"})
    )
    client = HttpClient("https://api.grantex.dev", "test-key")
    client.post("/v1/agents", {"name": "test", "scopes": ["read"]})
    body = json.loads(route.calls[0].request.content)
    assert body["name"] == "test"
    assert body["scopes"] == ["read"]
    client.close()


# ── Authorization header sent ──────────────────────────────────────────────

@respx.mock
def test_authorization_header_sent() -> None:
    route = respx.get("https://api.grantex.dev/v1/agents").mock(
        return_value=httpx.Response(200, json={"agents": []})
    )
    client = HttpClient("https://api.grantex.dev", "my-api-key")
    client.get("/v1/agents")
    assert route.calls[0].request.headers["authorization"] == "Bearer my-api-key"
    client.close()
