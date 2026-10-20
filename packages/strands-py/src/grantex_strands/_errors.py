"""Exceptions raised by grantex-strands."""

from __future__ import annotations


class GrantexStrandsError(Exception):
    """Root of the grantex-strands exception hierarchy."""


class ScopeViolationError(GrantexStrandsError):
    """A grant token does not carry the scope a tool needs.

    ``required_scope`` names the missing scope and ``granted_scopes`` lists
    what the token does carry, so callers can report both.
    """

    required_scope: str
    granted_scopes: list[str]

    def __init__(self, required_scope: str, granted_scopes: list[str]) -> None:
        text = f"Grant token is missing required scope '{required_scope}'. Granted scopes: {granted_scopes}"
        super().__init__(text)
        self.required_scope = required_scope
        self.granted_scopes = granted_scopes
