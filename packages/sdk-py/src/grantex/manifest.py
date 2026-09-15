"""Tool Manifest & Permission — scope enforcement for AI agent tool calls.

A ToolManifest declares the permission level (read/write/delete/admin)
required for each tool on a connector. The ``enforce()`` method on the
Grantex client uses loaded manifests to check whether a grant token's
scopes allow a given tool call.

Since manifest schema 0.6 a tool may also be declared as an object carrying
``allowed_purposes``, ``caps``, ``cost_units``, ``requires_decision`` and
``four_eyes_on`` (see ``spec/manifest-0.6.schema.json``). Permission strings
remain valid, and both forms can appear in the same manifest.

Example::

    from grantex import ToolManifest, Permission

    manifest = ToolManifest(
        connector="acme_kyb",
        tools={
            "get_case": Permission.READ,
            "verify_business": {
                "permission": "read",
                "allowed_purposes": ["aml.cdd.*"],
                "caps": {"per_hour": 50, "per_case": 3},
            },
            "case_decision": {"permission": "write", "requires_decision": True},
        },
    )
"""

from __future__ import annotations

import json
import re
import warnings
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, Mapping, Optional, Tuple, Union

if TYPE_CHECKING:
    from .caps import Reservation


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
        return isinstance(value, str) and value in Permission._LEVELS


# ── Manifest 0.6 tool declarations ──────────────────────────────────────

MANIFEST_SCHEMA_ID = "https://grantex.dev/spec/manifest-0.6.schema.json"
"""``$id`` of the manifest 0.6 JSON Schema."""

MAX_COUNT = 2147483647
"""Largest cap or cost-unit value a manifest may declare."""

RESERVED_TOOL_NAME = "cost_units"
"""Not allowed as a tool name: grant ``caps`` use it for the cost-unit budget."""

_TOP_LEVEL_KEYS = ("$schema", "connector", "version", "description", "tools")
_TOOL_KEYS = (
    "permission",
    "allowed_purposes",
    "caps",
    "cost_units",
    "requires_decision",
    "four_eyes_on",
)
_CAP_KEYS = ("per_hour", "per_day", "per_case")

_NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}\Z")
_UNIT_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}\Z")
_SEG = r"[a-z][a-z0-9_]*"
_ORG = r"x-[a-z0-9]+(?:-[a-z0-9]+)*"
PURPOSE_PATTERN_RE = re.compile(
    rf"^(?:{_SEG}(?:\.{_SEG})*(?:\.\*)?|{_ORG}(?:(?:\.{_SEG})+(?:\.\*)?|\.\*))\Z"
)
"""Syntax of an ``allowed_purposes`` entry (a purpose or a ``prefix.*`` wildcard)."""
MAX_PURPOSE_LENGTH = 128


class ManifestValidationError(ValueError):
    """A manifest does not conform to manifest schema 0.6.

    The message names the offending path, for example
    ``ToolManifest: tools.verify_business.caps: unknown key "per_week"``.
    """


@dataclass(frozen=True)
class ToolCaps:
    """Call caps declared for a tool. ``None`` means no cap of that kind.

    ``per_hour`` and ``per_day`` are rolling windows; ``per_case`` counts calls
    made within one case. A cap of ``0`` disables the tool.
    """

    per_hour: Optional[int] = None
    per_day: Optional[int] = None
    per_case: Optional[int] = None


@dataclass(frozen=True)
class ToolSpec:
    """A tool's full declaration: its permission plus optional constraints."""

    permission: str
    allowed_purposes: Optional[Tuple[str, ...]] = None
    """Purpose patterns; ``None`` means the tool applies no purpose restriction."""
    caps: Optional[ToolCaps] = None
    cost_units: Optional[Dict[str, int]] = None
    requires_decision: bool = False
    four_eyes_on: Tuple[str, ...] = ()


ToolDeclaration = Union[str, Mapping[str, Any], ToolSpec]
"""A tool value: a permission string, a manifest 0.6 object, or a ToolSpec."""


def _q(value: Any) -> str:
    """Quote a value for an error message the same way the TypeScript SDK does."""
    try:
        return json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return repr(value)


def _fail(message: str) -> ManifestValidationError:
    return ManifestValidationError(f"ToolManifest: {message}")


def _invalid_permission(value: Any, tool: str) -> ManifestValidationError:
    return _fail(
        f"invalid permission {_q(value)} for tool {_q(tool)}. "
        f"Must be one of: {', '.join(Permission._LEVELS.keys())}"
    )


