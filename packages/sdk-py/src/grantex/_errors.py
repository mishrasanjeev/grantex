from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ._types import RateLimit


class GrantexError(Exception):
    """Base exception for all Grantex SDK errors."""


class GrantexApiError(GrantexError):
    """Raised when the Grantex API returns a non-2xx response."""

    def __init__(
        self,
        message: str,
        status_code: int,
        body: Any = None,
        request_id: str | None = None,
        code: str | None = None,
        rate_limit: RateLimit | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.body = body
        self.request_id = request_id
        self.code = code
        self.rate_limit = rate_limit


class GrantexAuthError(GrantexApiError):
    """Raised on 401 or 403 responses."""


class GrantexTokenError(GrantexError):
    """Raised when JWT verification or decoding fails."""


class GrantexNetworkError(GrantexError):
    """Raised on network-level failures (timeout, connection error)."""

    def __init__(self, message: str, cause: BaseException | None = None) -> None:
        super().__init__(message)
        self.cause = cause
