"""JSON Canonicalization Scheme (RFC 8785).

:func:`canonicalize` turns a JSON value into its canonical UTF-8 text: object
members sorted by the UTF-16 code units of their names, no insignificant
whitespace, strings escaped as ECMAScript ``JSON.stringify`` escapes them and
numbers serialised as IEEE-754 doubles in the ECMAScript ``Number`` format.
Two values that differ only in member order, whitespace or number spelling
(``1.0`` and ``1``, ``1E3`` and ``1000``) canonicalise to the same bytes.

The input must be I-JSON (RFC 7493). Anything that has no single canonical
form is refused with :class:`CanonicalizationError` rather than coerced:

- ``NaN`` and infinities;
- integers whose digits are not the canonical form of a double, such as
  ``2**53 + 1`` (write them as strings);
- strings or member names containing an unpaired UTF-16 surrogate;
- member names that are not strings, and any value that is not ``None``,
  ``bool``, ``int``, ``float``, ``str``, a list, a tuple or a dict;
- nesting deeper than :data:`MAX_DEPTH`.

No Unicode normalisation is applied: strings are compared code point for
code point, as RFC 8785 requires.

The TypeScript SDK implements the same rules in ``canonical.ts``; both are
tested against the RFC 8785 test vectors and the shared fixtures in
``spec/examples/canonicalization/``.
"""

from __future__ import annotations

import math
from typing import Any, List

__all__ = [
    "MAX_DEPTH",
    "MAX_SAFE_INTEGER",
    "CanonicalizationError",
    "canonicalize",
    "canonicalize_bytes",
    "int_to_double",
    "serialize_number",
]

MAX_SAFE_INTEGER = 2**53 - 1
"""Largest integer magnitude a double represents exactly."""

MAX_DEPTH = 64
"""Deepest nesting of arrays and objects accepted."""

_SHORT_ESCAPES = {
    0x08: "\\b",
    0x09: "\\t",
    0x0A: "\\n",
    0x0C: "\\f",
    0x0D: "\\r",
    0x22: '\\"',
    0x5C: "\\\\",
}


class CanonicalizationError(ValueError):
    """The value has no RFC 8785 canonical form."""


def canonicalize(value: Any) -> str:
    """Return the RFC 8785 canonical JSON text of ``value``."""
    out: List[str] = []
    _write(value, out, 0)
    return "".join(out)


def canonicalize_bytes(value: Any) -> bytes:
    """Return the RFC 8785 canonical JSON of ``value`` as UTF-8 bytes."""
    return canonicalize(value).encode("utf-8")


def serialize_number(value: float) -> str:
    """Serialise a finite double as ECMAScript ``Number.prototype.toString`` does.

    Python's ``repr`` of a float is the shortest decimal that round-trips,
    which is the digit string ECMAScript selects; only the layout (where the
    decimal point goes, when an exponent is used) differs, and that is
    rebuilt here from the digits and the decimal exponent.
    """
    if isinstance(value, bool) or not isinstance(value, float):
        raise CanonicalizationError("serialize_number expects a float")
    if not math.isfinite(value):
        raise CanonicalizationError("NaN and infinite numbers have no JSON form")
    if value == 0.0:
        return "0"  # also -0.0

    # float.__repr__, not repr(): a float subclass may override __repr__.
    text = float.__repr__(value)
    sign = ""
    if text[0] == "-":
        sign, text = "-", text[1:]
    mantissa, _, exponent = text.partition("e")
    int_part, _, frac_part = mantissa.partition(".")
    digits = int_part + frac_part
    # value == 0.<digits> * 10**point
    point = len(int_part) + (int(exponent) if exponent else 0)
    stripped = digits.lstrip("0")
    point -= len(digits) - len(stripped)
    digits = stripped.rstrip("0")

    k = len(digits)
    n = point
    if k <= n <= 21:
        body = digits + "0" * (n - k)
    elif 0 < n <= 21:
        body = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        body = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        exp_text = ("+" if e >= 0 else "-") + str(abs(e))
        body = (digits if k == 1 else digits[0] + "." + digits[1:]) + "e" + exp_text
    return sign + body


def int_to_double(value: int) -> float:
    """Convert an integer to the double with the same value, or refuse.

    ECMAScript parses every JSON number as a double. An integer outside
    ``[-(2**53 - 1), 2**53 - 1]`` is accepted only when its decimal digits are
    already the canonical form of the nearest double (``1152921504606847000``
    is; ``2**53 + 1`` and ``2**60`` are not): otherwise canonicalising would
    silently change the value, so it is refused.
    """
    value = int.__int__(value)
    if -MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER:
        return float(value)
    try:
        converted = float(value)
    except OverflowError:
        raise CanonicalizationError("integer too large for a double") from None
    if serialize_number(converted) != int.__repr__(value):
        raise CanonicalizationError(
            "integer not exactly representable as a double; write it as a string"
        )
    return converted


def _write(value: Any, out: List[str], depth: int) -> None:
    if value is None:
        out.append("null")
    elif value is True:
        out.append("true")
    elif value is False:
        out.append("false")
    elif isinstance(value, int):
        # int.__int__ strips a subclass (IntEnum and the like) to its value.
        out.append(serialize_number(int_to_double(int.__int__(value))))
    elif isinstance(value, float):
        out.append(serialize_number(float(float.__float__(value))))
    elif isinstance(value, str):
        _write_string(str.__str__(value), out)
    elif isinstance(value, (list, tuple)):
        if depth >= MAX_DEPTH:
            raise CanonicalizationError(f"nesting deeper than {MAX_DEPTH} levels")
        out.append("[")
        for index, item in enumerate(value):
            if index:
                out.append(",")
            _write(item, out, depth + 1)
        out.append("]")
    elif isinstance(value, dict):
        if depth >= MAX_DEPTH:
            raise CanonicalizationError(f"nesting deeper than {MAX_DEPTH} levels")
        for key in value:
            if not isinstance(key, str):
                raise CanonicalizationError("object member names must be strings")
        out.append("{")
        for index, key in enumerate(sorted(value, key=_utf16_sort_key)):
            if index:
                out.append(",")
            _write_string(key, out)
            out.append(":")
            _write(value[key], out, depth + 1)
        out.append("}")
    else:
        raise CanonicalizationError(
            f"value of type {type(value).__name__} has no JSON form"
        )


def _utf16_sort_key(name: str) -> bytes:
    # Big-endian UTF-16 bytes compare in the same order as the code units.
    try:
        return name.encode("utf-16-be")
    except UnicodeEncodeError:
        raise CanonicalizationError(
            "object member name contains an unpaired surrogate"
        ) from None


def _write_string(value: str, out: List[str]) -> None:
    parts = ['"']
    for char in value:
        code = ord(char)
        if 0xD800 <= code <= 0xDFFF:
            raise CanonicalizationError("string contains an unpaired surrogate")
        short = _SHORT_ESCAPES.get(code)
        if short is not None:
            parts.append(short)
        elif code < 0x20:
            parts.append(f"\\u{code:04x}")
        else:
            parts.append(char)
    parts.append('"')
    out.append("".join(parts))
