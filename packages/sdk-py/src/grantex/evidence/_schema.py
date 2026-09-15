"""A small, deterministic interpreter for the evidence package JSON Schema.

The verifier validates structure directly against
``spec/evidence-package-1.0.schema.json`` (embedded as ``schema-1.0.json``),
so the published schema is the single source of structural rules. Only the
keywords that file uses are supported; any other keyword makes the schema
itself invalid, so an edit to the schema cannot silently weaken verification.

Evaluation order is fixed so that the Python and TypeScript verifiers report
the same first violation: for objects, unknown members (in RFC 8785 member
order), then missing required members (same order), then ``maxProperties``,
then each present member (same order), then ``allOf``; for arrays, size
limits, then items in index order, then ``uniqueItems``.
"""

from __future__ import annotations

import json
import re
from importlib import resources
from typing import Any, Dict, List, Mapping, Optional, Pattern, Tuple, Union

from ._canonical import canonicalize
from ._document import format_path
from ._result import VerificationCode, VerificationFailure

__all__ = ["load_schema", "validate", "SCHEMA_KEYWORDS", "matches", "is_valid_timestamp", "timestamp_ms"]

Path = Tuple[Union[str, int], ...]

SCHEMA_KEYWORDS = frozenset(
    {
        "$schema",
        "$id",
        "$defs",
        "$ref",
        "title",
        "description",
        "type",
        "const",
        "enum",
        "minLength",
        "maxLength",
        "pattern",
        "format",
        "minimum",
        "maximum",
        "minItems",
        "maxItems",
        "items",
        "uniqueItems",
        "properties",
        "required",
        "additionalProperties",
        "propertyNames",
        "maxProperties",
        "allOf",
        "if",
        "then",
    }
)

_PATTERNS: Dict[str, Pattern[str]] = {}
_TIMESTAMP = re.compile(
    r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})[.]([0-9]{3})Z"
)
_DAYS = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)


def _parse_timestamp(value: str) -> Optional[Tuple[int, int, int, int, int, int, int]]:
    match = _TIMESTAMP.match(value) if len(value) == 24 else None
    if match is None:
        return None
    year, month, day, hour, minute, second, milli = (int(g) for g in match.groups())
    if year < 1 or not 1 <= month <= 12 or hour > 23 or minute > 59 or second > 59:
        return None
    leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
    days = 29 if month == 2 and leap else _DAYS[month - 1]
    if not 1 <= day <= days:
        return None
    return year, month, day, hour, minute, second, milli


def is_valid_timestamp(value: object) -> bool:
    """``YYYY-MM-DDTHH:MM:SS.sssZ`` naming a real calendar instant (no leap seconds)."""
    return isinstance(value, str) and _parse_timestamp(value) is not None


def timestamp_ms(value: str) -> int:
    """Milliseconds since the epoch of a valid timestamp."""
    parts = _parse_timestamp(value)
    if parts is None:
        raise ValueError(f"invalid timestamp {value!r}")
    year, month, day, hour, minute, second, milli = parts
    # Days from civil (proleptic Gregorian), exact for years 1-9999.
    y = year - (1 if month <= 2 else 0)
    era = y // 400
    yoe = y - era * 400
    doy = (153 * (month + (-3 if month > 2 else 9)) + 2) // 5 + day - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    days = era * 146097 + doe - 719468
    return (((days * 24 + hour) * 60 + minute) * 60 + second) * 1000 + milli
_SCHEMA: Optional[Dict[str, Any]] = None


def load_schema() -> Dict[str, Any]:
    """Return the embedded evidence package 1.0 schema."""
    global _SCHEMA
    if _SCHEMA is None:
        text = (
            resources.files("grantex.evidence")
            .joinpath("schema-1.0.json")
            .read_text(encoding="utf-8")
        )
        schema = json.loads(text)
        _check_keywords(schema, "#")
        _SCHEMA = schema
    return _SCHEMA


def _check_keywords(node: Any, where: str) -> None:
    if not isinstance(node, dict):
        return
    for key, value in node.items():
        if key not in SCHEMA_KEYWORDS:
            raise ValueError(f"unsupported schema keyword {key!r} at {where}")
        if key in ("properties", "$defs"):
            for name, child in value.items():
                _check_keywords(child, f"{where}/{key}/{name}")
        elif key in ("items", "additionalProperties", "propertyNames", "if", "then"):
            _check_keywords(value, f"{where}/{key}")
        elif key == "allOf":
            for index, child in enumerate(value):
                _check_keywords(child, f"{where}/allOf/{index}")


def _pattern(source: str) -> Pattern[str]:
    compiled = _PATTERNS.get(source)
    if compiled is None:
        # ECMAScript "$" never matches before a trailing newline; Python's does.
        python_source = source[:-1] + r"\Z" if source.endswith("$") else source
        compiled = re.compile(python_source)
        _PATTERNS[source] = compiled
    return compiled


def _utf16_key(name: str) -> bytes:
    return name.encode("utf-16-be", "surrogatepass")


