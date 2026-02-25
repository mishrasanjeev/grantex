from __future__ import annotations

from urllib.parse import urlencode

from .._http import HttpClient
from .._types import AuditEntry, ListAuditParams, ListAuditResponse, LogAuditParams
from typing import Any


class AuditClient:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def log(
        self,
        *,
        agent_id: str,
        grant_id: str,
        action: str,
        metadata: dict[str, Any] | None = None,
    ) -> AuditEntry:
        params = LogAuditParams(
            agent_id=agent_id,
            grant_id=grant_id,
            action=action,
            metadata=metadata,
        )
        data = self._http.post("/v1/audit", params.to_dict())
        return AuditEntry.from_dict(data)

    def list(self, params: ListAuditParams | None = None) -> ListAuditResponse:
        qs = _build_query(params.to_dict() if params else {})
        path = f"/v1/audit?{qs}" if qs else "/v1/audit"
        data = self._http.get(path)
        return ListAuditResponse.from_dict(data)

    def get(self, entry_id: str) -> AuditEntry:
        data = self._http.get(f"/v1/audit/{entry_id}")
        return AuditEntry.from_dict(data)


def _build_query(params: dict[str, object]) -> str:
    filtered = {k: v for k, v in params.items() if v is not None}
    if not filtered:
        return ""
    return urlencode(filtered)
