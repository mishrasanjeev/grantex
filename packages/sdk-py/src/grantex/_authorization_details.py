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
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional, Tuple

TOOLS_DETAIL_TYPE = "urn:grantex:tools:v1"
DECISION_DETAIL_TYPE = "urn:grantex:decision:v1"

_ENTRY_KEYS = frozenset({"type", "connector", "purpose", "data_region", "tools", "caps"})
_NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}\Z")
_TOOL_PATTERN_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}\*?\Z")


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
    caps: Optional[Mapping[str, Any]] = None
    """Cap declarations as issued; interpreted by the caps meter."""

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

        caps: Optional[Mapping[str, Any]] = None
        if "caps" in raw:
            if not isinstance(raw["caps"], Mapping):
                raise AuthorizationDetailsError(f"{where}.caps must be an object")
            caps = dict(raw["caps"])

        entries[connector] = ToolsAuthorization(
            connector=connector,
            purpose=purpose,
            data_region=data_region,
            tools=tools,
            caps=caps,
        )
    return entries


_DECISION_ENTRY_KEYS = frozenset({"type", "connector", "tools", "four_eyes_on"})
_DECISION_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}\Z")


@dataclass(frozen=True)
class DecisionReference:
    """One ``urn:grantex:decision:v1`` entry.

    Tools on a connector that need a decision grant, and the decisions on each
    that need two approvers::

        {"type": "urn:grantex:decision:v1", "connector": "acme_kyb",
         "tools": ["case_decision"], "four_eyes_on": {"case_decision": ["decline"]}}
    """

    connector: str
    tools: Tuple[str, ...]
    four_eyes_on: Mapping[str, Tuple[str, ...]]


def parse_decision_references(claim: Any) -> Dict[str, DecisionReference]:
    """Return the decision references of an ``authorization_details`` claim by connector.

    ``None`` yields an empty mapping. Entries of other types are ignored.

    Raises:
        AuthorizationDetailsError: an entry has an unknown key, no tools, a
            tool that is not a name, ``four_eyes_on`` naming a tool not in
            ``tools``, or repeats a connector.
    """
    if claim is None:
        return {}
    if not isinstance(claim, (list, tuple)):
        raise AuthorizationDetailsError("authorization_details must be an array")

    entries: Dict[str, DecisionReference] = {}
    for index, raw in enumerate(claim):
        where = f"authorization_details[{index}]"
        if not isinstance(raw, Mapping):
            raise AuthorizationDetailsError(f"{where} must be an object")
        detail_type = raw.get("type")
        if not isinstance(detail_type, str) or not detail_type:
            raise AuthorizationDetailsError(f"{where}.type must be a non-empty string")
        if detail_type != DECISION_DETAIL_TYPE:
            continue

        unknown = sorted(str(k) for k in raw if k not in _DECISION_ENTRY_KEYS)
        if unknown:
            raise AuthorizationDetailsError(f"{where} has unknown key {unknown[0]!r}")
        connector = raw.get("connector")
        if not isinstance(connector, str) or not _NAME_RE.match(connector):
            raise AuthorizationDetailsError(f"{where}.connector must be a connector name")
        if connector in entries:
            raise AuthorizationDetailsError(
                f"{where} repeats connector {connector!r}; a grant carries one decision entry per connector"
            )
        raw_tools = raw.get("tools")
        if (
            not isinstance(raw_tools, (list, tuple))
            or not raw_tools
            or not all(isinstance(t, str) and _NAME_RE.match(t) for t in raw_tools)
        ):
            raise AuthorizationDetailsError(f"{where}.tools must be a non-empty array of tool names")
        tools = tuple(raw_tools)
        four_eyes: Dict[str, Tuple[str, ...]] = {}
        if "four_eyes_on" in raw:
            raw_four_eyes = raw["four_eyes_on"]
            if not isinstance(raw_four_eyes, Mapping):
                raise AuthorizationDetailsError(f"{where}.four_eyes_on must be an object")
            for tool, decisions in raw_four_eyes.items():
                if tool not in tools:
                    raise AuthorizationDetailsError(
                        f"{where}.four_eyes_on names {tool!r}, which is not in tools"
                    )
                if (
                    not isinstance(decisions, (list, tuple))
                    or not decisions
                    or not all(isinstance(d, str) and _DECISION_RE.match(d) for d in decisions)
                ):
                    raise AuthorizationDetailsError(
                        f"{where}.four_eyes_on.{tool} must be a non-empty array of decisions"
                    )
                four_eyes[str(tool)] = tuple(decisions)
        entries[connector] = DecisionReference(
            connector=connector, tools=tools, four_eyes_on=four_eyes
        )
    return entries
