"""Tests for error handling across SDK clients.

Covers 400, 401, 403, 404, 429, 500, 502 errors across multiple client methods,
error body parsing, request ID propagation, rate limit headers, and network errors.
"""
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


BASE_URL = "https://api.grantex.dev"


@pytest.fixture
def client() -> Grantex:
    return Grantex(api_key="test-key")


# ═══════════════════════════════════════════════════════════════════════════
# 400 Bad Request
# ═══════════════════════════════════════════════════════════════════════════

@respx.mock
def test_400_raises_api_error_on_agents_list(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/agents").mock(
        return_value=httpx.Response(
            400, json={"code": "INVALID_REQUEST", "message": "Missing required field"}
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.agents.list()
    assert exc_info.value.status_code == 400
    assert exc_info.value.code == "INVALID_REQUEST"
    assert "Missing required field" in str(exc_info.value)


@respx.mock
def test_400_on_token_exchange(client: Grantex) -> None:
    from grantex import ExchangeTokenParams

    respx.post(f"{BASE_URL}/v1/token").mock(
        return_value=httpx.Response(
            400, json={"code": "INVALID_CODE", "message": "Authorization code expired or invalid"}
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.tokens.exchange(ExchangeTokenParams(code="bad_code", agent_id="ag_01"))
    assert exc_info.value.status_code == 400
    assert exc_info.value.code == "INVALID_CODE"


@respx.mock
def test_400_on_webhook_creation(client: Grantex) -> None:
    from grantex import CreateWebhookParams

    respx.post(f"{BASE_URL}/v1/webhooks").mock(
        return_value=httpx.Response(
            400, json={"code": "BAD_REQUEST", "message": "url and events are required"}
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.webhooks.create(url="", events=[])
    assert exc_info.value.status_code == 400


@respx.mock
def test_400_on_policy_creation(client: Grantex) -> None:
    from grantex import CreatePolicyParams

    respx.post(f"{BASE_URL}/v1/policies").mock(
        return_value=httpx.Response(
            400, json={"code": "BAD_REQUEST", "message": "name and effect (allow|deny) are required"}
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.policies.create(CreatePolicyParams(name="", effect="allow"))
    assert exc_info.value.status_code == 400


@respx.mock
def test_400_on_budget_allocate(client: Grantex) -> None:
    from grantex import AllocateBudgetParams

    respx.post(f"{BASE_URL}/v1/budget/allocate").mock(
        return_value=httpx.Response(
            400, json={"code": "BAD_REQUEST", "message": "grantId and positive initialBudget are required"}
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.budgets.allocate(AllocateBudgetParams(grant_id="", initial_budget=0))
    assert exc_info.value.status_code == 400


# ═══════════════════════════════════════════════════════════════════════════
# 401 Unauthorized
# ═══════════════════════════════════════════════════════════════════════════

@respx.mock
def test_401_raises_auth_error(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/agents").mock(
        return_value=httpx.Response(
            401, json={"code": "UNAUTHORIZED", "message": "Invalid API key"}
        )
    )
    with pytest.raises(GrantexAuthError) as exc_info:
        client.agents.list()
    assert exc_info.value.status_code == 401
    assert isinstance(exc_info.value, GrantexApiError)  # subclass check


@respx.mock
def test_401_on_grants_list(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/grants").mock(
        return_value=httpx.Response(
            401, json={"code": "UNAUTHORIZED", "message": "API key expired"}
        )
    )
    with pytest.raises(GrantexAuthError) as exc_info:
        client.grants.list()
    assert exc_info.value.status_code == 401


@respx.mock
def test_401_on_compliance_summary(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/compliance/summary").mock(
        return_value=httpx.Response(
            401, json={"code": "UNAUTHORIZED", "message": "Authentication required"}
        )
    )
    with pytest.raises(GrantexAuthError):
        client.compliance.get_summary()


@respx.mock
def test_401_on_usage(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/usage").mock(
        return_value=httpx.Response(
            401, json={"code": "UNAUTHORIZED", "message": "Invalid API key"}
        )
    )
    with pytest.raises(GrantexAuthError):
        client.usage.current()


# ═══════════════════════════════════════════════════════════════════════════
# 403 Forbidden
# ═══════════════════════════════════════════════════════════════════════════

@respx.mock
def test_403_raises_auth_error(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/agents").mock(
        return_value=httpx.Response(
            403, json={"code": "FORBIDDEN", "message": "Insufficient permissions"}
        )
    )
    with pytest.raises(GrantexAuthError) as exc_info:
        client.agents.list()
    assert exc_info.value.status_code == 403


@respx.mock
def test_403_on_vault(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/vault/credentials").mock(
        return_value=httpx.Response(
            403, json={"code": "FORBIDDEN", "message": "Access denied"}
        )
    )
    with pytest.raises(GrantexAuthError):
        client.vault.list()


# ═══════════════════════════════════════════════════════════════════════════
# 404 Not Found
# ═══════════════════════════════════════════════════════════════════════════

@respx.mock
def test_404_raises_api_error_on_agent_get(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/agents/nonexistent").mock(
        return_value=httpx.Response(
            404, json={"code": "NOT_FOUND", "message": "Agent not found"}
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.agents.get("nonexistent")
    assert exc_info.value.status_code == 404
    assert exc_info.value.code == "NOT_FOUND"


@respx.mock
def test_404_on_grant_get(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/grants/nonexistent").mock(
        return_value=httpx.Response(
            404, json={"code": "NOT_FOUND", "message": "Grant not found"}
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.grants.get("nonexistent")
    assert exc_info.value.status_code == 404


@respx.mock
def test_404_on_vault_get(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/vault/credentials/vault_nonexistent").mock(
        return_value=httpx.Response(
            404, json={"code": "NOT_FOUND", "message": "Credential not found"}
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.vault.get("vault_nonexistent")
    assert exc_info.value.status_code == 404


@respx.mock
def test_404_on_webhook_delete(client: Grantex) -> None:
    respx.delete(f"{BASE_URL}/v1/webhooks/wh_nonexistent").mock(
        return_value=httpx.Response(
            404, json={"code": "NOT_FOUND", "message": "Webhook not found"}
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.webhooks.delete("wh_nonexistent")
    assert exc_info.value.status_code == 404


@respx.mock
def test_404_on_domain_delete(client: Grantex) -> None:
    from grantex.resources._domains import CreateDomainParams

    respx.delete(f"{BASE_URL}/v1/domains/dom_nonexistent").mock(
        return_value=httpx.Response(
            404, json={"code": "NOT_FOUND", "message": "Domain not found"}
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.domains.delete("dom_nonexistent")
    assert exc_info.value.status_code == 404


@respx.mock
def test_404_on_budget_balance(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/budget/balance/grnt_nonexistent").mock(
        return_value=httpx.Response(
            404, json={"code": "NOT_FOUND", "message": "No budget allocation found for this grant"}
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.budgets.balance("grnt_nonexistent")
    assert exc_info.value.status_code == 404


# ═══════════════════════════════════════════════════════════════════════════
# 402 Payment Required (Plan Limits)
# ═══════════════════════════════════════════════════════════════════════════

@respx.mock
def test_402_on_budget_debit_insufficient(client: Grantex) -> None:
    from grantex import DebitBudgetParams

    respx.post(f"{BASE_URL}/v1/budget/debit").mock(
        return_value=httpx.Response(
            402, json={"code": "INSUFFICIENT_BUDGET", "message": "Insufficient budget"}
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.budgets.debit(DebitBudgetParams(grant_id="grnt_01", amount=9999))
    assert exc_info.value.status_code == 402
    assert exc_info.value.code == "INSUFFICIENT_BUDGET"


@respx.mock
def test_402_on_domain_create_plan_limit(client: Grantex) -> None:
    from grantex.resources._domains import CreateDomainParams

    respx.post(f"{BASE_URL}/v1/domains").mock(
        return_value=httpx.Response(
            402, json={"code": "PLAN_LIMIT_EXCEEDED", "message": "Custom domains require Enterprise plan"}
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.domains.create(CreateDomainParams(domain="paid.example.com"))
    assert exc_info.value.status_code == 402
    assert exc_info.value.code == "PLAN_LIMIT_EXCEEDED"


# ═══════════════════════════════════════════════════════════════════════════
# 429 Too Many Requests
# ═══════════════════════════════════════════════════════════════════════════

@respx.mock
def test_429_includes_rate_limit_info(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/agents").mock(
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
    assert exc_info.value.rate_limit.reset == 1700000000


@respx.mock
def test_429_on_token_verify(client: Grantex) -> None:
    respx.post(f"{BASE_URL}/v1/tokens/verify").mock(
        return_value=httpx.Response(
            429,
            json={"code": "RATE_LIMITED", "message": "Rate limit exceeded"},
            headers={
                "x-ratelimit-limit": "50",
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": "1700000099",
                "retry-after": "30",
            },
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.tokens.verify("some.jwt.token")
    assert exc_info.value.status_code == 429
    assert exc_info.value.rate_limit is not None
    assert exc_info.value.rate_limit.limit == 50
    assert exc_info.value.rate_limit.retry_after == 30


@respx.mock
def test_429_without_retry_after(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/agents").mock(
        return_value=httpx.Response(
            429,
            json={"code": "RATE_LIMITED", "message": "Slow down"},
            headers={
                "x-ratelimit-limit": "100",
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": "1700000000",
            },
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.agents.list()
    assert exc_info.value.rate_limit is not None
    assert exc_info.value.rate_limit.retry_after is None


# ═══════════════════════════════════════════════════════════════════════════
# 500 Internal Server Error
# ═══════════════════════════════════════════════════════════════════════════

@respx.mock
def test_500_raises_api_error(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/agents").mock(
        return_value=httpx.Response(
            500, json={"code": "INTERNAL_ERROR", "message": "Internal server error"}
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.agents.list()
    assert exc_info.value.status_code == 500


@respx.mock
def test_500_on_audit_list(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/audit/entries").mock(
        return_value=httpx.Response(
            500, json={"code": "INTERNAL_ERROR", "message": "Database error"}
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.audit.list()
    assert exc_info.value.status_code == 500


@respx.mock
def test_500_on_domains_list(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/domains").mock(
        return_value=httpx.Response(
            500, json={"code": "INTERNAL_ERROR", "message": "Unexpected failure"}
        )
    )
    with pytest.raises(GrantexApiError):
        client.domains.list()


# ═══════════════════════════════════════════════════════════════════════════
# Malformed & Edge Case Responses
# ═══════════════════════════════════════════════════════════════════════════

@respx.mock
def test_malformed_json_error_response(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/agents").mock(
        return_value=httpx.Response(502, text="Bad Gateway")
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.agents.list()
    assert exc_info.value.status_code == 502


@respx.mock
def test_503_service_unavailable(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/agents").mock(
        return_value=httpx.Response(503, text="Service Unavailable")
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.agents.list()
    assert exc_info.value.status_code == 503


@respx.mock
def test_error_with_empty_body(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/agents").mock(
        return_value=httpx.Response(500, text="")
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.agents.list()
    assert exc_info.value.status_code == 500


@respx.mock
def test_error_without_code_field(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/agents").mock(
        return_value=httpx.Response(
            400, json={"message": "Something went wrong"}
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.agents.list()
    assert exc_info.value.code is None
    assert "Something went wrong" in str(exc_info.value)


@respx.mock
def test_error_with_error_key_instead_of_message(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/agents").mock(
        return_value=httpx.Response(
            400, json={"error": "Bad input"}
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.agents.list()
    assert "Bad input" in str(exc_info.value)


@respx.mock
def test_error_with_numeric_code(client: Grantex) -> None:
    """Numeric error codes should not crash the parser."""
    respx.get(f"{BASE_URL}/v1/agents").mock(
        return_value=httpx.Response(
            400, json={"code": 12345, "message": "Numeric code"}
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.agents.list()
    # Non-string codes should be returned as None (per _extract_error_code)
    assert exc_info.value.code is None


# ═══════════════════════════════════════════════════════════════════════════
# Request ID Propagation
# ═══════════════════════════════════════════════════════════════════════════

@respx.mock
def test_request_id_in_error(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/agents").mock(
        return_value=httpx.Response(
            500,
            json={"code": "INTERNAL_ERROR", "message": "fail"},
            headers={"x-request-id": "req_12345"},
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.agents.list()
    assert exc_info.value.request_id == "req_12345"


@respx.mock
def test_request_id_absent_is_none(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/agents").mock(
        return_value=httpx.Response(
            500, json={"code": "INTERNAL_ERROR", "message": "fail"}
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.agents.list()
    assert exc_info.value.request_id is None


@respx.mock
def test_request_id_on_404(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/agents/ag_missing").mock(
        return_value=httpx.Response(
            404,
            json={"code": "NOT_FOUND", "message": "Not found"},
            headers={"x-request-id": "req_67890"},
        )
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.agents.get("ag_missing")
    assert exc_info.value.request_id == "req_67890"


# ═══════════════════════════════════════════════════════════════════════════
# Network Errors
# ═══════════════════════════════════════════════════════════════════════════

@respx.mock
def test_network_timeout_raises_network_error(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/agents").mock(
        side_effect=httpx.ReadTimeout("Connection timed out")
    )
    with pytest.raises(GrantexNetworkError) as exc_info:
        client.agents.list()
    assert "timed out" in str(exc_info.value).lower()
    assert exc_info.value.cause is not None


@respx.mock
def test_connection_error_raises_network_error(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/agents").mock(
        side_effect=httpx.ConnectError("Connection refused")
    )
    with pytest.raises(GrantexNetworkError):
        client.agents.list()


@respx.mock
def test_connect_timeout_raises_network_error(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/agents").mock(
        side_effect=httpx.ConnectTimeout("Connect timed out")
    )
    with pytest.raises(GrantexNetworkError) as exc_info:
        client.agents.list()
    assert exc_info.value.cause is not None


@respx.mock
def test_write_timeout_raises_network_error(client: Grantex) -> None:
    respx.post(f"{BASE_URL}/v1/audit/log").mock(
        side_effect=httpx.WriteTimeout("Write timed out")
    )
    from grantex import LogAuditParams

    with pytest.raises(GrantexNetworkError):
        client.audit.log(
            agent_id="ag_01",
            agent_did="did:grantex:ag_01",
            grant_id="grnt_01",
            principal_id="user_01",
            action="test",
        )


# ═══════════════════════════════════════════════════════════════════════════
# Error body preservation
# ═══════════════════════════════════════════════════════════════════════════

@respx.mock
def test_error_body_preserved(client: Grantex) -> None:
    error_body = {"code": "CUSTOM", "message": "Custom error", "details": {"field": "name"}}
    respx.get(f"{BASE_URL}/v1/agents").mock(
        return_value=httpx.Response(400, json=error_body)
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.agents.list()
    assert exc_info.value.body == error_body
    assert exc_info.value.body["details"]["field"] == "name"


@respx.mock
def test_error_body_text_when_not_json(client: Grantex) -> None:
    respx.get(f"{BASE_URL}/v1/agents").mock(
        return_value=httpx.Response(500, text="Plain text error")
    )
    with pytest.raises(GrantexApiError) as exc_info:
        client.agents.list()
    assert exc_info.value.body == "Plain text error"
