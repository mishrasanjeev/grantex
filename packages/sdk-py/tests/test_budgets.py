"""Tests for the BudgetsClient resource."""
from __future__ import annotations

import json

import httpx
import respx

from grantex import (
    Grantex,
    AllocateBudgetParams,
    DebitBudgetParams,
)

BASE_URL = "https://api.grantex.dev"

MOCK_ALLOCATION = {
    "id": "budg_01",
    "grantId": "grant_01",
    "developerId": "dev_01",
    "initialBudget": "100.00",
    "remainingBudget": "75.50",
    "currency": "USD",
    "createdAt": "2026-03-01T00:00:00Z",
    "updatedAt": "2026-03-01T00:00:00Z",
}

MOCK_TRANSACTION = {
    "id": "tx_01",
    "grantId": "grant_01",
    "allocationId": "budg_01",
    "amount": "24.50",
    "description": "API call",
    "metadata": {"endpoint": "/v1/agents"},
    "createdAt": "2026-03-01T01:00:00Z",
}


@respx.mock
def test_allocate_budget() -> None:
    respx.post(f"{BASE_URL}/v1/budget/allocate").mock(
        return_value=httpx.Response(201, json=MOCK_ALLOCATION)
    )

    client = Grantex(api_key="test_key", base_url=BASE_URL)
    result = client.budgets.allocate(AllocateBudgetParams(
        grant_id="grant_01",
        initial_budget=100,
        currency="USD",
    ))

    assert result.id == "budg_01"
    assert result.initial_budget == "100.00"
    assert result.currency == "USD"

    request = respx.calls.last.request
    body = json.loads(request.content)
    assert body["grantId"] == "grant_01"
    assert body["initialBudget"] == 100
    assert body["currency"] == "USD"


@respx.mock
def test_allocate_budget_without_currency() -> None:
    respx.post(f"{BASE_URL}/v1/budget/allocate").mock(
        return_value=httpx.Response(201, json=MOCK_ALLOCATION)
    )

    client = Grantex(api_key="test_key", base_url=BASE_URL)
    client.budgets.allocate(AllocateBudgetParams(
        grant_id="grant_01",
        initial_budget=50,
    ))

    request = respx.calls.last.request
    body = json.loads(request.content)
    assert body["grantId"] == "grant_01"
    assert body["initialBudget"] == 50
    assert "currency" not in body


@respx.mock
def test_debit_budget() -> None:
    respx.post(f"{BASE_URL}/v1/budget/debit").mock(
        return_value=httpx.Response(200, json={
            "remaining": "75.50",
            "transactionId": "tx_01",
        })
    )

    client = Grantex(api_key="test_key", base_url=BASE_URL)
    result = client.budgets.debit(DebitBudgetParams(
        grant_id="grant_01",
        amount=24.50,
        description="API call",
        metadata={"endpoint": "/v1/agents"},
    ))

    assert result.remaining == "75.50"
    assert result.transaction_id == "tx_01"

    request = respx.calls.last.request
    body = json.loads(request.content)
    assert body["grantId"] == "grant_01"
    assert body["amount"] == 24.50
    assert body["description"] == "API call"


@respx.mock
def test_balance() -> None:
    respx.get(f"{BASE_URL}/v1/budget/balance/grant_01").mock(
        return_value=httpx.Response(200, json=MOCK_ALLOCATION)
    )

    client = Grantex(api_key="test_key", base_url=BASE_URL)
    result = client.budgets.balance("grant_01")

    assert result.grant_id == "grant_01"
    assert result.remaining_budget == "75.50"


@respx.mock
def test_transactions() -> None:
    respx.get(f"{BASE_URL}/v1/budget/transactions/grant_01").mock(
        return_value=httpx.Response(200, json={
            "transactions": [MOCK_TRANSACTION],
            "total": 1,
            "page": 1,
            "pageSize": 20,
        })
    )

    client = Grantex(api_key="test_key", base_url=BASE_URL)
    result = client.budgets.transactions("grant_01")

    assert len(result.transactions) == 1
    assert result.transactions[0].id == "tx_01"
    assert result.total == 1
    assert result.page == 1
    assert result.page_size == 20


@respx.mock
def test_transactions_with_pagination() -> None:
    respx.get(f"{BASE_URL}/v1/budget/transactions/grant_01?page=3&pageSize=10").mock(
        return_value=httpx.Response(200, json={
            "transactions": [],
            "total": 50,
            "page": 3,
            "pageSize": 10,
        })
    )

    client = Grantex(api_key="test_key", base_url=BASE_URL)
    result = client.budgets.transactions("grant_01", page=3, page_size=10)

    assert result.page == 3
    assert result.page_size == 10
    assert result.total == 50


@respx.mock
def test_debit_budget_minimal() -> None:
    respx.post(f"{BASE_URL}/v1/budget/debit").mock(
        return_value=httpx.Response(200, json={
            "remaining": "90.00",
            "transactionId": "tx_02",
        })
    )

    client = Grantex(api_key="test_key", base_url=BASE_URL)
    result = client.budgets.debit(DebitBudgetParams(
        grant_id="grant_01",
        amount=10,
    ))

    assert result.remaining == "90.00"
    assert result.transaction_id == "tx_02"

    request = respx.calls.last.request
    body = json.loads(request.content)
    assert "description" not in body
    assert "metadata" not in body
