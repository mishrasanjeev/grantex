from __future__ import annotations

from typing import List

from .._http import HttpClient
from .._types import (
    CreateWebhookParams,
    ListWebhooksResponse,
    WebhookEndpointWithSecret,
)


class WebhooksClient:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def create(self, *, url: str, events: List[str]) -> WebhookEndpointWithSecret:
        params = CreateWebhookParams(url=url, events=events)
        data = self._http.post("/v1/webhooks", params.to_dict())
        return WebhookEndpointWithSecret.from_dict(data)

    def list(self) -> ListWebhooksResponse:
        data = self._http.get("/v1/webhooks")
        return ListWebhooksResponse.from_dict(data)

    def delete(self, webhook_id: str) -> None:
        self._http.delete(f"/v1/webhooks/{webhook_id}")
