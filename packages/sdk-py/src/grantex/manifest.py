"""Tool Manifest & Permission — scope enforcement for AI agent tool calls.

A ToolManifest declares the permission level (read/write/delete/admin)
required for each tool on a connector. The ``enforce()`` method on the
Grantex client uses loaded manifests to check whether a grant token's
scopes allow a given tool call.

Example::

    from grantex import ToolManifest, Permission

    manifest = ToolManifest(
        connector="salesforce",
        tools={
            "query": Permission.READ,
            "create_lead": Permission.WRITE,
            "delete_contact": Permission.DELETE,
        },
    )
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional


# ── Permission ──────────────────────────────────────────────────────────


class Permission:
    """Permission levels for tool operations.

    Hierarchy: ``admin > delete > write > read``

    A ``write`` scope covers ``read`` + ``write`` tools.
    A ``delete`` scope covers ``read`` + ``write`` + ``delete`` tools.
    An ``admin`` scope covers everything.
    """

    READ = "read"
    WRITE = "write"
    DELETE = "delete"
    ADMIN = "admin"

    _LEVELS: Dict[str, int] = {
        "read": 0,
        "write": 1,
        "delete": 2,
        "admin": 3,
    }

    @staticmethod
    def covers(granted: str, required: str) -> bool:
        """Check whether a granted permission level covers the required level."""
        granted_level = Permission._LEVELS.get(granted, -1)
        required_level = Permission._LEVELS.get(required, 99)
        return granted_level >= required_level

    @staticmethod
    def is_valid(value: str) -> bool:
        """Check whether a string is a valid permission level."""
        return value in Permission._LEVELS


# ── ToolManifest ────────────────────────────────────────────────────────


class ToolManifest:
    """Declares the required permission level for each tool on a connector.

    Load manifests via ``grantex.load_manifest()`` and they will be used
    automatically by ``grantex.enforce()``.
    """

    def __init__(
        self,
        connector: str,
        tools: Dict[str, str],
        version: str = "1.0.0",
        description: str = "",
    ) -> None:
        if not connector:
            raise ValueError("ToolManifest: connector name is required")
        if not tools:
            raise ValueError("ToolManifest: at least one tool is required")
        for name, perm in tools.items():
            if not Permission.is_valid(perm):
                raise ValueError(
                    f'ToolManifest: invalid permission "{perm}" for tool "{name}". '
                    f"Must be one of: {', '.join(Permission._LEVELS.keys())}"
                )

        self.connector = connector
        self.tools: Dict[str, str] = dict(tools)
        self.version = version
        self.description = description

    def get_permission(self, tool_name: str) -> Optional[str]:
        """Get the declared permission for a tool. Returns None if not found."""
        return self.tools.get(tool_name)

    def add_tool(self, tool_name: str, permission: str) -> None:
        """Add or update a tool's permission in this manifest."""
        if not Permission.is_valid(permission):
            raise ValueError(f"Invalid permission: {permission}")
        self.tools[tool_name] = permission

    @property
    def tool_count(self) -> int:
        """Number of tools in this manifest."""
        return len(self.tools)

    @classmethod
    def from_file(cls, path: str) -> "ToolManifest":
        """Load a ToolManifest from a JSON file.

        Expected shape::

            { "connector": "salesforce", "tools": { "query": "read", ... } }
        """
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return cls.from_dict(data)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ToolManifest":
        """Create a ToolManifest from a dict (e.g., parsed JSON)."""
        connector = data.get("connector")
        tools = data.get("tools")
        if not connector or not tools:
            raise ValueError('ToolManifest: missing "connector" or "tools" field')
        return cls(
            connector=str(connector),
            tools=dict(tools),
            version=str(data.get("version", "1.0.0")),
            description=str(data.get("description", "")),
        )


# ── EnforceResult ───────────────────────────────────────────────────────


@dataclass
class EnforceResult:
    """Result of a ``grantex.enforce()`` call."""

    allowed: bool
    """Whether the tool call is permitted."""

    reason: str
    """Human-readable reason if denied."""

    grant_id: str = ""
    """Grant ID from the JWT."""

    agent_did: str = ""
    """Agent DID from the JWT."""

    scopes: list[str] = field(default_factory=list)
    """All scopes from the grant token."""

    permission: str = ""
    """Resolved permission for the requested tool."""

    connector: str = ""
    """Connector name."""

    tool: str = ""
    """Tool name."""
