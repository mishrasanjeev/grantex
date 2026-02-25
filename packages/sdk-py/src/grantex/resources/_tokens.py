from __future__ import annotations

from .._http import HttpClient
from .._types import VerifyTokenResponse


class TokensClient:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def verify(self, token: str) -> VerifyTokenResponse:
        data = self._http.post("/v1/tokens/verify", {"token": token})
        return VerifyTokenResponse.from_dict(data)

    def revoke(self, token_id: str) -> None:
        self._http.post("/v1/tokens/revoke", {"jti": token_id})
        return None
