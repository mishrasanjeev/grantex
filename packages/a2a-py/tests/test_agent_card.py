"""Tests for agent card builder."""

from grantex_a2a._agent_card import build_grantex_agent_card
from grantex_a2a._types import GrantexAgentCardOptions


def test_minimal_card():
    card = build_grantex_agent_card(GrantexAgentCardOptions(
        name="Test Agent",
        description="A test agent",
        url="https://agent.example.com/a2a",
        jwks_uri="https://grantex.dev/.well-known/jwks.json",
        issuer="https://grantex.dev",
    ))

    assert card.name == "Test Agent"
    assert card.url == "https://agent.example.com/a2a"
    assert card.authentication is not None
    schemes = card.authentication["schemes"]
    assert len(schemes) == 1
    assert schemes[0]["scheme"] == "bearer"
    assert schemes[0]["grantexConfig"]["jwksUri"] == "https://grantex.dev/.well-known/jwks.json"


def test_full_card():
    card = build_grantex_agent_card(GrantexAgentCardOptions(
        name="Full Agent",
        description="Full agent",
        url="https://agent.example.com/a2a",
        jwks_uri="https://grantex.dev/.well-known/jwks.json",
        issuer="https://grantex.dev",
        required_scopes=["read", "write"],
        delegation_allowed=True,
        version="1.0.0",
        provider={"organization": "Acme"},
        capabilities={"streaming": True},
        skills=[{"id": "search", "name": "Search"}],
    ))

    assert card.version == "1.0.0"
    assert card.provider == {"organization": "Acme"}
    assert card.capabilities == {"streaming": True}
    assert card.skills is not None and len(card.skills) == 1
    config = card.authentication["schemes"][0]["grantexConfig"]
    assert config["requiredScopes"] == ["read", "write"]
    assert config["delegationAllowed"] is True


def test_default_modes():
    card = build_grantex_agent_card(GrantexAgentCardOptions(
        name="Test",
        description="Test",
        url="https://agent.example.com/a2a",
        jwks_uri="https://grantex.dev/.well-known/jwks.json",
        issuer="https://grantex.dev",
    ))

    assert card.default_input_modes == ["text/plain"]
    assert card.default_output_modes == ["text/plain"]


def test_optional_fields_absent():
    card = build_grantex_agent_card(GrantexAgentCardOptions(
        name="Minimal",
        description="Minimal",
        url="https://agent.example.com/a2a",
        jwks_uri="https://grantex.dev/.well-known/jwks.json",
        issuer="https://grantex.dev",
    ))

    assert card.version is None
    assert card.provider is None
    assert card.skills is None
