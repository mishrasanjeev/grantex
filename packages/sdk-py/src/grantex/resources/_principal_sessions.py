from __future__ import annotations

from .._http import HttpClient
from .._types import CreatePrincipalSessionParams, PrincipalSessionResponse


class PrincipalSessionsClient:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def create(self, params: CreatePrincipalSessionParams) -> PrincipalSessionResponse:
        data = self._http.post("/v1/principal-sessions", params.to_dict())
        return PrincipalSessionResponse.from_dict(data)
