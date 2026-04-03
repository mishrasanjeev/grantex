"""Error classes for grantex-gemma."""

from __future__ import annotations


class GrantexGemmaError(Exception):
    """Base exception for all grantex-gemma errors."""


class OfflineVerificationError(GrantexGemmaError):
    """Raised when offline JWT verification fails."""


class ScopeViolationError(GrantexGemmaError):
    """Raised when a required scope is missing from the grant."""


class TokenExpiredError(GrantexGemmaError):
    """Raised when a grant token has expired."""


class BundleTamperedError(GrantexGemmaError):
    """Raised when a consent bundle has been tampered with."""


class GrantexAuthError(GrantexGemmaError):
    """Raised on authentication/authorization failures against the API."""

    def __init__(
        self,
        message: str,
        status_code: int | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code


class HashChainError(GrantexGemmaError):
    """Raised when hash chain integrity verification fails."""
