from __future__ import annotations

from typing import Any, Callable

from ._jwt import decode_jwt_payload


def create_grantex_tool(
    *,
    name: str,
    description: str,
    grant_token: str,
    required_scope: str,
    func: Callable[..., str],
) -> Callable[..., str]:
    """Create a Google ADK-compatible tool function with Grantex scope enforcement.

    Google ADK uses plain functions with docstrings as tools — no decorator or
    base class required. This factory verifies the grant token contains the
    required scope, then returns a wrapper function with the correct
    ``__name__`` and ``__doc__`` for ADK to discover.

    Raises:
        PermissionError: if the grant token does not contain the required scope.
    """
    # Offline scope check
    try:
        payload = decode_jwt_payload(grant_token)
    except Exception as exc:
        raise ValueError(f"Could not decode grant_token: {exc}") from exc

    scopes: list[str] = payload.get("scp", [])
    if required_scope not in scopes:
        raise PermissionError(
            f"Grant token is missing required scope '{required_scope}'. "
            f"Granted scopes: {scopes}"
        )

    def _wrapper(**kwargs: Any) -> str:
        return func(**kwargs)

    _wrapper.__name__ = name
    _wrapper.__doc__ = description
    return _wrapper


def get_tool_scopes(grant_token: str) -> list[str]:
    """Return the scopes embedded in a grant token (offline, no network call)."""
    payload = decode_jwt_payload(grant_token)
    scopes: list[str] = payload.get("scp", [])
    return scopes