def _type_of(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    return "object"


def _is_integer(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and value.is_integer()


def _has_type(value: Any, expected: str) -> bool:
    actual = _type_of(value)
    if expected == "integer":
        return _is_integer(value)
    return actual == expected


def _same(a: Any, b: Any) -> bool:
    kind = _type_of(a)
    if kind != _type_of(b):
        return False
    if kind in ("array", "object"):
        return canonicalize(a) == canonicalize(b)
    return bool(a == b)


def _join(path: Path) -> str:
    text = ""
    for part in path:
        text = format_path(text, part)
    return text or "$"


def _fail(path: Path, message: str) -> VerificationFailure:
    return VerificationFailure(
        VerificationCode.SCHEMA_VIOLATION, message, field_path=_join(path)
    )


def _resolve(schema: Mapping[str, Any], root: Mapping[str, Any]) -> Mapping[str, Any]:
    while "$ref" in schema:
        ref = schema["$ref"]
        if not isinstance(ref, str) or not ref.startswith("#/$defs/"):
            raise ValueError(f"unsupported $ref {ref!r}")
        schema = root["$defs"][ref[len("#/$defs/") :]]
    return schema


def matches(value: Any, schema: Mapping[str, Any], root: Mapping[str, Any]) -> bool:
    """Whether ``value`` satisfies ``schema`` (used for ``if``)."""
    try:
        _validate(value, schema, root, ())
    except VerificationFailure:
        return False
    return True


def validate(value: Any, schema: Optional[Mapping[str, Any]] = None) -> None:
    """Raise ``VerificationFailure(schema_violation)`` at the first violation."""
    root = schema if schema is not None else load_schema()
    _validate(value, root, root, ())


def _validate(
    value: Any, schema: Mapping[str, Any], root: Mapping[str, Any], path: Path
) -> None:
    schema = _resolve(schema, root)

    if "type" in schema:
        types = schema["type"]
        allowed: List[str] = types if isinstance(types, list) else [types]
        if not any(_has_type(value, t) for t in allowed):
            raise _fail(path, f"expected {' or '.join(allowed)}, found {_type_of(value)}")
    if "const" in schema and not _same(value, schema["const"]):
        raise _fail(path, f"must be {canonicalize(schema['const'])}")
    if "enum" in schema and not any(_same(value, option) for option in schema["enum"]):
        raise _fail(path, "must be one of " + ", ".join(canonicalize(o) for o in schema["enum"]))

    kind = _type_of(value)
    if kind == "string":
        length = len(value)
        if "minLength" in schema and length < schema["minLength"]:
            raise _fail(path, f"shorter than {schema['minLength']} characters")
        if "maxLength" in schema and length > schema["maxLength"]:
            raise _fail(path, f"longer than {schema['maxLength']} characters")
        if "pattern" in schema and not _pattern(schema["pattern"]).search(value):
            raise _fail(path, f"does not match {schema['pattern']}")
        if schema.get("format") == "date-time" and not is_valid_timestamp(value):
            raise _fail(path, "not a valid UTC timestamp with millisecond precision")
    elif kind == "number":
        if "minimum" in schema and value < schema["minimum"]:
            raise _fail(path, f"less than {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            raise _fail(path, f"greater than {schema['maximum']}")
    elif kind == "array":
        _validate_array(value, schema, root, path)
    elif kind == "object":
        _validate_object(value, schema, root, path)


def _validate_array(
    value: List[Any], schema: Mapping[str, Any], root: Mapping[str, Any], path: Path
) -> None:
    if "minItems" in schema and len(value) < schema["minItems"]:
        raise _fail(path, f"fewer than {schema['minItems']} items")
    if "maxItems" in schema and len(value) > schema["maxItems"]:
        raise _fail(path, f"more than {schema['maxItems']} items")
    if "items" in schema:
        for index, item in enumerate(value):
            _validate(item, schema["items"], root, path + (index,))
    if schema.get("uniqueItems"):
        seen = set()
        for index, item in enumerate(value):
            key = _type_of(item) + canonicalize(item)
            if key in seen:
                raise _fail(path + (index,), "duplicate item")
            seen.add(key)


def _validate_object(
    value: Dict[str, Any], schema: Mapping[str, Any], root: Mapping[str, Any], path: Path
) -> None:
    properties: Mapping[str, Any] = schema.get("properties", {})
    names = sorted(value, key=_utf16_key)
    additional = schema.get("additionalProperties", True)

    for name in names:
        if name not in properties and additional is False:
            raise _fail(path + (name,), "unknown member")
    if "propertyNames" in schema:
        for name in names:
            if not matches(name, schema["propertyNames"], root):
                raise _fail(path + (name,), "member name not allowed")
    for name in sorted(schema.get("required", []), key=_utf16_key):
        if name not in value:
            raise _fail(path + (name,), "required member is missing")
    if "maxProperties" in schema and len(value) > schema["maxProperties"]:
        raise _fail(path, f"more than {schema['maxProperties']} members")
    for name in names:
        child = path + (name,)
        if name in properties:
            _validate(value[name], properties[name], root, child)
        elif isinstance(additional, dict):
            _validate(value[name], additional, root, child)
    for clause in schema.get("allOf", []):
        condition = clause.get("if")
        if condition is None or matches(value, condition, root):
            if "then" in clause:
                _validate(value, clause["then"], root, path)
