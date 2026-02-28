from __future__ import annotations

from typing import Literal

ErrorCode = Literal[
    "TOKEN_MISSING",
    "TOKEN_INVALID",
    "TOKEN_EXPIRED",
    "SCOPE_INSUFFICIENT",
]


class GrantexFastAPIError(Exception):
    """Raised when grant token verification or scope checking fails."""

    def __init__(self, code: ErrorCode, message: str, status_code: int) -> None:
        super().__init__(message)
        self.code: ErrorCode = code
        self.status_code = status_code
