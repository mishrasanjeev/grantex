from __future__ import annotations

from .._http import HttpClient
from .._types import IntrospectTokenResponse, RevokeTokenResponse


class TokensClient:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def introspect(self, token: str) -> IntrospectTokenResponse:
        data = self._http.post("/v1/tokens/introspect", {"token": token})
        return IntrospectTokenResponse.from_dict(data)

    def revoke(self, token_id: str) -> RevokeTokenResponse:
        data = self._http.delete(f"/v1/tokens/{token_id}")
        return RevokeTokenResponse.from_dict(data)
