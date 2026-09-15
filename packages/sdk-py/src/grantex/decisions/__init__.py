"""Decision grants (PRD G-3).

A decision grant is a second credential a named person mints for one semantic
action. This package holds:

- the semantic action and its hash (``spec/canonicalization.md``);
- offline verification of decision grants, including four eyes
  (:func:`verify_decision_grant`, :func:`verify_decision_grants`);
- the auth-service client (``Grantex(...).decisions``) that creates decision
  requests, records approvals and consumes grants atomically.

``Grantex.enforce()`` combines them for tools whose manifest entry has
``requires_decision``. The token profile is ``spec/decision-grant.md``.
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
from ._client import (
    APPROVER_SESSION_HEADER,
    ConsumedDecision,
    DecisionConsumer,
    DecisionsClient,
)
from ._verify import (
    DECISION_GRANT_AUDIENCE,
    DECISION_GRANT_TYP,
    DecisionGrant,
    DecisionGrantError,
    DecisionGrantSet,
    FourEyes,
    verify_decision_grant,
    verify_decision_grants,
)

DECISIONS_ENFORCE = "enforce"
"""``decisions_mode``: deny a ``requires_decision`` call without a valid, consumed decision grant."""
DECISIONS_WARN = "warn"
"""``decisions_mode``: allow such a call and report the denial in ``EnforceResult.would_deny``."""
DECISIONS_MODES = (DECISIONS_ENFORCE, DECISIONS_WARN)

__all__ = [
    "ACTION_FIELDS",
    "ACTION_HASH_PREFIX",
    "APPROVER_SESSION_HEADER",
    "ActionValidationError",
    "ConsumedDecision",
    "DECISIONS_ENFORCE",
    "DECISIONS_MODES",
    "DECISIONS_WARN",
    "DECISION_GRANT_AUDIENCE",
    "DECISION_GRANT_TYP",
    "DecisionAction",
    "DecisionConsumer",
    "DecisionGrant",
    "DecisionGrantError",
    "DecisionGrantSet",
    "DecisionsClient",
    "FourEyes",
    "compute_action_hash",
    "is_action_hash",
    "verify_decision_grant",
    "verify_decision_grants",
]
