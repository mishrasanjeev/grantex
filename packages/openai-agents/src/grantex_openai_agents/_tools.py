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
) -> Any:
    """Create an OpenAI Agents SDK tool with Grantex scope enforcement.

    Uses the ``@function_tool`` decorator from the ``agents`` package to
    register ``func`` as a tool, after verifying that the grant token
    contains the required scope.

    Raises:
        PermissionError: if the grant token does not contain the required scope.
        ImportError: if ``agents`` is not installed.
    """
    from agents import function_tool  # type: ignore[import-not-found]

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

    # Wrap func so the decorator sees a proper function with name/docstring
    def _wrapper(**kwargs: Any) -> str:
        return func(**kwargs)

    _wrapper.__name__ = name
    _wrapper.__doc__ = description

    return function_tool(_wrapper)


def get_tool_scopes(grant_token: str) -> list[str]:
    """Return the scopes embedded in a grant token (offline, no network call)."""
    payload = decode_jwt_payload(grant_token)
    scopes: list[str] = payload.get("scp", [])
    return scopes
