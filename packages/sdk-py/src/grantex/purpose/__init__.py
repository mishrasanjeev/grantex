"""Purpose vocabulary and matching for purpose-bound grants.

A grant carries one purpose from a controlled vocabulary, or a private term
``x-<org>.<term>``. A manifest tool may restrict the purposes it can be called
for with ``allowed_purposes`` patterns. Matching is by whole dot-separated
segments:

- a pattern without a wildcard matches only the identical purpose;
- ``prefix.*`` matches any purpose that has ``prefix`` as its leading segments
  and at least one more segment: ``aml.cdd.*`` matches ``aml.cdd.onboarding``
  but not ``aml.cdd`` itself and not ``aml.cddx``.

Every function here returns a negative answer, never raises, for malformed
input, so a malformed pattern or purpose can only ever deny.

The TypeScript SDK implements the same rules in ``purpose.ts``.
"""

from __future__ import annotations

import re
from typing import Any, FrozenSet, Iterable, Optional

from ..manifest import MAX_PURPOSE_LENGTH, is_valid_purpose_pattern

__all__ = [
    "PURPOSE_VOCABULARY",
    "PRIVATE_PURPOSE_PREFIX",
    "is_valid_purpose",
    "is_known_purpose",
    "is_valid_purpose_pattern",
    "purpose_matches",
    "match_purpose",
]

PURPOSE_VOCABULARY: FrozenSet[str] = frozenset(
    {
        "aml.cdd.onboarding",
        "aml.cdd.ongoing",
        "aml.screening",
        "procurement.vendor_onboarding",
        "payments.payout",
    }
)
"""The controlled purpose vocabulary. Private terms use ``x-<org>.<term>``."""

PRIVATE_PURPOSE_PREFIX = "x-"

_SEG = r"[a-z][a-z0-9_]*"
_ORG = r"x-[a-z0-9]+(?:-[a-z0-9]+)*"
_PURPOSE_RE = re.compile(rf"^(?:{_SEG}(?:\.{_SEG})*|{_ORG}(?:\.{_SEG})+)\Z")


def _purpose_str(value: Any) -> Optional[str]:
    if (
        isinstance(value, str)
        and len(value) <= MAX_PURPOSE_LENGTH
        and _PURPOSE_RE.match(value) is not None
    ):
        return value
    return None


def is_valid_purpose(value: Any) -> bool:
    """Whether ``value`` is syntactically a purpose (no wildcard)."""
    return _purpose_str(value) is not None


def is_known_purpose(value: Any) -> bool:
    """Whether ``value`` is a vocabulary term or a well-formed private term."""
    purpose = _purpose_str(value)
    if purpose is None:
        return False
    return purpose in PURPOSE_VOCABULARY or purpose.startswith(PRIVATE_PURPOSE_PREFIX)


def purpose_matches(pattern: Any, purpose: Any) -> bool:
    """Whether ``purpose`` matches one ``allowed_purposes`` ``pattern``.

    Returns ``False`` when either argument is malformed.
    """
    candidate = _purpose_str(purpose)
    if candidate is None or not isinstance(pattern, str) or not is_valid_purpose_pattern(pattern):
        return False
    if pattern.endswith(".*"):
        prefix = pattern[:-1]  # keep the trailing dot: "aml.cdd."
        return candidate.startswith(prefix) and len(candidate) > len(prefix)
    return candidate == pattern


def match_purpose(patterns: Optional[Iterable[Any]], purpose: Any) -> Optional[str]:
    """Return the first pattern in ``patterns`` that ``purpose`` matches, or ``None``."""
    if patterns is None:
        return None
    for pattern in patterns:
        if purpose_matches(pattern, purpose):
            return str(pattern)
    return None
