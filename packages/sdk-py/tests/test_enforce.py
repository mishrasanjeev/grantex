"""Tests for Grantex.enforce() scope enforcement."""
from __future__ import annotations

from unittest.mock import patch

import pytest

from grantex import Grantex, ToolManifest, Permission, EnforceResult
from grantex._errors import GrantexTokenError
from grantex._types import VerifiedGrant


# ── Helpers ──────────────────────────────────────────────────────────────────


def _make_verified_grant(
    scopes: tuple[str, ...] = ("tool:salesforce:write",),
    grant_id: str = "grnt_01HXYZ",
    agent_did: str = "did:grantex:ag_01HXYZ123abc",
) -> VerifiedGrant:
    """Create a VerifiedGrant with the given scopes."""
    return VerifiedGrant(
        token_id="tok_01HXYZ987xyz",
        grant_id=grant_id,
        principal_id="user_abc123",
        agent_did=agent_did,
        developer_id="org_test",
        scopes=scopes,
        issued_at=1709000000,
        expires_at=9999999999,
    )


def _salesforce_manifest() -> ToolManifest:
    return ToolManifest(
        connector="salesforce",
        tools={
            "query": Permission.READ,
            "create_lead": Permission.WRITE,
            "delete_contact": Permission.DELETE,
            "manage_org": Permission.ADMIN,
        },
    )


def _github_manifest() -> ToolManifest:
    return ToolManifest(
        connector="github",
        tools={
            "list_repos": Permission.READ,
            "create_issue": Permission.WRITE,
            "delete_repo": Permission.DELETE,
        },
    )


# ── Fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture()
def client() -> Grantex:
    c = Grantex(api_key="test-key")
    c.load_manifest(_salesforce_manifest())
    return c


# ── Basic allow/deny ────────────────────────────────────────────────────────


class TestEnforceBasic:
    @patch("grantex._client.verify_grant_token")
    def test_allowed_when_scope_matches(
        self, mock_verify: object, client: Grantex
    ) -> None:
        mock_verify.return_value = _make_verified_grant(  # type: ignore[attr-defined]
            scopes=("tool:salesforce:write",)
        )
        result = client.enforce("fake.jwt.token", "salesforce", "create_lead")

        assert result.allowed is True
        assert result.reason == ""
        assert result.connector == "salesforce"
        assert result.tool == "create_lead"
        assert result.permission == "write"
        assert result.grant_id == "grnt_01HXYZ"
        assert result.agent_did == "did:grantex:ag_01HXYZ123abc"

    @patch("grantex._client.verify_grant_token")
    def test_denied_when_scope_insufficient(
        self, mock_verify: object, client: Grantex
    ) -> None:
        mock_verify.return_value = _make_verified_grant(  # type: ignore[attr-defined]
            scopes=("tool:salesforce:read",)
        )
        result = client.enforce("fake.jwt.token", "salesforce", "create_lead")

        assert result.allowed is False
        assert "does not permit" in result.reason
        assert result.permission == "write"

    @patch("grantex._client.verify_grant_token")
    def test_denied_for_unknown_connector(
        self, mock_verify: object, client: Grantex
    ) -> None:
        mock_verify.return_value = _make_verified_grant(  # type: ignore[attr-defined]
            scopes=("tool:salesforce:write",)
        )
        result = client.enforce("fake.jwt.token", "unknown_connector", "some_tool")

        assert result.allowed is False
        assert "No manifest loaded" in result.reason
        assert result.connector == "unknown_connector"

    @patch("grantex._client.verify_grant_token")
    def test_denied_for_unknown_tool(
        self, mock_verify: object, client: Grantex
    ) -> None:
        mock_verify.return_value = _make_verified_grant(  # type: ignore[attr-defined]
            scopes=("tool:salesforce:write",)
        )
        result = client.enforce("fake.jwt.token", "salesforce", "nonexistent_tool")

        assert result.allowed is False
        assert "Unknown tool" in result.reason
        assert result.tool == "nonexistent_tool"


