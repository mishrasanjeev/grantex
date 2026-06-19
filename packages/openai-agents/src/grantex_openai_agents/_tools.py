from __future__ import annotations

from typing import Any, Callable

from grantex import GrantexTokenError, VerifyGrantTokenOptions, verify_grant_token

from ._jwt import decode_jwt_payload

DEFAULT_JWKS_URI = "https://api.grantex.dev/.well-known/jwks.json"


def create_grantex_tool(
    *,
    name: str,
    description: str,
    grant_token: str,
    required_scope: str,
    func: Callable[..., str],
    jwks_uri: str = DEFAULT_JWKS_URI,
    issuer: str | None = None,
    issuer_did: str | None = None,
    audience: str | None = None,
    clock_tolerance: int = 0,
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

    verify_options = VerifyGrantTokenOptions(
        jwks_uri=jwks_uri,
        issuer=issuer,
        issuer_did=issuer_did,
        audience=audience,
        clock_tolerance=clock_tolerance,
    )

    def _verify_required_scope() -> None:
        try:
            grant = verify_grant_token(
                grant_token,
                verify_options,
            )
        except GrantexTokenError as exc:
            raise ValueError(f"Could not verify grant_token: {exc}") from exc
        scopes = list(grant.scopes)
        if required_scope not in scopes:
            raise PermissionError(
                f"Grant token is missing required scope '{required_scope}'. "
                f"Granted scopes: {scopes}"
            )

    _verify_required_scope()

    # Wrap func so the decorator sees a proper function with name/docstring
    def _wrapper(**kwargs: Any) -> str:
        _verify_required_scope()
        return func(**kwargs)

    _wrapper.__name__ = name
    _wrapper.__doc__ = description

    return function_tool(_wrapper)


def get_tool_scopes(grant_token: str) -> list[str]:
    """Return the scopes embedded in a grant token (offline, no network call)."""
    payload = decode_jwt_payload(grant_token)
    scopes: list[str] = payload.get("scp", [])
    return scopes
