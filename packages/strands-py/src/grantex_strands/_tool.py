"""Strands SDK tool with Grantex scope enforcement."""

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
    client: Any = None,
    connector: str | None = None,
    online: bool = False,
    jwks_uri: str = DEFAULT_JWKS_URI,
    issuer: str | None = None,
    issuer_did: str | None = None,
    audience: str | None = None,
    clock_tolerance: int = 0,
) -> Any:
    """Create a Strands-compatible tool with Grantex scope enforcement.

    Supports two modes:

    **Offline (default):** Decodes the JWT payload and checks the ``scp``
    claim directly. Fast, no network required. Cannot detect token
    revocation or verify signatures.

    **Online (online=True):** Uses ``client.enforce()`` which verifies the
    token signature via JWKS and checks scopes against the loaded manifest.
    Requires a ``Grantex`` client instance and a ``connector`` name.

    The scope check happens at **creation time** — if the token doesn't
    have the required scope, PermissionError is raised immediately.

    Example (offline)::

        tool = create_grantex_tool(
            name="get_balance",
            description="Get account balance.",
            grant_token=token,
            required_scope="balance:read",
            func=lambda account_id: f"Balance: $1000",
        )

    Example (online)::

        tool = create_grantex_tool(
            name="get_balance",
            description="Get account balance.",
            grant_token=token,
            required_scope="tool:banking:read",
            func=lambda account_id: f"Balance: $1000",
            client=grantex_client,
            connector="banking",
            online=True,
        )

    Args:
        name: Tool name.
        description: Tool description.
        grant_token: The Grantex grant token (JWT).
        required_scope: Scope required to use this tool.
        func: The function to execute when the tool is called.
        client: Grantex client instance (required for online mode).
        connector: Connector name for manifest lookup (required for online mode).
        online: If True, use client.enforce() for signature + scope verification.

    Raises:
        PermissionError: if the grant token does not contain the required scope.
        ValueError: if the grant token cannot be decoded (offline) or if
                    client/connector are missing (online).
    """
    from strands import tool as strands_tool

    verify_options = VerifyGrantTokenOptions(
        jwks_uri=jwks_uri,
        issuer=issuer,
        issuer_did=issuer_did,
        audience=audience,
        clock_tolerance=clock_tolerance,
    )

    def _verify_required_scope() -> None:
        if online:
            result = client.enforce(grant_token, connector, name)
            allowed = result.allowed if hasattr(result, "allowed") else result.get("allowed")
            if not allowed:
                reason = result.reason if hasattr(result, "reason") else result.get("reason", "")
                raise PermissionError(
                    f"Grant token scope check failed for tool '{name}' on "
                    f"connector '{connector}': {reason}"
                )
            return

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

    if online:
        # Online mode: use client.enforce() for full verification.
        if client is None:
            raise ValueError("online=True requires a 'client' (Grantex instance)")
        if connector is None:
            raise ValueError("online=True requires a 'connector' name")

    _verify_required_scope()

    # Wrap func so the Strands decorator sees a proper function
    def _wrapper(**kwargs: Any) -> str:
        _verify_required_scope()
        return func(**kwargs)

    _wrapper.__name__ = name
    _wrapper.__doc__ = description

    return strands_tool(_wrapper)


def get_tool_scopes(grant_token: str) -> list[str]:
    """Extract the scopes list from a grant token (offline, no verification).

    Returns an empty list if the token cannot be decoded or has no scp claim.
    """
    try:
        payload = decode_jwt_payload(grant_token)
        scp = payload.get("scp", [])
        return scp if isinstance(scp, list) else []
    except Exception:
        return []
