from __future__ import annotations

from typing import Any

import httpx

from ._errors import GrantexApiError, GrantexAuthError, GrantexNetworkError

_SDK_VERSION = "0.1.0"
_DEFAULT_TIMEOUT = 30.0


class HttpClient:
    """Thin wrapper around httpx.Client with Grantex authentication."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        timeout: float = _DEFAULT_TIMEOUT,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._client = httpx.Client(
            headers={
                "Authorization": f"Bearer {api_key}",
                "User-Agent": f"grantex-python/{_SDK_VERSION}",
                "Accept": "application/json",
            },
            timeout=timeout,
        )

    def get(self, path: str) -> Any:
        return self._request("GET", path)

    def post(self, path: str, body: Any = None) -> Any:
        return self._request("POST", path, body=body)

    def put(self, path: str, body: Any = None) -> Any:
        return self._request("PUT", path, body=body)

    def patch(self, path: str, body: Any = None) -> Any:
        return self._request("PATCH", path, body=body)

    def delete(self, path: str) -> Any:
        return self._request("DELETE", path)

    def _request(self, method: str, path: str, body: Any = None) -> Any:
        url = f"{self._base_url}{path}"
        kwargs: dict[str, Any] = {}
        if body is not None:
            kwargs["json"] = body

        try:
            response = self._client.request(method, url, **kwargs)
        except httpx.TimeoutException as exc:
            raise GrantexNetworkError(
                f"Request timed out: {exc}", cause=exc
            ) from exc
        except httpx.RequestError as exc:
            raise GrantexNetworkError(
                f"Network error: {exc}", cause=exc
            ) from exc

        request_id: str | None = response.headers.get("x-request-id")

        if not response.is_success:
            body_data: Any = None
            try:
                body_data = response.json()
            except Exception:
                body_data = response.text or None

            message = _extract_error_message(body_data, response.status_code)

            if response.status_code in (401, 403):
                raise GrantexAuthError(
                    message, response.status_code, body_data, request_id
                )
            raise GrantexApiError(
                message, response.status_code, body_data, request_id
            )

        if response.status_code == 204:
            return None

        return response.json()

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> HttpClient:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


def _extract_error_message(body: Any, status: int) -> str:
    if isinstance(body, dict):
        if isinstance(body.get("message"), str):
            return str(body["message"])
        if isinstance(body.get("error"), str):
            return str(body["error"])
    return f"HTTP {status}"