# ── Permission hierarchy ────────────────────────────────────────────────────


class TestEnforcePermissionHierarchy:
    @patch("grantex._client.verify_grant_token")
    def test_write_scope_allows_read_tool(
        self, mock_verify: object, client: Grantex
    ) -> None:
        mock_verify.return_value = _make_verified_grant(  # type: ignore[attr-defined]
            scopes=("tool:salesforce:write",)
        )
        result = client.enforce("fake.jwt.token", "salesforce", "query")

        assert result.allowed is True
        assert result.permission == "read"

    @patch("grantex._client.verify_grant_token")
    def test_read_scope_denies_write_tool(
        self, mock_verify: object, client: Grantex
    ) -> None:
        mock_verify.return_value = _make_verified_grant(  # type: ignore[attr-defined]
            scopes=("tool:salesforce:read",)
        )
        result = client.enforce("fake.jwt.token", "salesforce", "create_lead")

        assert result.allowed is False
        assert "does not permit" in result.reason

    @patch("grantex._client.verify_grant_token")
    def test_delete_scope_allows_write_tool(
        self, mock_verify: object, client: Grantex
    ) -> None:
        mock_verify.return_value = _make_verified_grant(  # type: ignore[attr-defined]
            scopes=("tool:salesforce:delete",)
        )
        result = client.enforce("fake.jwt.token", "salesforce", "create_lead")

        assert result.allowed is True

    @patch("grantex._client.verify_grant_token")
    def test_delete_scope_allows_read_tool(
        self, mock_verify: object, client: Grantex
    ) -> None:
        mock_verify.return_value = _make_verified_grant(  # type: ignore[attr-defined]
            scopes=("tool:salesforce:delete",)
        )
        result = client.enforce("fake.jwt.token", "salesforce", "query")

        assert result.allowed is True

    @patch("grantex._client.verify_grant_token")
    def test_admin_scope_allows_all_tools(
        self, mock_verify: object, client: Grantex
    ) -> None:
        mock_verify.return_value = _make_verified_grant(  # type: ignore[attr-defined]
            scopes=("tool:salesforce:admin",)
        )
        for tool in ("query", "create_lead", "delete_contact", "manage_org"):
            result = client.enforce("fake.jwt.token", "salesforce", tool)
            assert result.allowed is True, f"admin should allow {tool}"

    @patch("grantex._client.verify_grant_token")
    def test_read_scope_denies_delete_tool(
        self, mock_verify: object, client: Grantex
    ) -> None:
        mock_verify.return_value = _make_verified_grant(  # type: ignore[attr-defined]
            scopes=("tool:salesforce:read",)
        )
        result = client.enforce("fake.jwt.token", "salesforce", "delete_contact")

        assert result.allowed is False

    @patch("grantex._client.verify_grant_token")
    def test_write_scope_denies_delete_tool(
        self, mock_verify: object, client: Grantex
    ) -> None:
        mock_verify.return_value = _make_verified_grant(  # type: ignore[attr-defined]
            scopes=("tool:salesforce:write",)
        )
        result = client.enforce("fake.jwt.token", "salesforce", "delete_contact")

        assert result.allowed is False

    @patch("grantex._client.verify_grant_token")
    def test_write_scope_denies_admin_tool(
        self, mock_verify: object, client: Grantex
    ) -> None:
        mock_verify.return_value = _make_verified_grant(  # type: ignore[attr-defined]
            scopes=("tool:salesforce:write",)
        )
        result = client.enforce("fake.jwt.token", "salesforce", "manage_org")

        assert result.allowed is False

    @patch("grantex._client.verify_grant_token")
    def test_delete_scope_denies_admin_tool(
        self, mock_verify: object, client: Grantex
    ) -> None:
        mock_verify.return_value = _make_verified_grant(  # type: ignore[attr-defined]
            scopes=("tool:salesforce:delete",)
        )
        result = client.enforce("fake.jwt.token", "salesforce", "manage_org")

        assert result.allowed is False