def _count(value: Any, path: str) -> int:
    if isinstance(value, bool):
        raise _fail(f"{path}: must be an integer between 0 and {MAX_COUNT}")
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if not isinstance(value, int) or value < 0 or value > MAX_COUNT:
        raise _fail(f"{path}: must be an integer between 0 and {MAX_COUNT}")
    return value


def is_valid_purpose_pattern(value: Any) -> bool:
    """Whether ``value`` is a syntactically valid ``allowed_purposes`` entry."""
    return (
        isinstance(value, str)
        and len(value) <= MAX_PURPOSE_LENGTH
        and PURPOSE_PATTERN_RE.match(value) is not None
    )


def _unique_strings(value: Any) -> bool:
    return len(set(value)) == len(value)


def _check_names(connector: Any, tools: Mapping[Any, Any]) -> None:
    if not isinstance(connector, str) or not _NAME_RE.match(connector):
        raise _fail(f"invalid connector name {_q(connector)}")
    for name in tools:
        if not isinstance(name, str) or not _NAME_RE.match(name):
            raise _fail(f"invalid tool name {_q(name)}")


def parse_tool_declaration(tool: str, value: Any) -> ToolSpec:
    """Validate one tool value (string or object form) and return its ToolSpec.

    Raises:
        ManifestValidationError: the value does not conform to manifest 0.6.
    """
    if tool == RESERVED_TOOL_NAME:
        raise _fail(
            f"tool name {_q(tool)} is reserved: it names the cost-unit budget in grant caps"
        )
    if isinstance(value, ToolSpec):
        value = tool_spec_to_dict(value)
    if isinstance(value, str):
        if not Permission.is_valid(value):
            raise _invalid_permission(value, tool)
        return ToolSpec(permission=value)
    if not isinstance(value, Mapping):
        raise _fail(f"tools.{tool}: must be a permission string or an object")

    path = f"tools.{tool}"
    for key in value:
        if key not in _TOOL_KEYS:
            raise _fail(
                f"{path}: unknown key {_q(key)} (allowed: {', '.join(_TOOL_KEYS)})"
            )
    if "permission" not in value:
        raise _fail(f'{path}: missing required key "permission"')
    permission = value["permission"]
    if not Permission.is_valid(permission):
        raise _invalid_permission(permission, tool)

    allowed_purposes: Optional[Tuple[str, ...]] = None
    if "allowed_purposes" in value:
        raw = value["allowed_purposes"]
        message = (
            f"{path}.allowed_purposes: must be a non-empty array of unique "
            "purpose patterns"
        )
        if not isinstance(raw, list) or not raw:
            raise _fail(message)
        for index, pattern in enumerate(raw):
            if not is_valid_purpose_pattern(pattern):
                raise _fail(
                    f"{path}.allowed_purposes[{index}]: invalid purpose pattern "
                    f"{_q(pattern)}"
                )
        if not _unique_strings(raw):
            raise _fail(message)
        allowed_purposes = tuple(raw)

    caps: Optional[ToolCaps] = None
    if "caps" in value:
        raw_caps = value["caps"]
        if not isinstance(raw_caps, Mapping):
            raise _fail(f"{path}.caps: must be an object")
        for key in raw_caps:
            if key not in _CAP_KEYS:
                raise _fail(
                    f"{path}.caps: unknown key {_q(key)} "
                    f"(allowed: {', '.join(_CAP_KEYS)})"
                )
        if not raw_caps:
            raise _fail(
                f"{path}.caps: must declare at least one of {', '.join(_CAP_KEYS)}"
            )
        parsed: Dict[str, Optional[int]] = {k: None for k in _CAP_KEYS}
        for key in _CAP_KEYS:
            if key in raw_caps:
                parsed[key] = _count(raw_caps[key], f"{path}.caps.{key}")
        caps = ToolCaps(
            per_hour=parsed["per_hour"],
            per_day=parsed["per_day"],
            per_case=parsed["per_case"],
        )

    cost_units: Optional[Dict[str, int]] = None
    if "cost_units" in value:
        raw_units = value["cost_units"]
        if not isinstance(raw_units, Mapping) or not raw_units:
            raise _fail(f"{path}.cost_units: must be a non-empty object")
        cost_units = {}
        for unit, amount in raw_units.items():
            if not isinstance(unit, str) or not _UNIT_RE.match(unit):
                raise _fail(f"{path}.cost_units: invalid cost unit name {_q(unit)}")
            cost_units[unit] = _count(amount, f"{path}.cost_units.{unit}")

    requires_decision = False
    if "requires_decision" in value:
        if not isinstance(value["requires_decision"], bool):
            raise _fail(f"{path}.requires_decision: must be a boolean")
        requires_decision = value["requires_decision"]

    four_eyes_on: Tuple[str, ...] = ()
    if "four_eyes_on" in value:
        raw_eyes = value["four_eyes_on"]
        message = (
            f"{path}.four_eyes_on: must be a non-empty array of unique decision names"
        )
        if not isinstance(raw_eyes, list) or not raw_eyes:
            raise _fail(message)
        for index, decision in enumerate(raw_eyes):
            if not isinstance(decision, str) or not _UNIT_RE.match(decision):
                raise _fail(
                    f"{path}.four_eyes_on[{index}]: invalid decision name {_q(decision)}"
                )
        if not _unique_strings(raw_eyes):
            raise _fail(message)
        four_eyes_on = tuple(raw_eyes)

    if requires_decision and permission == Permission.READ:
        raise _fail(
            f"{path}: requires_decision is not allowed on a tool with read permission"
        )
    if four_eyes_on and not requires_decision:
        raise _fail(f"{path}.four_eyes_on: requires requires_decision: true")

    return ToolSpec(
        permission=permission,
        allowed_purposes=allowed_purposes,
        caps=caps,
        cost_units=cost_units,
        requires_decision=requires_decision,
        four_eyes_on=four_eyes_on,
    )


