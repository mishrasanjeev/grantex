from __future__ import annotations

from .._http import HttpClient
from .._types import (
    GetPassportResponse,
    IssuedPassportResponse,
    IssuePassportParams,
    ListPassportsParams,
    ListPassportsResponse,
    RevokePassportResponse,
)


class PassportsClient:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def issue(self, params: IssuePassportParams) -> IssuedPassportResponse:
        data = self._http.post("/v1/passport/issue", params.to_dict())
        return IssuedPassportResponse.from_dict(data)

    def get(self, passport_id: str) -> GetPassportResponse:
        from urllib.parse import quote

        data = self._http.get(f"/v1/passport/{quote(passport_id, safe='')}")
        return GetPassportResponse.from_dict(data)

    def revoke(self, passport_id: str) -> RevokePassportResponse:
        from urllib.parse import quote

        data = self._http.post(
            f"/v1/passport/{quote(passport_id, safe='')}/revoke"
        )
        return RevokePassportResponse.from_dict(data)

    def list(
        self, params: ListPassportsParams | None = None
    ) -> ListPassportsResponse:
        path = "/v1/passports"
        if params is not None:
            query = params.to_query()
            if query:
                from urllib.parse import urlencode

                path = f"{path}?{urlencode(query)}"
        data = self._http.get(path)
        # Server returns a bare JSON array
        return ListPassportsResponse.from_list(data)
