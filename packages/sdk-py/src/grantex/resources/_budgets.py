from __future__ import annotations

from typing import Any

from .._http import HttpClient
from .._types import (
    AllocateBudgetParams,
    BudgetAllocation,
    BudgetTransactionsResponse,
    DebitBudgetParams,
    DebitBudgetResponse,
)


class BudgetsClient:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def allocate(self, params: AllocateBudgetParams) -> BudgetAllocation:
        """Allocate a spending budget for a grant."""
        data = self._http.post("/v1/budget/allocate", params.to_dict())
        return BudgetAllocation.from_dict(data)

    def debit(self, params: DebitBudgetParams) -> DebitBudgetResponse:
        """Debit an amount from a grant's budget."""
        data = self._http.post("/v1/budget/debit", params.to_dict())
        return DebitBudgetResponse.from_dict(data)

    def balance(self, grant_id: str) -> BudgetAllocation:
        """Get the current budget balance for a grant."""
        data = self._http.get(f"/v1/budget/balance/{grant_id}")
        return BudgetAllocation.from_dict(data)

    def transactions(
        self,
        grant_id: str,
        page: int | None = None,
        page_size: int | None = None,
    ) -> BudgetTransactionsResponse:
        """List budget transactions for a grant.

        Args:
            grant_id: The grant to list transactions for.
            page: Page number. If omitted, the server decides the default.
            page_size: Number of items per page. If omitted, the server
                       decides the default.
        """
        params: list[str] = []
        if page is not None:
            params.append(f"page={page}")
        if page_size is not None:
            params.append(f"pageSize={page_size}")
        qs = "&".join(params)
        url = f"/v1/budget/transactions/{grant_id}{('?' + qs) if qs else ''}"
        data = self._http.get(url)
        return BudgetTransactionsResponse.from_dict(data)