# ── Token verification failures ─────────────────────────────────────────────


class TestEnforceTokenFailures:
    @patch("grantex._client.verify_grant_token")
    def test_denied_for_expired_token(
        self, mock_verify: object, client: Grantex
    ) -> None:
        mock_verify.side_effect = GrantexTokenError(  # type: ignore[attr-defined]
            "Grant token verification failed: Signature has expired"
        )
        result = client.enforce("expired.jwt.token", "salesforce", "query")

        assert result.allowed is False
        assert "Token verification failed" in result.reason
        assert result.grant_id == ""
        assert result.agent_did == ""

    @patch("grantex._client.verify_grant_token")
    def test_denied_for_invalid_token(
        self, mock_verify: object, client: Grantex
    ) -> None:
        mock_verify.side_effect = GrantexTokenError(  # type: ignore[attr-defined]
            "Grant token verification failed: invalid token"
        )
        result = client.enforce("garbage-token", "salesforce", "query")

        assert result.allowed is False
        assert "Token verification failed" in result.reason

    @patch("grantex._client.verify_grant_token")
    def test_denied_for_tampered_token(
        self, mock_verify: object, client: Grantex
    ) -> None:
        mock_verify.side_effect = GrantexTokenError(  # type: ignore[attr-defined]
            "Grant token verification failed: Signature verification failed"
        )
        result = client.enforce("tampered.jwt.token", "salesforce", "query")

        assert result.allowed is False
        assert "Token verification failed" in result.reason

    @patch("grantex._client.verify_grant_token")
    def test_denied_for_jwks_fetch_failure(
        self, mock_verify: object, client: Grantex
    ) -> None:
        mock_verify.side_effect = GrantexTokenError(  # type: ignore[attr-defined]
            "Failed to fetch JWKS"
        )
        result = client.enforce("some.jwt.token", "salesforce", "query")

        assert result.allowed is False
        assert "Token verification failed" in result.reason


# ── No matching scope for connector ─────────────────────────────────────────


class TestEnforceNoMatchingScope:
    @patch("grantex._client.verify_grant_token")
    def test_denied_when_scope_for_different_connector(
        self, mock_verify: object, client: Grantex
    ) -> None:
        mock_verify.return_value = _make_verified_grant(  # type: ignore[attr-defined]
            scopes=("tool:github:admin",)
        )
        result = client.enforce("fake.jwt.token", "salesforce", "query")

        assert result.allowed is False
        assert "No scope grants access" in result.reason

    @patch("grantex._client.verify_grant_token")
    def test_denied_when_scopes_empty(
        self, mock_verify: object, client: Grantex
    ) -> None:
        mock_verify.return_value = _make_verified_grant(  # type: ignore[attr-defined]
            scopes=()
        )
        result = client.enforce("fake.jwt.token", "salesforce", "query")

        assert result.allowed is False

    @patch("grantex._client.verify_grant_token")
    def test_non_tool_scopes_ignored(
        self, mock_verify: object, client: Grantex
    ) -> None:
        mock_verify.return_value = _make_verified_grant(  # type: ignore[attr-defined]
            scopes=("calendar:read", "payments:initiate:max_500")
        )
        result = client.enforce("fake.jwt.token", "salesforce", "query")

        assert result.allowed is False
        assert "No scope grants access" in result.reason


# ── Capped scope enforcement ────────────────────────────────────────────────


