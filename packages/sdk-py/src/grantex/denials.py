"""Denial taxonomy for ``enforce()`` (PRD Appendix B).

Every denied :class:`~grantex.EnforceResult` carries a ``reason_code`` from
:class:`DenialReason` and, where one applies, a ``sub_reason``. ``reason``
stays a human-readable sentence; code against ``reason_code``.

The codes are stable, low-cardinality strings intended for metric labels and
audit records. The TypeScript SDK exports the same values.
"""

from __future__ import annotations

from typing import Tuple


class DenialReason:
    """Why ``enforce()`` denied a tool call."""

    PURPOSE_NOT_ALLOWED = "purpose_not_allowed"
    """The grant's purpose matches none of the tool's ``allowed_purposes``, or
    the grant carries no purpose and the tool declares ``allowed_purposes``."""

    TOOL_NOT_GRANTED = "tool_not_granted"
    """No scope in the grant covers the connector or tool."""

    PERMISSION_INSUFFICIENT = "permission_insufficient"
    """A scope covers the connector but at a lower permission level."""

    CAP_EXCEEDED = "cap_exceeded"
    """A call cap, cost-unit budget or amount cap would be exceeded, or cannot
    be evaluated (see :class:`CapSubReason`)."""

    DECISION_REQUIRED = "decision_required"
    """The tool declares ``requires_decision`` and no decision grant was given."""

    DECISION_INVALID = "decision_invalid"
    """A decision grant was given but is not valid for this action."""

    GRANT_REVOKED = "grant_revoked"
    """The grant has been revoked."""

    REGION_MISMATCH = "region_mismatch"
    """The grant's data region does not permit this call."""

    MANIFEST_UNKNOWN_TOOL = "manifest_unknown_tool"
    """No manifest is loaded for the connector, or it does not declare the tool."""

    TOKEN_INVALID = "token_invalid"
    """The grant token failed verification (signature, expiry, issuer, shape).
    Not part of Appendix B, which assumes a verified grant."""

    ALL: Tuple[str, ...] = (
        PURPOSE_NOT_ALLOWED,
        TOOL_NOT_GRANTED,
        PERMISSION_INSUFFICIENT,
        CAP_EXCEEDED,
        DECISION_REQUIRED,
        DECISION_INVALID,
        GRANT_REVOKED,
        REGION_MISMATCH,
        MANIFEST_UNKNOWN_TOOL,
        TOKEN_INVALID,
    )


class ManifestSubReason:
    """Sub-reasons for :attr:`DenialReason.MANIFEST_UNKNOWN_TOOL`."""

    UNKNOWN_CONNECTOR = "unknown_connector"
    UNKNOWN_TOOL = "unknown_tool"
    INVALID_DECLARATION = "invalid_declaration"


class CapSubReason:
    """Sub-reasons for :attr:`DenialReason.CAP_EXCEEDED`."""

    AMOUNT_CAP = "amount_cap"
    """``amount`` is above a ``capped:N`` scope."""
    INVALID_AMOUNT = "invalid_amount"
    """``amount`` is not a finite number."""
    MALFORMED_CAP = "malformed_cap"
    """A ``capped:N`` scope carries a malformed cap."""
    METER_UNAVAILABLE = "meter_unavailable"
    """The tool declares caps or cost units and they cannot be metered: no
    meter is configured or its backend is unavailable."""
    LIMIT_REACHED = "limit_reached"
    """A call cap or cost-unit budget would be exceeded (error code E1008).
    ``details`` carries ``limit``, ``window``, ``used``, ``requested``,
    ``scope`` (``manifest`` or ``grant``) and ``kind`` (``calls`` or
    ``cost_units``)."""
    CASE_REQUIRED = "case_required"
    """A per-case cap applies and no ``case_id`` was given."""
    INVALID_CASE_ID = "invalid_case_id"
    INVALID_COST_COMPONENT = "invalid_cost_component"
    """``cost_components`` names a unit the tool does not declare."""


class PurposeSubReason:
    """Sub-reasons for :attr:`DenialReason.PURPOSE_NOT_ALLOWED`."""

    MISSING = "missing"
    """The grant carries no purpose."""
    NOT_MATCHED = "not_matched"
    """The grant's purpose matches none of the tool's patterns."""
    UNKNOWN_PURPOSE = "unknown_purpose"
    """The grant's purpose is malformed or not in the purpose vocabulary."""


class ToolSubReason:
    """Sub-reasons for :attr:`DenialReason.TOOL_NOT_GRANTED`."""

    NOT_IN_AUTHORIZATION_DETAILS = "not_in_authorization_details"
    """The grant's tools entry for the connector does not list the tool."""


class TokenSubReason:
    """Sub-reasons for :attr:`DenialReason.TOKEN_INVALID`."""

    MALFORMED_AUTHORIZATION_DETAILS = "malformed_authorization_details"
    """The ``authorization_details`` claim cannot be read unambiguously."""


class DecisionSubReason:
    """Sub-reasons for :attr:`DenialReason.DECISION_REQUIRED` and
    :attr:`DenialReason.DECISION_INVALID` (PRD G-3; ``spec/decision-grant.md``).

    The first four are PRD Appendix B's; the auth service uses the same values.
    """

    ACTION_MISMATCH = "action_mismatch"
    """The grant approves a different action (tool, decision, subject, amount or connector)."""
    EXPIRED = "expired"
    """The grant is past its expiry."""
    CONSUMED = "consumed"
    """The grant has already been used."""
    SAME_APPROVER = "same_approver"
    """Both grants of a four-eyes decision name the same approver."""
    CASE_CHANGED = "case_changed"
    """The case changed (new case version) after the decision was approved."""
    WRONG_CASE = "wrong_case"
    """The grant approves an action on another case."""
    STEP_UP_REQUIRED = "step_up_required"
    """The approver's authentication was not step-up (auth service only)."""
    REVOKED = "revoked"
    """The decision request was cancelled and its grants revoked."""
    UNKNOWN_GRANT = "unknown_grant"
    """The issuer does not know the grant, or it belongs to another developer."""
    MALFORMED = "malformed"
    """The grant, or the action to compare it with, cannot be read."""
    FOUR_EYES_INCOMPLETE = "four_eyes_incomplete"
    """The decision needs two approvals and fewer were presented."""
    CONSUME_UNAVAILABLE = "consume_unavailable"
    """The grant could not be consumed at the issuer (network, server or configuration)."""
    ABSENT = "absent"
    """No decision grant was presented (reported as ``decision_required``)."""