def tool_spec_to_dict(spec: ToolSpec) -> Dict[str, Any]:
    """Render a ToolSpec in manifest 0.6 object form (omitting unset fields)."""
    out: Dict[str, Any] = {"permission": spec.permission}
    if spec.allowed_purposes is not None:
        out["allowed_purposes"] = list(spec.allowed_purposes)
    if spec.caps is not None:
        out["caps"] = {
            k: getattr(spec.caps, k)
            for k in _CAP_KEYS
            if getattr(spec.caps, k) is not None
        }
    if spec.cost_units is not None:
        out["cost_units"] = dict(spec.cost_units)
    if spec.requires_decision:
        out["requires_decision"] = True
    if spec.four_eyes_on:
        out["four_eyes_on"] = list(spec.four_eyes_on)
    return out


# ── ToolManifest ────────────────────────────────────────────────────────


class ToolManifest:
    """Declares the required permission level for each tool on a connector.

    Load manifests via ``grantex.load_manifest()`` and they will be used
    automatically by ``grantex.enforce()``.

    ``tools`` maps each tool to its permission string (as before 0.6);
    ``get_tool_spec()`` returns the full declaration including constraints.
    """

    def __init__(
        self,
        connector: str,
        tools: Mapping[str, ToolDeclaration],
        version: str = "1.0.0",
        description: str = "",
    ) -> None:
        if not connector:
            raise ValueError("ToolManifest: connector name is required")
        if not tools:
            raise ValueError("ToolManifest: at least one tool is required")

        # A manifest that uses the object form anywhere is a 0.6 manifest and
        # is validated in full: names as well as values.
        if any(not isinstance(v, str) for v in tools.values()):
            _check_names(connector, tools)

        specs: Dict[str, ToolSpec] = {
            name: parse_tool_declaration(name, value) for name, value in tools.items()
        }

        self.connector = connector
        self.tools: Dict[str, str] = {n: s.permission for n, s in specs.items()}
        self._specs: Dict[str, ToolSpec] = specs
        self.version = version
        self.description = description

    def get_permission(self, tool_name: str) -> Optional[str]:
        """Get the declared permission for a tool. Returns None if not found."""
        return self.tools.get(tool_name)

    def get_tool_spec(self, tool_name: str) -> Optional[ToolSpec]:
        """Get a tool's full declaration. Returns None if the tool is not declared.

        The permission always reflects ``tools``; constraints declared for the
        tool are kept even if ``tools`` was edited directly, so editing the
        permission map can never drop a purpose, cap or decision requirement.

        Raises:
            ManifestValidationError: ``tools`` was edited into a combination the
                schema forbids (for example ``read`` on a decision tool).
        """
        permission = self.tools.get(tool_name)
        if permission is None:
            return None
        spec = self._specs.get(tool_name)
        if spec is None:
            return ToolSpec(permission=permission)
        if spec.permission != permission:
            return parse_tool_declaration(
                tool_name, {**tool_spec_to_dict(spec), "permission": permission}
            )
        return spec

    def add_tool(self, tool_name: str, permission: ToolDeclaration) -> None:
        """Add or update a tool in this manifest.

        ``permission`` is a permission string or a manifest 0.6 tool object.
        Replacing a tool replaces its whole declaration.
        """
        if isinstance(permission, str) and not Permission.is_valid(permission):
            raise ValueError(f"Invalid permission: {permission}")
        spec = parse_tool_declaration(tool_name, permission)
        self._specs[tool_name] = spec
        self.tools[tool_name] = spec.permission

    @property
    def tool_count(self) -> int:
        """Number of tools in this manifest."""
        return len(self.tools)

    def to_dict(self) -> Dict[str, Any]:
        """Render this manifest as a manifest 0.6 document."""
        tools: Dict[str, Any] = {}
        for name in self.tools:
            spec = self.get_tool_spec(name) or ToolSpec(permission=self.tools[name])
            rendered = tool_spec_to_dict(spec)
            tools[name] = spec.permission if len(rendered) == 1 else rendered
        out: Dict[str, Any] = {"connector": self.connector, "version": self.version}
        if self.description:
            out["description"] = self.description
        out["tools"] = tools
        return out

    @classmethod
    def from_file(cls, path: str) -> "ToolManifest":
        """Load a ToolManifest from a JSON or YAML file.

        YAML requires the ``pyyaml`` package to be installed.

        Expected shape::

            { "connector": "acme_kyb", "tools": { "get_case": "read",
              "verify_business": { "permission": "read", "caps": { "per_hour": 50 } } } }
        """
        p = Path(path)
        raw = p.read_text(encoding="utf-8")
        if p.suffix in (".yaml", ".yml"):
            try:
                import yaml  # type: ignore[import-not-found,unused-ignore,import-untyped]
                data = yaml.safe_load(raw)
            except ImportError:
                raise ImportError("PyYAML is required to load YAML manifests: pip install pyyaml")
        else:
            data = json.loads(raw)
        if not isinstance(data, Mapping):
            raise _fail("a manifest must be a JSON object")
        return cls.from_dict(data)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "ToolManifest":
        """Create a ToolManifest from a dict (e.g., parsed JSON).

        A manifest that declares ``$schema`` or uses the object form for any
        tool is validated against manifest schema 0.6, and an unknown key
        anywhere is rejected. A manifest made only of permission strings keeps
        its pre-0.6 behaviour: unknown top-level keys are ignored with a
        ``DeprecationWarning`` (they will be rejected from 0.7).
        """
        connector = data.get("connector")
        tools = data.get("tools")
        if not connector or not tools:
            raise ValueError('ToolManifest: missing "connector" or "tools" field')
        if not isinstance(tools, Mapping):
            raise _fail("tools: must be an object mapping tool names to declarations")

        strict = "$schema" in data or any(not isinstance(v, str) for v in tools.values())
        unknown = [k for k in data if k not in _TOP_LEVEL_KEYS]
        if strict:
            if unknown:
                raise _fail(
                    f"unknown top-level key {_q(unknown[0])} "
                    f"(allowed: {', '.join(_TOP_LEVEL_KEYS)})"
                )
            if "$schema" in data and not isinstance(data["$schema"], str):
                raise _fail("$schema: must be a string")
            version = data.get("version", "1.0.0")
            description = data.get("description", "")
            _check_names(connector, tools)
            if not isinstance(version, str) or not 0 < len(version) <= 64:
                raise _fail("version: must be a non-empty string of at most 64 characters")
            if not isinstance(description, str):
                raise _fail("description: must be a string")
            return cls(
                connector=connector,
                tools=dict(tools),
                version=version,
                description=description,
            )

        if unknown:
            warnings.warn(
                f"ToolManifest: ignoring unknown top-level key {_q(unknown[0])} in "
                f"manifest for {_q(connector)}; manifest schema 0.6 rejects unknown "
                "keys and a future minor release of grantex will too",
                DeprecationWarning,
                stacklevel=2,
            )
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

    reason_code: str = ""
    """Denial code from :class:`grantex.DenialReason`; empty when allowed."""

    sub_reason: str = ""
    """Finer-grained denial code, where one applies."""

    details: Dict[str, Any] = field(default_factory=dict)
    """Structured denial context (for example ``allowed_purposes`` or ``limit``)."""

    purpose: str = ""
    """The grant's purpose for this connector, when it carries one."""

    reservation: Optional["Reservation"] = None
    """Caps reserved for this call, when the tool or grant declares caps."""