class TestEnforceCappedScopes:
    @patch("grantex._client.verify_grant_token")
    def test_amount_within_cap_allowed(
        self, mock_verify: object, client: Grantex
    ) -> None:
        mock_verify.return_value = _make_verified_grant(  # type: ignore[attr-defined]
            scopes=("tool:salesforce:write:capped:500",)
        )
        result = client.enforce("fake.jwt.token", "salesforce", "create_lead", amount=200)

        assert result.allowed is True

    @patch("grantex._client.verify_grant_token")
    def test_amount_exceeds_cap_denied(
        self, mock_verify: object, client: Grantex
    ) -> None:
        mock_verify.return_value = _make_verified_grant(  # type: ignore[attr-defined]
            scopes=("tool:salesforce:write:capped:500",)
        )
        result = client.enforce("fake.jwt.token", "salesforce", "create_lead", amount=750)

        assert result.allowed is False
        assert "exceeds budget cap" in result.reason
        assert "500" in result.reason

    @patch("grantex._client.verify_grant_token")
    def test_amount_exactly_at_cap_allowed(
        self, mock_verify: object, client: Grantex
    ) -> None:
        mock_verify.return_value = _make_verified_grant(  # type: ignore[attr-defined]
            scopes=("tool:salesforce:write:capped:100",)
        )
        result = client.enforce("fake.jwt.token", "salesforce", "create_lead", amount=100)

        assert result.allowed is True

    @patch("grantex._client.verify_grant_token")
    def test_no_amount_skips_cap_check(
        self, mock_verify: object, client: Grantex
    ) -> None:
        mock_verify.return_value = _make_verified_grant(  # type: ignore[attr-defined]
            scopes=("tool:salesforce:write:capped:100",)
        )
        result = client.enforce("fake.jwt.token", "salesforce", "create_lead")

        assert result.allowed is True

    @patch("grantex._client.verify_grant_token")
    def test_no_cap_in_scope_ignores_amount(
        self, mock_verify: object, client: Grantex
    ) -> None:
        mock_verify.return_value = _make_verified_grant(  # type: ignore[attr-defined]
            scopes=("tool:salesforce:write",)
        )
        result = client.enforce("fake.jwt.token", "salesforce", "create_lead", amount=999999)

        assert result.allowed is True


# ── load_manifest / load_manifests ──────────────────────────────────────────


class TestManifestLoading:
    @patch("grantex._client.verify_grant_token")
    def test_load_manifest_enables_enforcement(self, mock_verify: object) -> None:
        client = Grantex(api_key="test-key")
        mock_verify.return_value = _make_verified_grant(  # type: ignore[attr-defined]
            scopes=("tool:salesforce:write",)
        )

        # Before loading, enforcement denies (no manifest)
        result = client.enforce("fake.jwt.token", "salesforce", "query")
        assert result.allowed is False
        assert "No manifest loaded" in result.reason

        # After loading, enforcement works
        client.load_manifest(_salesforce_manifest())
        result = client.enforce("fake.jwt.token", "salesforce", "query")
        assert result.allowed is True

    @patch("grantex._client.verify_grant_token")
    def test_load_manifests_loads_multiple(self, mock_verify: object) -> None:
        client = Grantex(api_key="test-key")
        client.load_manifests([_salesforce_manifest(), _github_manifest()])

        mock_verify.return_value = _make_verified_grant(  # type: ignore[attr-defined]
            scopes=("tool:salesforce:read",)
        )
        sf_result = client.enforce("fake.jwt.token", "salesforce", "query")
        assert sf_result.allowed is True

        mock_verify.return_value = _make_verified_grant(  # type: ignore[attr-defined]
            scopes=("tool:github:write",)
        )
        gh_result = client.enforce("fake.jwt.token", "github", "create_issue")
        assert gh_result.allowed is True

    @patch("grantex._client.verify_grant_token")
    def test_load_manifest_overwrites_existing(self, mock_verify: object) -> None:
        client = Grantex(api_key="test-key")
        original = ToolManifest(
            connector="salesforce",
            tools={"query": Permission.READ},
        )
        client.load_manifest(original)

        # Now overwrite with a different manifest for the same connector
        updated = ToolManifest(
            connector="salesforce",
            tools={"export_data": Permission.ADMIN},
        )
        client.load_manifest(updated)

        mock_verify.return_value = _make_verified_grant(  # type: ignore[attr-defined]
            scopes=("tool:salesforce:admin",)
        )

        # Old tool no longer recognized
        result = client.enforce("fake.jwt.token", "salesforce", "query")
        assert result.allowed is False
        assert "Unknown tool" in result.reason

        # New tool recognized
        result = client.enforce("fake.jwt.token", "salesforce", "export_data")
        assert result.allowed is True


