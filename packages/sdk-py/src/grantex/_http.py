from __future__ import annotations

import random
import time
from typing import Any

import httpx

from ._errors import GrantexApiError, GrantexAuthError, GrantexNetworkError
from ._types import RateLimit

_SDK_VERSION = "0.1.0"
_DEFAULT_TIMEOUT = 30.0
_DEFAULT_MAX_RETRIES = 3
_RETRY_BASE_DELAY = 0.5  # seconds
_RETRY_MAX_DELAY = 10.0  # seconds
_RETRYABLE_STATUS_CODES = frozenset({429, 502, 503, 504})


def _parse_rate_limit_headers(headers: httpx.Headers) -> RateLimit | None:
    limit = headers.get("x-ratelimit-limit")
    remaining = headers.get("x-ratelimit-remaining")
    reset = headers.get("x-ratelimit-reset")

    if limit is None or remaining is None or reset is None:
        return None

    retry_after_raw = headers.get("retry-after")
    return RateLimit(
        limit=int(limit),
        remaining=int(remaining),
        reset=int(reset),
        retry_after=int(retry_after_raw) if retry_after_raw is not None else None,
    )


class HttpClient:
    """Thin wrapper around httpx.Client with Grantex authentication."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        timeout: float = _DEFAULT_TIMEOUT,
        max_retries: int = _DEFAULT_MAX_RETRIES,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._last_rate_limit: RateLimit | None = None
        self._max_retries = max_retries
        self._client = httpx.Client(
            headers={
                "Authorization": f"Bearer {api_key}",
                "User-Agent": f"grantex-python/{_SDK_VERSION}",
                "Accept": "application/json",
            },
            timeout=timeout,
        )

    @property
    def last_rate_limit(self) -> RateLimit | None:
        return self._last_rate_limit

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

        last_error: Exception | None = None

        for attempt in range(self._max_retries + 1):
            if attempt > 0:
                time.sleep(self._retry_delay(attempt - 1))

            try:
                response = self._client.request(method, url, **kwargs)
            except httpx.TimeoutException as exc:
                last_error = GrantexNetworkError(
                    f"Request timed out: {exc}", cause=exc
                )
                if attempt < self._max_retries:
                    continue
                raise last_error from exc
            except httpx.RequestError as exc:
                last_error = GrantexNetworkError(
                    f"Network error: {exc}", cause=exc
                )
                if attempt < self._max_retries:
                    continue
                raise last_error from exc

            request_id: str | None = response.headers.get("x-request-id")
            self._last_rate_limit = _parse_rate_limit_headers(response.headers)

            if not response.is_success:
                body_data: Any = None
                try:
                    body_data = response.json()
                except Exception:
                    body_data = response.text or None

                # Retry on transient status codes
                if response.status_code in _RETRYABLE_STATUS_CODES and attempt < self._max_retries:
                    retry_after = _parse_retry_after(response.headers)
                    if retry_after is not None:
                        self._pending_retry_after = retry_after
                    continue

                message = _extract_error_message(body_data, response.status_code)
                error_code = _extract_error_code(body_data)

                if response.status_code in (401, 403):
                    raise GrantexAuthError(
                        message, response.status_code, body_data, request_id, error_code,
                        self._last_rate_limit,
                    )
                raise GrantexApiError(
                    message, response.status_code, body_data, request_id, error_code,
                    self._last_rate_limit,
                )

            if response.status_code == 204:
                return None

            return response.json()

        # Should not reach here, but satisfy type checkers
        if last_error is not None:
            raise last_error
        return None  # pragma: no cover

    _pending_retry_after: float | None = None

    def _retry_delay(self, attempt: int) -> float:
        """Calculate retry delay with exponential backoff and jitter."""
        # If a Retry-After header was parsed, use it
        if self._pending_retry_after is not None:
            delay = self._pending_retry_after
            self._pending_retry_after = None
            return min(delay, _RETRY_MAX_DELAY)
        # Exponential backoff with jitter
        exponential = _RETRY_BASE_DELAY * (2 ** attempt)
        jitter = random.random() * _RETRY_BASE_DELAY
        return float(min(exponential + jitter, _RETRY_MAX_DELAY))

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> HttpClient:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


def _parse_retry_after(headers: httpx.Headers) -> float | None:
    """Parse Retry-After header value into seconds."""
    value = headers.get("retry-after")
    if value is None:
        return None
    try:
        return float(value)
    except ValueError:
        pass
    # Try parsing as HTTP-date (RFC 7231)
    from email.utils import parsedate_to_datetime
    try:
        dt = parsedate_to_datetime(value)
        delta = dt.timestamp() - time.time()
        return max(0.0, delta)
    except (ValueError, TypeError):
        return None


def _extract_error_code(body: Any) -> str | None:
    if isinstance(body, dict) and isinstance(body.get("code"), str):
        return str(body["code"])
    return None


def _extract_error_message(body: Any, status: int) -> str:
    if isinstance(body, dict):
        if isinstance(body.get("message"), str):
            return str(body["message"])
        if isinstance(body.get("error"), str):
            return str(body["error"])
    return f"HTTP {status}"
