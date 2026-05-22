"""Error classes for grantex-strands."""

from __future__ import annotations


class GrantexStrandsError(Exception):
    """Base exception for all grantex-strands errors."""


class ScopeViolationError(GrantexStrandsError):
    """Raised when a required scope is missing from the grant token."""

    def __init__(self, required_scope: str, granted_scopes: list[str]) -> None:
        self.required_scope = required_scope
        self.granted_scopes = granted_scopes
        super().__init__(
            f"Grant token is missing required scope '{required_scope}'. "
            f"Granted scopes: {granted_scopes}"
        )
