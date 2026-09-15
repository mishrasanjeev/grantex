"""Read ``urn:grantex:tools:v1`` entries from a grant's ``authorization_details``.

This is the only place that interprets the ``authorization_details`` claim
(RFC 9396), so a change to the token format touches one function. The shape
follows the Grantex grant example::

    "authorization_details": [{
      "type": "urn:grantex:tools:v1",
      "connector": "acme_kyb",
      "purpose": "aml.cdd.onboarding",
      "data_region": "eu",
      "tools": ["resolve_business", "verify_business", "screen_*"],
      "caps": {"verify_business": {"per_hour": 50, "per_case": 3},
               "cost_units": {"per_day": 5000}}
    }]

Entries of other types are separate authorizations and are ignored here. A
tools entry constrains calls on its connector in addition to the grant's
scopes. Anything ambiguous — a claim that is not an array, an entry without a
string ``type``, a tools entry with an unknown key, a value of the wrong type
or two tools entries for one connector — raises
:class:`AuthorizationDetailsError`, and ``enforce()`` denies.

``caps`` is validated here, for every call on the connector: each key is an
exact tool name or ``cost_units`` (the connector's cost-unit budget), never a
wildcard, and each value is a non-empty object of ``per_hour``, ``per_day``
and ``per_case`` counts from 0 to 2147483647.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional, Tuple

TOOLS_DETAIL_TYPE = "urn:grantex:tools:v1"

_ENTRY_KEYS = frozenset({"type", "connector", "purpose", "data_region", "tools", "caps"})
_NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}\Z")
_TOOL_PATTERN_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}\*?\Z")
_CAP_WINDOWS = ("per_hour", "per_day", "per_case")
_MAX_COUNT = 2147483647

COST_UNITS_KEY = "cost_units"
"""Key of the connector cost-unit budget in ``caps``; reserved as a tool name."""


class AuthorizationDetailsError(ValueError):
    """The ``authorization_details`` claim cannot be interpreted unambiguously."""


@dataclass(frozen=True)
class ToolsAuthorization:
    """One ``urn:grantex:tools:v1`` entry."""

    connector: str
    purpose: Optional[str] = None
    """The grant's purpose for this connector, exactly as issued (not validated)."""
    data_region: Optional[str] = None
    tools: Optional[Tuple[str, ...]] = None
    """Tool names, or prefixes ending in ``*``; ``None`` means every tool."""
    caps: Optional[Mapping[str, Mapping[str, int]]] = None
    """Validated caps: tool name (or ``cost_units``) to window to count."""

    def allows_tool(self, tool: str) -> bool:
        """Whether ``tools`` (when present) lists ``tool``."""
        if self.tools is None:
            return True
        for entry in self.tools:
            if entry.endswith("*"):
                if tool.startswith(entry[:-1]):
                    return True
            elif entry == tool:
                return True
        return False


def _parse_caps(raw: Any, where: str) -> Dict[str, Dict[str, int]]:
    if not isinstance(raw, Mapping) or not raw:
        raise AuthorizationDetailsError(f"{where} must be a non-empty object")
    parsed: Dict[str, Dict[str, int]] = {}
    for name, windows in raw.items():
        if not isinstance(name, str) or not (name == COST_UNITS_KEY or _NAME_RE.match(name)):
            raise AuthorizationDetailsError(
                f"{where} key {name!r} must be an exact tool name or cost_units; wildcards are not allowed"
            )
        if not isinstance(windows, Mapping) or not windows:
            raise AuthorizationDetailsError(f"{where}.{name} must be a non-empty object")
        counts: Dict[str, int] = {}
        for window, value in windows.items():
            if window not in _CAP_WINDOWS:
                raise AuthorizationDetailsError(f"{where}.{name} has unknown window {window!r}")
            if isinstance(value, float) and value.is_integer():
                value = int(value)
            if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= _MAX_COUNT:
                raise AuthorizationDetailsError(
                    f"{where}.{name}.{window} must be an integer between 0 and {_MAX_COUNT}"
                )
            counts[str(window)] = value
        parsed[name] = counts
    return parsed


def parse_tools_authorization(claim: Any) -> Dict[str, ToolsAuthorization]:
    """Return the tools entries of an ``authorization_details`` claim by connector.

    ``None`` (no claim) yields an empty mapping.

    Raises:
        AuthorizationDetailsError: the claim is malformed or ambiguous.
    """
    if claim is None:
        return {}
    if not isinstance(claim, (list, tuple)):
        raise AuthorizationDetailsError("authorization_details must be an array")

    entries: Dict[str, ToolsAuthorization] = {}
    for index, raw in enumerate(claim):
        where = f"authorization_details[{index}]"
        if not isinstance(raw, Mapping):
            raise AuthorizationDetailsError(f"{where} must be an object")
        detail_type = raw.get("type")
        if not isinstance(detail_type, str) or not detail_type:
            raise AuthorizationDetailsError(f"{where}.type must be a non-empty string")
        if detail_type != TOOLS_DETAIL_TYPE:
            continue

        unknown = sorted(str(k) for k in raw if k not in _ENTRY_KEYS)
        if unknown:
            raise AuthorizationDetailsError(f"{where} has unknown key {unknown[0]!r}")

        connector = raw.get("connector")
        if not isinstance(connector, str) or not _NAME_RE.match(connector):
            raise AuthorizationDetailsError(f"{where}.connector must be a connector name")
        if connector in entries:
            raise AuthorizationDetailsError(
                f"{where} repeats connector {connector!r}; a grant carries one tools entry per connector"
            )

        purpose = raw.get("purpose")
        if purpose is not None and not isinstance(purpose, str):
            raise AuthorizationDetailsError(f"{where}.purpose must be a string")

        data_region = raw.get("data_region")
        if data_region is not None and not isinstance(data_region, str):
            raise AuthorizationDetailsError(f"{where}.data_region must be a string")

        tools: Optional[Tuple[str, ...]] = None
        if "tools" in raw:
            raw_tools = raw["tools"]
            if not isinstance(raw_tools, (list, tuple)) or not all(
                isinstance(t, str) and _TOOL_PATTERN_RE.match(t) for t in raw_tools
            ):
                raise AuthorizationDetailsError(
                    f"{where}.tools must be an array of tool names or name prefixes ending in *"
                )
            tools = tuple(raw_tools)

        caps: Optional[Mapping[str, Mapping[str, int]]] = None
        if "caps" in raw:
            caps = _parse_caps(raw["caps"], f"{where}.caps")

        entries[connector] = ToolsAuthorization(
            connector=connector,
            purpose=purpose,
            data_region=data_region,
            tools=tools,
            caps=caps,
        )
    return entries
