"""Tests for ToolManifest, Permission, and EnforceResult."""
from __future__ import annotations

import json

import pytest

from grantex import ToolManifest, Permission, EnforceResult


# ── ToolManifest construction ────────────────────────────────────────────────


class TestToolManifestConstruction:
    def test_valid_construction(self) -> None:
        m = ToolManifest(
            connector="salesforce",
            tools={"query": Permission.READ, "create_lead": Permission.WRITE},
            version="2.0.0",
            description="Salesforce CRM",
        )
        assert m.connector == "salesforce"
        assert m.tools == {"query": "read", "create_lead": "write"}
        assert m.version == "2.0.0"
        assert m.description == "Salesforce CRM"

    def test_valid_construction_defaults(self) -> None:
        m = ToolManifest(connector="slack", tools={"send_message": Permission.WRITE})
        assert m.version == "1.0.0"
        assert m.description == ""

    def test_raises_on_empty_connector(self) -> None:
        with pytest.raises(ValueError, match="connector name is required"):
            ToolManifest(connector="", tools={"query": Permission.READ})

    def test_raises_on_empty_tools(self) -> None:
        with pytest.raises(ValueError, match="at least one tool is required"):
            ToolManifest(connector="salesforce", tools={})

    def test_raises_on_invalid_permission(self) -> None:
        with pytest.raises(ValueError, match='invalid permission "execute"'):
            ToolManifest(
                connector="salesforce",
                tools={"query": "execute"},
            )


# ── ToolManifest methods ─────────────────────────────────────────────────────


class TestToolManifestMethods:
    @pytest.fixture()
    def manifest(self) -> ToolManifest:
        return ToolManifest(
            connector="salesforce",
            tools={
                "query": Permission.READ,
                "create_lead": Permission.WRITE,
                "delete_contact": Permission.DELETE,
                "manage_org": Permission.ADMIN,
            },
        )

    def test_get_permission_returns_correct_value(self, manifest: ToolManifest) -> None:
        assert manifest.get_permission("query") == "read"
        assert manifest.get_permission("create_lead") == "write"
        assert manifest.get_permission("delete_contact") == "delete"
        assert manifest.get_permission("manage_org") == "admin"

    def test_get_permission_returns_none_for_unknown(self, manifest: ToolManifest) -> None:
        assert manifest.get_permission("nonexistent_tool") is None

    def test_add_tool_adds_new_tool(self, manifest: ToolManifest) -> None:
        assert manifest.get_permission("export_report") is None
        manifest.add_tool("export_report", Permission.READ)
        assert manifest.get_permission("export_report") == "read"

    def test_add_tool_overwrites_existing(self, manifest: ToolManifest) -> None:
        assert manifest.get_permission("query") == "read"
        manifest.add_tool("query", Permission.ADMIN)
        assert manifest.get_permission("query") == "admin"

    def test_add_tool_rejects_invalid_permission(self, manifest: ToolManifest) -> None:
        with pytest.raises(ValueError, match="Invalid permission"):
            manifest.add_tool("new_tool", "superadmin")

    def test_tool_count(self, manifest: ToolManifest) -> None:
        assert manifest.tool_count == 4

    def test_tool_count_after_add(self, manifest: ToolManifest) -> None:
        manifest.add_tool("export_report", Permission.READ)
        assert manifest.tool_count == 5

    def test_tool_count_unchanged_on_overwrite(self, manifest: ToolManifest) -> None:
        manifest.add_tool("query", Permission.ADMIN)
        assert manifest.tool_count == 4


# ── ToolManifest.from_file ───────────────────────────────────────────────────


class TestToolManifestFromFile:
    def test_from_file_loads_json(self, tmp_path: object) -> None:
        from pathlib import Path

        p = Path(str(tmp_path)) / "salesforce.json"
        p.write_text(
            json.dumps(
                {
                    "connector": "salesforce",
                    "tools": {"query": "read", "create_lead": "write"},
                    "version": "2.0.0",
                    "description": "Salesforce CRM",
                }
            ),
            encoding="utf-8",
        )
        m = ToolManifest.from_file(str(p))
        assert m.connector == "salesforce"
        assert m.tools == {"query": "read", "create_lead": "write"}
        assert m.version == "2.0.0"
        assert m.description == "Salesforce CRM"

    def test_from_file_minimal_fields(self, tmp_path: object) -> None:
        from pathlib import Path

        p = Path(str(tmp_path)) / "slack.json"
        p.write_text(
            json.dumps({"connector": "slack", "tools": {"send": "write"}}),
            encoding="utf-8",
        )
        m = ToolManifest.from_file(str(p))
        assert m.connector == "slack"
        assert m.version == "1.0.0"
        assert m.description == ""

    def test_from_file_nonexistent_raises(self) -> None:
        with pytest.raises(FileNotFoundError):
            ToolManifest.from_file("/nonexistent/path/manifest.json")


