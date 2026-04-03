"""Scope checking utilities."""

from __future__ import annotations

from ._errors import ScopeViolationError


def enforce_scopes(
    grant_scopes: list[str],
    required_scopes: list[str],
) -> None:
    """Ensure all required scopes are present in the grant.

    Raises ScopeViolationError if any required scope is missing.
    """
    missing = [s for s in required_scopes if s not in grant_scopes]
    if missing:
        raise ScopeViolationError(
            f"Missing required scopes: {', '.join(missing)}"
        )


def has_scope(grant_scopes: list[str], scope: str) -> bool:
    """Check whether a single scope is present in the grant."""
    return scope in grant_scopes
