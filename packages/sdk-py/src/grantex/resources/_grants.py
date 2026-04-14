from __future__ import annotations

from typing import Any, List
from urllib.parse import urlencode

from .._errors import GrantexTokenError
from .._http import HttpClient
from .._types import Grant, ListGrantsParams, ListGrantsResponse, VerifiedGrant, DelegateParams
from .._verify import _build_payload, _payload_to_verified_grant


class GrantsClient:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def get(self, grant_id: str) -> Grant:
        data = self._http.get(f"/v1/grants/{grant_id}")
        return Grant.from_dict(data)

    def list(self, params: ListGrantsParams | None = None) -> ListGrantsResponse:
        qs = _build_query(params.to_dict() if params else {})
        path = f"/v1/grants?{qs}" if qs else "/v1/grants"
        data = self._http.get(path)
        return ListGrantsResponse.from_dict(data)

    def revoke(self, grant_id: str) -> None:
        self._http.delete(f"/v1/grants/{grant_id}")

    def delegate(
        self,
        *,
        parent_grant_token: str,
        sub_agent_id: str,
        scopes: List[str],
        expires_in: str | None = None,
    ) -> Any:
        params = DelegateParams(
            parent_grant_token=parent_grant_token,
            sub_agent_id=sub_agent_id,
            scopes=scopes,
            expires_in=expires_in,
        )
        return self._http.post("/v1/grants/delegate", params.to_dict())

    def verify(self, token: str) -> VerifiedGrant:
        response = self._http.post("/v1/grants/verify", {"token": token})
        if not isinstance(response, dict) or not response.get("active") or not response.get("claims"):
            reason = response.get("reason") if isinstance(response, dict) else None
            suffix = f": {reason}" if reason else ""
            raise GrantexTokenError(f"Grant token is not active{suffix}")
        claims: dict[str, Any] = response["claims"]
        return _payload_to_verified_grant(_build_payload(claims))


def _build_query(params: dict[str, object]) -> str:
    filtered = {k: v for k, v in params.items() if v is not None}
    if not filtered:
        return ""
    return urlencode(filtered)