# ── ToolManifest.from_dict ───────────────────────────────────────────────────


class TestToolManifestFromDict:
    def test_from_dict_creates_manifest(self) -> None:
        m = ToolManifest.from_dict(
            {
                "connector": "hubspot",
                "tools": {"get_contact": "read", "update_deal": "write"},
                "version": "1.2.0",
                "description": "HubSpot CRM",
            }
        )
        assert m.connector == "hubspot"
        assert m.tool_count == 2
        assert m.version == "1.2.0"
        assert m.description == "HubSpot CRM"

    def test_from_dict_raises_on_missing_connector(self) -> None:
        with pytest.raises(ValueError, match='missing "connector" or "tools"'):
            ToolManifest.from_dict({"tools": {"query": "read"}})

    def test_from_dict_raises_on_missing_tools(self) -> None:
        with pytest.raises(ValueError, match='missing "connector" or "tools"'):
            ToolManifest.from_dict({"connector": "salesforce"})

    def test_from_dict_raises_on_empty_dict(self) -> None:
        with pytest.raises(ValueError, match='missing "connector" or "tools"'):
            ToolManifest.from_dict({})

    def test_from_dict_with_defaults(self) -> None:
        m = ToolManifest.from_dict(
            {"connector": "stripe", "tools": {"charge": "write"}}
        )
        assert m.version == "1.0.0"
        assert m.description == ""


# ── Permission ───────────────────────────────────────────────────────────────


class TestPermission:
    # ── covers ───────────────────────────────────────────────────────────

    def test_admin_covers_all(self) -> None:
        assert Permission.covers("admin", "read") is True
        assert Permission.covers("admin", "write") is True
        assert Permission.covers("admin", "delete") is True
        assert Permission.covers("admin", "admin") is True

    def test_delete_covers_read_write_delete(self) -> None:
        assert Permission.covers("delete", "read") is True
        assert Permission.covers("delete", "write") is True
        assert Permission.covers("delete", "delete") is True
        assert Permission.covers("delete", "admin") is False

    def test_write_covers_read_write(self) -> None:
        assert Permission.covers("write", "read") is True
        assert Permission.covers("write", "write") is True
        assert Permission.covers("write", "delete") is False
        assert Permission.covers("write", "admin") is False

    def test_read_covers_only_read(self) -> None:
        assert Permission.covers("read", "read") is True
        assert Permission.covers("read", "write") is False
        assert Permission.covers("read", "delete") is False
        assert Permission.covers("read", "admin") is False

    def test_unknown_granted_covers_nothing(self) -> None:
        assert Permission.covers("unknown", "read") is False

    def test_unknown_required_never_covered(self) -> None:
        assert Permission.covers("admin", "unknown") is False

    # ── is_valid ─────────────────────────────────────────────────────────

    def test_is_valid_returns_true_for_valid_values(self) -> None:
        assert Permission.is_valid("read") is True
        assert Permission.is_valid("write") is True
        assert Permission.is_valid("delete") is True
        assert Permission.is_valid("admin") is True

    def test_is_valid_returns_false_for_invalid_values(self) -> None:
        assert Permission.is_valid("execute") is False
        assert Permission.is_valid("ADMIN") is False
        assert Permission.is_valid("") is False
        assert Permission.is_valid("superuser") is False


# ── EnforceResult ────────────────────────────────────────────────────────────


class TestEnforceResult:
    def test_construction_with_all_fields(self) -> None:
        r = EnforceResult(
            allowed=True,
            reason="",
            grant_id="grnt_01",
            agent_did="did:grantex:ag_01",
            scopes=["tool:salesforce:write"],
            permission="write",
            connector="salesforce",
            tool="create_lead",
        )
        assert r.allowed is True
        assert r.reason == ""
        assert r.grant_id == "grnt_01"
        assert r.agent_did == "did:grantex:ag_01"
        assert r.scopes == ["tool:salesforce:write"]
        assert r.permission == "write"
        assert r.connector == "salesforce"
        assert r.tool == "create_lead"

    def test_default_values(self) -> None:
        r = EnforceResult(allowed=False, reason="denied")
        assert r.grant_id == ""
        assert r.agent_did == ""
        assert r.scopes == []
        assert r.permission == ""
        assert r.connector == ""
        assert r.tool == ""

    def test_denied_result(self) -> None:
        r = EnforceResult(
            allowed=False,
            reason="read scope does not permit write operations on salesforce.",
            connector="salesforce",
            tool="create_lead",
            permission="write",
        )
        assert r.allowed is False
        assert "read scope" in r.reason
        assert r.connector == "salesforce"
        assert r.tool == "create_lead"