# ── Multiple scopes — best match ────────────────────────────────────────────


class TestEnforceMultipleScopes:
    @patch("grantex._client.verify_grant_token")
    def test_highest_permission_wins(
        self, mock_verify: object, client: Grantex
    ) -> None:
        mock_verify.return_value = _make_verified_grant(  # type: ignore[attr-defined]
            scopes=("tool:salesforce:read", "tool:salesforce:delete")
        )
        result = client.enforce("fake.jwt.token", "salesforce", "delete_contact")

        assert result.allowed is True

    @patch("grantex._client.verify_grant_token")
    def test_mixed_connector_scopes(
        self, mock_verify: object, client: Grantex
    ) -> None:
        mock_verify.return_value = _make_verified_grant(  # type: ignore[attr-defined]
            scopes=("tool:github:admin", "tool:salesforce:read")
        )
        # Read-level salesforce scope should allow read tool
        result = client.enforce("fake.jwt.token", "salesforce", "query")
        assert result.allowed is True

        # But not write tool
        result = client.enforce("fake.jwt.token", "salesforce", "create_lead")
        assert result.allowed is False


# ── agenticorg prefix scopes ────────────────────────────────────────────────


class TestEnforceAgenticorgScopes:
    @patch("grantex._client.verify_grant_token")
    def test_agenticorg_prefix_works(
        self, mock_verify: object, client: Grantex
    ) -> None:
        mock_verify.return_value = _make_verified_grant(  # type: ignore[attr-defined]
            scopes=("agenticorg:salesforce:write",)
        )
        result = client.enforce("fake.jwt.token", "salesforce", "create_lead")

        assert result.allowed is True

    @patch("grantex._client.verify_grant_token")
    def test_agenticorg_prefix_hierarchy(
        self, mock_verify: object, client: Grantex
    ) -> None:
        mock_verify.return_value = _make_verified_grant(  # type: ignore[attr-defined]
            scopes=("agenticorg:salesforce:read",)
        )
        result = client.enforce("fake.jwt.token", "salesforce", "query")
        assert result.allowed is True

        result = client.enforce("fake.jwt.token", "salesforce", "create_lead")
        assert result.allowed is False


# ── EnforceResult field population ──────────────────────────────────────────


class TestEnforceResultFields:
    @patch("grantex._client.verify_grant_token")
    def test_allowed_result_has_all_fields(
        self, mock_verify: object, client: Grantex
    ) -> None:
        mock_verify.return_value = _make_verified_grant(  # type: ignore[attr-defined]
            scopes=("tool:salesforce:write",),
            grant_id="grnt_custom",
            agent_did="did:grantex:ag_custom",
        )
        result = client.enforce("fake.jwt.token", "salesforce", "create_lead")

        assert isinstance(result, EnforceResult)
        assert result.allowed is True
        assert result.reason == ""
        assert result.grant_id == "grnt_custom"
        assert result.agent_did == "did:grantex:ag_custom"
        assert result.scopes == ("tool:salesforce:write",)
        assert result.permission == "write"
        assert result.connector == "salesforce"
        assert result.tool == "create_lead"

    @patch("grantex._client.verify_grant_token")
    def test_denied_result_preserves_context(
        self, mock_verify: object, client: Grantex
    ) -> None:
        mock_verify.return_value = _make_verified_grant(  # type: ignore[attr-defined]
            scopes=("tool:salesforce:read",),
            grant_id="grnt_denied",
            agent_did="did:grantex:ag_denied",
        )
        result = client.enforce("fake.jwt.token", "salesforce", "delete_contact")

        assert result.allowed is False
        assert result.grant_id == "grnt_denied"
        assert result.agent_did == "did:grantex:ag_denied"
        assert result.scopes == ("tool:salesforce:read",)
        assert result.connector == "salesforce"
        assert result.tool == "delete_contact"
        assert result.permission == "delete"
