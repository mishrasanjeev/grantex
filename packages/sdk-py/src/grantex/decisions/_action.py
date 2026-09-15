"""The semantic action a decision grant approves, and its hash (PRD G-3).

A decision grant is bound to *what* a person approved, not to the bytes of a
tool call: ``{case_id, action, decision, subject, amount?, extra?}``. The hash is

    action_hash = "sha256:" + base64url(SHA-256(JCS(action)))

with RFC 8785 canonical JSON (:mod:`grantex.canonical`) and unpadded base64url
(RFC 4648 section 5). Re-planning the tool payload, adding a timestamp or
reordering fields leaves the hash unchanged; changing any bound field changes
it. Only these fields are bound: any other meaning of a call (a currency, a
reason code) is approved only if the manifest declares it as an extra
decision field (``extra``).
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple, Union

from ..canonical import CanonicalizationError, canonicalize_bytes, int_to_double

__all__ = [
    "ACTION_FIELDS",
    "ACTION_HASH_PREFIX",
    "MAX_EXTRA_FIELDS",
    "ActionValidationError",
    "DecisionAction",
    "compute_action_hash",
    "is_action_hash",
    "is_invisible_format_character",
]

ACTION_HASH_PREFIX = "sha256:"
ACTION_FIELDS = ("case_id", "action", "decision", "subject", "amount", "extra")
_REQUIRED_FIELDS = ("case_id", "action", "decision", "subject")

_TOOL_NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}\Z")
_DECISION_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}\Z")
_FIELD_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}\Z")
_DECIMAL_RE = re.compile(r"^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?\Z")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_HASH_RE = re.compile(r"^sha256:[A-Za-z0-9_-]{43}\Z")

MAX_CASE_ID_LENGTH = 256
MAX_SUBJECT_LENGTH = 512
MAX_AMOUNT_LENGTH = 64
MAX_EXTRA_FIELDS = 16

# Unicode format characters (general category Cf: zero-width, bidirectional
# controls, invisible operators, tags), listed explicitly so every SDK refuses
# the same set whatever Unicode version its runtime ships.
_FORMAT_RANGES: Tuple[Tuple[int, int], ...] = (
    (0x00AD, 0x00AD), (0x0600, 0x0605), (0x061C, 0x061C), (0x06DD, 0x06DD),
    (0x070F, 0x070F), (0x0890, 0x0891), (0x08E2, 0x08E2), (0x180E, 0x180E),
    (0x200B, 0x200F), (0x202A, 0x202E), (0x2060, 0x2064), (0x2066, 0x206F),
    (0xFEFF, 0xFEFF), (0xFFF9, 0xFFFB), (0x110BD, 0x110BD), (0x110CD, 0x110CD),
    (0x13430, 0x1343F), (0x1BCA0, 0x1BCA3), (0x1D173, 0x1D17A), (0xE0001, 0xE0001),
    (0xE0020, 0xE007F),
)

Amount = Union[int, float, str]
ExtraValue = Union[int, float, str]


def is_invisible_format_character(char: str) -> bool:
    """Whether ``char`` is one of the refused Unicode format characters."""
    code = ord(char)
    return any(lo <= code <= hi for lo, hi in _FORMAT_RANGES)


class ActionValidationError(ValueError):
    """The semantic action is malformed.

    ``code`` is one of ``not_an_object``, ``missing_field``, ``unknown_field``,
    ``invalid_type``, ``invalid_value`` or ``duplicate_key``; ``field`` names
    the field, if any (``extra.<name>`` for an extra field). The TypeScript
    SDK raises the same codes for the same inputs.
    """

    def __init__(self, code: str, field: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.field = field


@dataclass(frozen=True)
class DecisionAction:
    """The action a person approves.

    - ``case_id``: the case the decision belongs to (1-256 code points, no
      control or invisible format characters).
    - ``action``: the manifest tool that carries out the decision, for
      example ``case_decision``.
    - ``decision``: the outcome approved, for example ``approve`` or
      ``decline`` (``^[a-z][a-z0-9_]{0,63}$``, the names ``four_eyes_on``
      uses).
    - ``subject``: what the decision is about, for example ``gb:00000001``
      (1-512 code points, same character rules as ``case_id``).
    - ``amount``: optional. A finite JSON number or a canonical decimal string
      (``"1250.5"``: no leading zeros, no trailing fractional zeros, no
      ``+``, no exponent). A number and a string are different values.
    - ``extra``: optional. Further semantic fields the manifest declares for
      the tool (``decision_fields``), for example ``{"currency": "GBP"}``:
      names ``^[a-z][a-z0-9_]{0,63}$``, at most 16, values strings (same rules
      as ``subject``) or finite numbers. Omitted when empty.

    Strings are compared exactly; no case folding or Unicode normalisation.
    """

    case_id: str
    action: str
    decision: str
    subject: str
    amount: Optional[Amount] = None
    extra: Mapping[str, ExtraValue] = field(default_factory=dict)

    def __post_init__(self) -> None:
        _validate_string("case_id", self.case_id, MAX_CASE_ID_LENGTH)
        _validate_string("action", self.action, 128)
        if not _TOOL_NAME_RE.match(self.action):
            raise ActionValidationError(
                "invalid_value", "action", "action: must be a manifest tool name"
            )
        _validate_string("decision", self.decision, 64)
        if not _DECISION_RE.match(self.decision):
            raise ActionValidationError(
                "invalid_value", "decision",
                "decision: must match ^[a-z][a-z0-9_]{0,63}$",
            )
        _validate_string("subject", self.subject, MAX_SUBJECT_LENGTH)
        if self.amount is not None:
            _validate_amount(self.amount)
        _validate_extra(self.extra)
        # Keep a private copy so the action cannot change after validation.
        object.__setattr__(self, "extra", dict(self.extra))

    def __hash__(self) -> int:
        return hash(self.canonical_json())

    @classmethod
    def from_dict(cls, value: Any) -> "DecisionAction":
        """Build from the JSON object form, refusing unknown or missing fields.

        This is the form carried in a decision grant's ``action`` claim.
        ``amount`` and ``extra`` may be absent; ``null`` or an empty ``extra``
        is refused, so a field has one encoding.
        """
        if not isinstance(value, Mapping):
            raise ActionValidationError(
                "not_an_object", "", "action: must be a JSON object"
            )
        for key in value:
            if key not in ACTION_FIELDS:
                raise ActionValidationError(
                    "unknown_field", str(key), f"action: unknown field {key!r}"
                )
        for key in _REQUIRED_FIELDS:
            if key not in value:
                raise ActionValidationError(
                    "missing_field", key, f"action: missing field {key!r}"
                )
        for key in ("amount", "extra"):
            if key in value and value[key] is None:
                raise ActionValidationError(
                    "invalid_type", key, f"{key}: omit the field instead of sending null",
                )
        extra = value.get("extra", {})
        if "extra" in value:
            if not isinstance(extra, Mapping):
                raise ActionValidationError("invalid_type", "extra", "extra: must be a JSON object")
            if len(extra) == 0:
                raise ActionValidationError("invalid_value", "extra", "extra: omit the field instead of sending {}")
        return cls(
            case_id=value["case_id"],
            action=value["action"],
            decision=value["decision"],
            subject=value["subject"],
            amount=value.get("amount"),
            extra=extra,
        )

    @classmethod
    def from_json(cls, text: Union[str, bytes]) -> "DecisionAction":
        """Parse the JSON object form from text, refusing duplicate member names."""
        return cls.from_dict(_loads_rejecting_duplicates(text))

    @classmethod
    def from_tool_call(
        cls,
        tool: str,
        arguments: Any,
        extra_fields: Sequence[str] = (),
    ) -> "DecisionAction":
        """Derive the semantic action from a tool call.

        ``action`` is the tool name; ``case_id``, ``decision``, ``subject``
        and, when present and not null, ``amount`` are read from the call's
        arguments, and so is every name in ``extra_fields`` (the manifest's
        ``decision_fields``), which must be present and not null. Every other
        argument is ignored, so the hash is the same whatever else the agent
        put in the payload.
        """
        if not isinstance(arguments, Mapping):
            raise ActionValidationError(
                "not_an_object", "", "tool arguments: must be a JSON object"
            )
        for key in ("case_id", "decision", "subject"):
            if key not in arguments:
                raise ActionValidationError(
                    "missing_field", key, f"tool arguments: missing {key!r}"
                )
        extra: Dict[str, Any] = {}
        for name in extra_fields:
            if not isinstance(name, str) or not _FIELD_NAME_RE.match(name) or name in ACTION_FIELDS:
                raise ActionValidationError("invalid_value", f"extra.{name}", "invalid extra decision field name")
            if arguments.get(name) is None:
                raise ActionValidationError(
                    "missing_field", f"extra.{name}", f"tool arguments: missing {name!r}"
                )
            extra[name] = arguments[name]
        return cls(
            case_id=arguments["case_id"],
            action=tool,
            decision=arguments["decision"],
            subject=arguments["subject"],
            amount=arguments.get("amount"),
            extra=extra,
        )

    def to_dict(self) -> Dict[str, Any]:
        """The JSON object form (``amount`` and ``extra`` omitted when absent)."""
        out: Dict[str, Any] = {
            "case_id": self.case_id,
            "action": self.action,
            "decision": self.decision,
            "subject": self.subject,
        }
        if self.amount is not None:
            out["amount"] = self.amount
        if self.extra:
            out["extra"] = dict(self.extra)
        return out

    def canonical_json(self) -> str:
        """RFC 8785 canonical JSON of :meth:`to_dict`."""
        return canonicalize_bytes(self.to_dict()).decode("utf-8")

    def action_hash(self) -> str:
        """``sha256:`` followed by the unpadded base64url SHA-256 of the canonical JSON."""
        try:
            digest = hashlib.sha256(canonicalize_bytes(self.to_dict())).digest()
        except CanonicalizationError as exc:  # pragma: no cover - validated above
            raise ActionValidationError("invalid_value", "", str(exc)) from exc
        return ACTION_HASH_PREFIX + base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def compute_action_hash(action: Union[DecisionAction, Mapping[str, Any]]) -> str:
    """Return the ``action_hash`` of a :class:`DecisionAction` or its object form."""
    if not isinstance(action, DecisionAction):
        action = DecisionAction.from_dict(action)
    return action.action_hash()


def is_action_hash(value: Any) -> bool:
    """Whether ``value`` has the shape of an ``action_hash``."""
    return isinstance(value, str) and bool(_HASH_RE.match(value))


def _loads_rejecting_duplicates(text: Union[str, bytes]) -> Any:
    def hook(pairs: List[Tuple[str, Any]]) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for key, item in pairs:
            if key in out:
                raise ActionValidationError("duplicate_key", key, f"duplicate member name {key!r}")
            out[key] = item
        return out

    try:
        return json.loads(text, object_pairs_hook=hook)
    except ActionValidationError:
        raise
    except ValueError as exc:
        raise ActionValidationError("not_an_object", "", f"action: invalid JSON: {exc}") from exc


def _validate_string(field: str, value: Any, max_length: int) -> None:
    if not isinstance(value, str):
        raise ActionValidationError("invalid_type", field, f"{field}: must be a string")
    # Lengths count Unicode code points, the same in every SDK.
    if not value or len(value) > max_length:
        raise ActionValidationError(
            "invalid_value", field, f"{field}: must be 1-{max_length} code points"
        )
    if (
        _CONTROL_RE.search(value)
        or any(0xD800 <= ord(c) <= 0xDFFF for c in value)
        or any(is_invisible_format_character(c) for c in value)
    ):
        raise ActionValidationError(
            "invalid_value", field,
            f"{field}: must not contain control characters, invisible format "
            "characters or unpaired surrogates",
        )


def _validate_number(field: str, value: Any) -> None:
    if isinstance(value, bool):
        raise ActionValidationError("invalid_type", field, f"{field}: must be a number or a string")
    if isinstance(value, int):
        try:
            int_to_double(value)
        except CanonicalizationError:
            raise ActionValidationError(
                "invalid_value", field,
                f"{field}: integer not exactly representable as a double; use a decimal string",
            ) from None
        return
    if isinstance(value, float) and not math.isfinite(value):
        raise ActionValidationError("invalid_value", field, f"{field}: must be a finite number")


def _validate_amount(value: Any) -> None:
    if isinstance(value, (bool, int, float)):
        _validate_number("amount", value)
        return
    if isinstance(value, str):
        if len(value) > MAX_AMOUNT_LENGTH or not _DECIMAL_RE.match(value) or value == "-0":
            raise ActionValidationError(
                "invalid_value", "amount",
                "amount: decimal strings must be canonical (no leading zeros, "
                "trailing fractional zeros, '+', '-0' or exponent)",
            )
        return
    raise ActionValidationError(
        "invalid_type", "amount", "amount: must be a number or a decimal string"
    )


def _validate_extra(extra: Any) -> None:
    if not isinstance(extra, Mapping):
        raise ActionValidationError("invalid_type", "extra", "extra: must be a JSON object")
    if len(extra) > MAX_EXTRA_FIELDS:
        raise ActionValidationError("invalid_value", "extra", f"extra: at most {MAX_EXTRA_FIELDS} fields")
    for name, value in extra.items():
        path = f"extra.{name}"
        if not isinstance(name, str) or not _FIELD_NAME_RE.match(name) or name in ACTION_FIELDS:
            raise ActionValidationError("invalid_value", path, f"{path}: invalid field name")
        if isinstance(value, str):
            _validate_string(path, value, MAX_SUBJECT_LENGTH)
        elif isinstance(value, (bool, int, float)):
            _validate_number(path, value)
        else:
            raise ActionValidationError("invalid_type", path, f"{path}: must be a string or a number")
