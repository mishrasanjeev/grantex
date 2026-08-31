from __future__ import annotations

from time import monotonic
from uuid import uuid4

from .._http import HttpClient
from .._types import ExchangeTokenParams, ExchangeTokenResponse, RefreshTokenParams, VerifyTokenResponse


class TokensClient:
    def __init__(self, http: HttpClient) -> None:
        self._http = http
        self._refresh_retry_keys: dict[str, tuple[str, float]] = {}

    def exchange(self, params: ExchangeTokenParams) -> ExchangeTokenResponse:
        data = self._http.post("/v1/token", params.to_dict())
        return ExchangeTokenResponse.from_dict(data)

    def refresh(self, params: RefreshTokenParams) -> ExchangeTokenResponse:
        now = monotonic()
        self._refresh_retry_keys = {
            token: retry
            for token, retry in self._refresh_retry_keys.items()
            if retry[1] > now
        }
        cached = self._refresh_retry_keys.get(params.refresh_token)
        idempotency_key = params.idempotency_key or (cached[0] if cached else str(uuid4()))
        self._refresh_retry_keys[params.refresh_token] = (idempotency_key, now + 300.0)
        data = self._http.post(
            "/v1/token/refresh",
            params.to_dict(),
            headers={"Idempotency-Key": idempotency_key},
        )
        self._refresh_retry_keys.pop(params.refresh_token, None)
        return ExchangeTokenResponse.from_dict(data)

    def verify(self, token: str) -> VerifyTokenResponse:
        data = self._http.post("/v1/tokens/verify", {"token": token})
        return VerifyTokenResponse.from_dict(data)

    def revoke(self, token_id: str) -> None:
        self._http.post("/v1/tokens/revoke", {"jti": token_id})
        return None
