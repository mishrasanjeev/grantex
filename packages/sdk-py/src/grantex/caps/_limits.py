"""Derive the counters a tool call is metered against.

Two sources declare caps:

- the **manifest** (``caps`` on the tool): tenant-wide counters per tool;
- the **grant** (``caps`` in its ``urn:grantex:tools:v1`` entry): counters for
  that grant only, per tool (``{"verify_business": {"per_hour": 50}}``) and a
  cost-unit budget for the connector (``{"cost_units": {"per_day": 5000}}``).

Every declared cap is its own counter and all of them must hold. A call's cost
is the sum of the manifest ``cost_units`` for the components it incurs (all
declared components unless the caller names them).
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Mapping, Optional, Sequence

from ..manifest import ToolSpec
from ._meter import MAX_COUNT, PER_CASE, PER_DAY, PER_HOUR, CapLimit, CapsConfigurationError

_WINDOWS = (PER_HOUR, PER_DAY, PER_CASE)
_MAX_ID = 256

CASE_REQUIRED = "case_required"
INVALID_CASE_ID = "invalid_case_id"
INVALID_COST_COMPONENT = "invalid_cost_component"
MALFORMED_GRANT_CAPS = "malformed_grant_caps"


def counter_id(*parts: str) -> str:
    """Unambiguous counter identity; identical to the TypeScript SDK's."""
    return json.dumps(list(parts), ensure_ascii=False, separators=(",", ":"))


def _windows(raw: Any, where: str) -> Dict[str, int]:
    if not isinstance(raw, Mapping) or not raw:
        raise CapsConfigurationError(f"{where} must be a non-empty object", MALFORMED_GRANT_CAPS)
    out: Dict[str, int] = {}
    for window, value in raw.items():
        if window not in _WINDOWS:
            raise CapsConfigurationError(f"{where} has unknown window {window!r}", MALFORMED_GRANT_CAPS)
        if isinstance(value, float) and value.is_integer():
            value = int(value)
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_COUNT:
            raise CapsConfigurationError(f"{where}.{window} must be an integer between 0 and {MAX_COUNT}", MALFORMED_GRANT_CAPS)
        out[window] = value
    return out


def parse_grant_caps(caps: Optional[Mapping[str, Any]]) -> Dict[str, Dict[str, int]]:
    """Validate a grant entry's ``caps``; ``cost_units`` is the connector budget."""
    if caps is None:
        return {}
    if not isinstance(caps, Mapping):
        raise CapsConfigurationError("grant caps must be an object", MALFORMED_GRANT_CAPS)
    return {str(name): _windows(value, f"caps.{name}") for name, value in caps.items()}


def build_cap_limits(
    *,
    connector: str,
    tool: str,
    spec: ToolSpec,
    grant_id: str,
    grant_caps: Optional[Mapping[str, Any]] = None,
    case_id: Optional[str] = None,
    cost_components: Optional[Sequence[str]] = None,
) -> List[CapLimit]:
    """Return the limits for one call of ``tool``.

    Raises:
        CapsConfigurationError: with ``sub_reason`` ``case_required`` (a per-case
            cap applies and no ``case_id`` was given), ``invalid_case_id``,
            ``invalid_cost_component`` or ``malformed_grant_caps``.
    """
    if case_id is not None and (not isinstance(case_id, str) or not case_id or len(case_id) > _MAX_ID):
        raise CapsConfigurationError("case_id must be a non-empty string of at most 256 characters", INVALID_CASE_ID)

    declared_units = dict(spec.cost_units or {})
    if cost_components is None:
        components = list(declared_units)
    else:
        components = list(cost_components)
        if len(set(components)) != len(components) or any(c not in declared_units for c in components):
            raise CapsConfigurationError(
                f"cost components {components!r} are not all declared by tool {tool!r}", INVALID_COST_COMPONENT
            )
        if declared_units and not components:
            # A call to a tool that declares cost units incurs at least one of
            # them; an empty list would skip the budget entirely.
            raise CapsConfigurationError(
                f"tool {tool!r} declares cost units, so cost_components cannot be empty", INVALID_COST_COMPONENT
            )
    cost = sum(declared_units[c] for c in components)
    if cost > MAX_COUNT:
        raise CapsConfigurationError(
            f"the cost of this call ({cost} units) exceeds {MAX_COUNT}", INVALID_COST_COMPONENT
        )

    parsed_grant = parse_grant_caps(grant_caps)
    limits: List[CapLimit] = []

    def add(scope_parts: Sequence[str], windows: Mapping[str, int], units: int, scope: str, kind: str) -> None:
        for window in _WINDOWS:
            if window not in windows:
                continue
            parts = [*scope_parts, kind, window]
            if window == PER_CASE:
                if case_id is None:
                    raise CapsConfigurationError(
                        f"{scope} per_case cap on {connector}.{tool} needs a case_id", CASE_REQUIRED
                    )
                parts.append(case_id)
            limits.append(
                CapLimit(counter=counter_id(*parts), limit=windows[window], window=window,
                         units=units, scope=scope, kind=kind)
            )

    if spec.caps is not None:
        manifest_windows = {
            w: v for w, v in ((PER_HOUR, spec.caps.per_hour), (PER_DAY, spec.caps.per_day), (PER_CASE, spec.caps.per_case))
            if v is not None
        }
        add(["manifest", connector, tool], manifest_windows, 1, "manifest", "calls")
    if tool in parsed_grant and tool != "cost_units":
        add(["grant", grant_id, connector, tool], parsed_grant[tool], 1, "grant", "calls")
    if cost > 0 and "cost_units" in parsed_grant:
        add(["grant", grant_id, connector], parsed_grant["cost_units"], cost, "grant", "cost_units")
    return limits
