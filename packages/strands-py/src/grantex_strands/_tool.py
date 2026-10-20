"""Wrap a Python callable as a Strands tool that runs only under a Grantex grant.

Two checks are available:

* verified (the default) verifies the grant token signature and issuer
  against JWKS with :func:`grantex.verify_grant_token` and requires
  ``required_scope`` in the verified scopes. It does not consult current
  revocation state.
* online (``online=True``) asks the Grantex service through
  ``client.enforce(token, connector, tool_name)``, which verifies the token
  and evaluates the connector manifest. When the tool is bound to a principal,
  agent or authority callback, the verified check runs as well.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from grantex import (
    GrantexTokenError,
    VerifiedGrant,
    VerifyGrantTokenOptions,
    verify_grant_token,
)

from ._jwt import decode_jwt_payload

DEFAULT_JWKS_URI = "https://api.grantex.dev/.well-known/jwks.json"


def _result_field(result: Any, key: str, missing: Any = None) -> Any:
    """Read ``key`` from an ``enforce()`` result, whether object- or dict-shaped."""
    if hasattr(result, key):
        return getattr(result, key)
    return result.get(key, missing)


class _GrantCheck:
    """Holds everything needed to decide whether the tool may run."""

    def __init__(
        self,
        *,
        tool_name: str,
        grant_token: str,
        required_scope: str,
        options: VerifyGrantTokenOptions,
        online: bool,
        client: Any,
        connector: str | None,
        audience: str | None,
        bound: bool,
    ) -> None:
        self.tool_name = tool_name
        self.grant_token = grant_token
        self.required_scope = required_scope
        self.options = options
        self.online = online
        self.client = client
        self.connector = connector
        self.audience = audience
        self.bound = bound

    def verified_scope(self) -> None:
        """Verify the token locally and require the tool's scope."""
        try:
            grant = verify_grant_token(self.grant_token, self.options)
        except GrantexTokenError as exc:
            raise ValueError(f"Could not verify grant_token: {exc}") from exc
        granted = list(grant.scopes)
        if self.required_scope not in granted:
            raise PermissionError(
                f"Grant token is missing required scope '{self.required_scope}'. "
                f"Granted scopes: {granted}"
            )

    def service_decision(self) -> None:
        """Ask the Grantex service; anything but a literal ``True`` refuses."""
        # Forward an audience only when the tool names one, so clients that
        # predate the audience keyword receive the same three-argument call.
        extra: dict[str, Any] = {} if self.audience is None else {"audience": self.audience}
        result = self.client.enforce(self.grant_token, self.connector, self.tool_name, **extra)
        if _result_field(result, "allowed") is True:
            return
        reason = _result_field(result, "reason", "")
        raise PermissionError(
            f"Grant token scope check failed for tool '{self.tool_name}' on "
            f"connector '{self.connector}': {reason}"
        )

    def when_created(self) -> None:
        if self.online and not self.bound:
            self.service_decision()
            return
        # A bound online tool is only verified here: building a tool is not a
        # use of it, so no cap is reserved and no decision grant is consumed.
        self.verified_scope()

    def before_each_call(self) -> None:
        if not self.online:
            self.verified_scope()
            return
        if self.bound:
            self.verified_scope()
        self.service_decision()


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
    current_authority: Callable[[str], VerifiedGrant] | None = None,
    expected_principal_id: str | None = None,
    expected_agent_did: str | None = None,
) -> Any:
    """Return a Strands tool that calls ``func`` only while the grant allows it.

    The check runs once when the tool is built, so a token without
    ``required_scope`` fails immediately, and again before every call.

    Verified mode (the default)::

        invoices = create_grantex_tool(
            name="list_invoices",
            description="List open invoices for a customer.",
            grant_token=agent_grant,
            required_scope="invoices:read",
            func=lambda customer_id: lookup_invoices(customer_id),
        )

    Online mode, decided by the Grantex service::

        invoices = create_grantex_tool(
            name="list_invoices",
            description="List open invoices for a customer.",
            grant_token=agent_grant,
            required_scope="tool:billing:read",
            func=lambda customer_id: lookup_invoices(customer_id),
            online=True,
            client=gx,
            connector="billing",
        )

    Args:
        name: Tool name shown to the agent; also the tool name sent to ``enforce()``.
        description: Tool description shown to the agent.
        grant_token: Grantex grant token (a JWT).
        required_scope: Scope the verified token must carry.
        func: Called with the tool's keyword arguments once the check passes.
        client: ``Grantex`` client; required when ``online`` is true.
        connector: Connector name for the manifest lookup; required when
            ``online`` is true.
        online: Use ``client.enforce()`` for the decision.
        jwks_uri, issuer, issuer_did, clock_tolerance: Passed to
            :func:`grantex.verify_grant_token`.
        audience: Audience the token must name. Checked by local verification
            and forwarded to ``enforce()`` as its ``audience`` keyword.
        current_authority, expected_principal_id, expected_agent_did: Bind the
            tool to a live authority check, a principal or an agent. Any of
            them makes an online tool verify locally as well.

    Raises:
        PermissionError: the scope is missing or the service refused.
        ValueError: the token cannot be verified, or online mode lacks
            ``client`` or ``connector``.
    """
    from strands import tool as strands_tool

    options = VerifyGrantTokenOptions(
        jwks_uri=jwks_uri,
        issuer=issuer,
        issuer_did=issuer_did,
        audience=audience,
        clock_tolerance=clock_tolerance,
        current_authority=current_authority,
        expected_principal_id=expected_principal_id,
        expected_agent_did=expected_agent_did,
    )
    bindings = (current_authority, expected_principal_id, expected_agent_did)
    check = _GrantCheck(
        tool_name=name,
        grant_token=grant_token,
        required_scope=required_scope,
        options=options,
        online=online,
        client=client,
        connector=connector,
        audience=audience,
        bound=any(binding is not None for binding in bindings),
    )

    if online and client is None:
        raise ValueError("online=True requires a 'client' (Grantex instance)")
    if online and connector is None:
        raise ValueError("online=True requires a 'connector' name")

    check.when_created()

    def guarded(**kwargs: Any) -> str:
        check.before_each_call()
        return func(**kwargs)

    # Strands reads the tool name and description from the function itself.
    guarded.__name__ = name
    guarded.__doc__ = description
    return strands_tool(guarded)


def get_tool_scopes(grant_token: str) -> list[str]:
    """List the ``scp`` claim of ``grant_token`` without verifying it.

    Returns an empty list when the token cannot be read or ``scp`` is not a list.
    """
    try:
        scopes = decode_jwt_payload(grant_token).get("scp", [])
    except Exception:
        return []
    return scopes if isinstance(scopes, list) else []
