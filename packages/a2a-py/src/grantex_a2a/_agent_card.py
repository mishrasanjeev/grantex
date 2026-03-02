"""Agent Card builder with Grantex authentication extensions."""

from __future__ import annotations

from ._types import A2AAgentCard, GrantexAgentCardOptions


def build_grantex_agent_card(options: GrantexAgentCardOptions) -> A2AAgentCard:
    """Build an A2A agent card with Grantex authentication configured.

    Args:
        options: Agent card configuration.

    Returns:
        An A2AAgentCard with Grantex auth scheme.

    Example::

        card = build_grantex_agent_card(GrantexAgentCardOptions(
            name="My Agent",
            description="An agent that does things",
            url="https://my-agent.example.com/a2a",
            jwks_uri="https://grantex.dev/.well-known/jwks.json",
            issuer="https://grantex.dev",
            required_scopes=["read", "write"],
            delegation_allowed=True,
        ))
    """
    grantex_config = {
        "jwksUri": options.jwks_uri,
        "issuer": options.issuer,
    }
    if options.required_scopes is not None:
        grantex_config["requiredScopes"] = options.required_scopes  # type: ignore[assignment]
    if options.delegation_allowed is not None:
        grantex_config["delegationAllowed"] = options.delegation_allowed  # type: ignore[assignment]

    return A2AAgentCard(
        name=options.name,
        description=options.description,
        url=options.url,
        version=options.version,
        provider=options.provider,
        capabilities=options.capabilities,
        authentication={
            "schemes": [
                {
                    "scheme": "bearer",
                    "grantexConfig": grantex_config,
                }
            ]
        },
        skills=options.skills,
    )
