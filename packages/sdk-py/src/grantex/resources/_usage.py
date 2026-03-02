from __future__ import annotations

from typing import Any, Dict, List, Optional

from .._http import HttpClient


class UsageResponse:
    def __init__(
        self,
        developer_id: str,
        period: str,
        token_exchanges: int,
        authorizations: int,
        verifications: int,
        total_requests: int,
    ) -> None:
        self.developer_id = developer_id
        self.period = period
        self.token_exchanges = token_exchanges
        self.authorizations = authorizations
        self.verifications = verifications
        self.total_requests = total_requests

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "UsageResponse":
        return cls(
            developer_id=data["developerId"],
            period=data["period"],
            token_exchanges=data["tokenExchanges"],
            authorizations=data["authorizations"],
            verifications=data["verifications"],
            total_requests=data["totalRequests"],
        )


class UsageHistoryEntry:
    def __init__(
        self,
        date: str,
        token_exchanges: int,
        authorizations: int,
        verifications: int,
        total_requests: int,
    ) -> None:
        self.date = date
        self.token_exchanges = token_exchanges
        self.authorizations = authorizations
        self.verifications = verifications
        self.total_requests = total_requests

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "UsageHistoryEntry":
        return cls(
            date=data["date"],
            token_exchanges=data["tokenExchanges"],
            authorizations=data["authorizations"],
            verifications=data["verifications"],
            total_requests=data["totalRequests"],
        )


class UsageHistoryResponse:
    def __init__(
        self,
        developer_id: str,
        days: int,
        entries: List[UsageHistoryEntry],
    ) -> None:
        self.developer_id = developer_id
        self.days = days
        self.entries = entries

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "UsageHistoryResponse":
        return cls(
            developer_id=data["developerId"],
            days=data["days"],
            entries=[UsageHistoryEntry.from_dict(e) for e in data["entries"]],
        )


class UsageClient:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def current(self) -> UsageResponse:
        """Get current period usage (real-time)."""
        data = self._http.get("/v1/usage")
        return UsageResponse.from_dict(data)

    def history(self, days: int = 30) -> UsageHistoryResponse:
        """Get daily usage history."""
        data = self._http.get(f"/v1/usage/history?days={days}")
        return UsageHistoryResponse.from_dict(data)
