"""Decision grants (PRD G-3).

A decision grant is a second credential a named person mints for one semantic
action. This package holds the semantic action and its hash; the profile is
specified in ``spec/canonicalization.md`` (hash) and ``spec/decision-grant.md``
(token).
"""

from __future__ import annotations

from ._action import (
    ACTION_FIELDS,
    ACTION_HASH_PREFIX,
    ActionValidationError,
    DecisionAction,
    compute_action_hash,
    is_action_hash,
)

__all__ = [
    "ACTION_FIELDS",
    "ACTION_HASH_PREFIX",
    "ActionValidationError",
    "DecisionAction",
    "compute_action_hash",
    "is_action_hash",
]
