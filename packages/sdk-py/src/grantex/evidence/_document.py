"""Strict parsing of evidence package bytes.

A package is valid only as its own RFC 8785 canonical form (optionally followed
by one line feed). Anything a JSON parser would silently resolve - a
duplicate member, a byte-order mark, whitespace, another spelling of a number
- is refused, so that every byte of a package is significant.
"""

from __future__ import annotations

import json
import math
from typing import Any, Dict, List, NoReturn, Tuple

from ._canonical import CanonicalizationError, canonicalize, int_to_double
from ._result import VerificationCode, VerificationFailure

__all__ = ["DEFAULT_MAX_BYTES", "parse_canonical", "format_path", "json_text"]

DEFAULT_MAX_BYTES = 64 * 1024 * 1024

_NUMBER_BYTES = frozenset(b"-+.eE0123456789")
_NUMBER_OPENERS = frozenset(b":,[")
_IDENTIFIER_FIRST = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_")
_IDENTIFIER_REST = _IDENTIFIER_FIRST | frozenset("0123456789")


class _DuplicateKey(Exception):
    def __init__(self, name: str) -> None:
        super().__init__(name)
        self.name = name


class _BadConstant(Exception):
    pass


def _pairs(pairs: List[Tuple[str, Any]]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            raise _DuplicateKey(key)
        out[key] = value
    return out


def _constant(name: str) -> NoReturn:
    raise _BadConstant(name)


def json_text(value: str) -> str:
    """A string as RFC 8785 writes it (used for paths and messages)."""
    try:
        return canonicalize(value)
    except CanonicalizationError:
        return json.dumps(value)


def format_path(base: str, key: object) -> str:
    """Append a member name or array index to a field path."""
    if isinstance(key, int):
        return f"{base}[{key}]"
    name = str(key)
    simple = (
        name != ""
        and name[0] in _IDENTIFIER_FIRST
        and all(char in _IDENTIFIER_REST for char in name)
    )
    if simple:
        return f"{base}.{name}" if base else name
    return f"{base}[{json_text(name)}]"


def _find_bad_number(value: Any) -> bool:
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, bool):
            continue
        if isinstance(item, float):
            if not math.isfinite(item):
                return True
        elif isinstance(item, int):
            try:
                int_to_double(item)
            except CanonicalizationError:
                return True
        elif isinstance(item, list):
            stack.extend(item)
        elif isinstance(item, dict):
            stack.extend(item.values())
    return False


def _in_number(buffer: bytes, index: int) -> bool:
    start = index
    while start > 0 and buffer[start - 1] in _NUMBER_BYTES:
        start -= 1
    if start == 0 or buffer[start - 1] not in _NUMBER_OPENERS:
        return False
    return start < index or (index < len(buffer) and buffer[index] in _NUMBER_BYTES)


def parse_canonical(data: bytes, max_bytes: int = DEFAULT_MAX_BYTES) -> Any:
    """Parse package bytes, refusing anything that is not canonical JSON."""
    if len(data) > max_bytes:
        raise VerificationFailure(
            VerificationCode.TOO_LARGE,
            f"package is {len(data)} bytes; the limit is {max_bytes}",
        )
    if data.startswith(b"\xef\xbb\xbf"):
        raise VerificationFailure(
            VerificationCode.MALFORMED_JSON, "package starts with a byte-order mark"
        )
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise VerificationFailure(
            VerificationCode.MALFORMED_JSON, f"package is not UTF-8: {exc.reason}"
        ) from None
    try:
        value = json.loads(text, object_pairs_hook=_pairs, parse_constant=_constant)
    except _DuplicateKey as exc:
        raise VerificationFailure(
            VerificationCode.DUPLICATE_KEY,
            f"member {json_text(exc.name)} appears more than once in one object",
        ) from None
    except _BadConstant as exc:
        raise VerificationFailure(
            VerificationCode.NON_CANONICAL_NUMBER, f"{exc.args[0]} is not a JSON number"
        ) from None
    except (ValueError, RecursionError) as exc:
        raise VerificationFailure(
            VerificationCode.MALFORMED_JSON, f"package is not valid JSON: {exc}"
        ) from None

    if _find_bad_number(value):
        raise VerificationFailure(
            VerificationCode.NON_CANONICAL_NUMBER,
            "a number has no exact IEEE-754 double form",
        )
    try:
        canonical = canonicalize(value).encode("utf-8")
    except CanonicalizationError as exc:
        raise VerificationFailure(
            VerificationCode.NON_CANONICAL_DOCUMENT,
            f"package has no canonical form: {exc}",
        ) from None

    body = data[:-1] if data.endswith(b"\n") else data
    if body != canonical:
        index = 0
        limit = min(len(body), len(canonical))
        while index < limit and body[index] == canonical[index]:
            index += 1
        if _in_number(body, index):
            raise VerificationFailure(
                VerificationCode.NON_CANONICAL_NUMBER,
                f"number at byte {index} is not in RFC 8785 form",
            )
        raise VerificationFailure(
            VerificationCode.NON_CANONICAL_DOCUMENT,
            f"package bytes differ from their RFC 8785 form at byte {index}",
        )
    return value
