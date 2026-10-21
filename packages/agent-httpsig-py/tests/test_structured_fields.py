# SPDX-License-Identifier: Apache-2.0
"""RFC 9651 parsing (section 4.2) and serialization (section 4.1).

The same cases as packages/agent-httpsig/tests/structured-fields.test.ts.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from grantex_agent_httpsig import (
    AgentHttpSigError,
    Date,
    DisplayString,
    Item,
    Token,
    parse_dictionary,
    parse_item,
    parse_list,
    serialize_dictionary,
    serialize_item,
    serialize_list,
)

ROUND_TRIPS = [
    # RFC 9421 section 2.1.1: strict re-serialization of a Dictionary.
    ("a=1,    b=2;x=1;y=2,   c=(a   b   c)", "dictionary", "a=1, b=2;x=1;y=2, c=(a b c)"),
    # RFC 9651 section 3.1.2 ("; cde_456" is a parameter of abc: section 4.2.3.2
    # skips SP after ";").
    (
        'abc;a=1;b=2; cde_456, (ghi;jk=4 l);q="9";r=w',
        "list",
        'abc;a=1;b=2;cde_456, (ghi;jk=4 l);q="9";r=w',
    ),
    ("1; a; b=?0", "item", "1;a;b=?0"),
    # Boolean true members and parameters are serialized without a value.
    ("a, b;x, c=?0", "dictionary", "a, b;x, c=?0"),
    # Duplicate keys: the last value wins, in the first key's position.
    ("a=1, b=2, a=3", "dictionary", "a=3, b=2"),
    ('"hello \\"world\\" \\\\"', "item", '"hello \\"world\\" \\\\"'),
    ("foo123/456", "item", "foo123/456"),
    ("-999999999999999", "item", "-999999999999999"),
    ("1.50", "item", "1.5"),
    ("-0.0", "item", "0.0"),
    ("4.000", "item", "4.0"),
    ("?1", "item", "?1"),
    ("@1659578233", "item", "@1659578233"),
    (
        '%"This is intended for display to %c3%bcsers."',
        "item",
        '%"This is intended for display to %c3%bcsers."',
    ),
    (
        ":cHJldGVuZCB0aGlzIGlzIGJpbmFyeSBjb250ZW50Lg==:",
        "item",
        ":cHJldGVuZCB0aGlzIGlzIGJpbmFyeSBjb250ZW50Lg==:",
    ),
    # Missing padding is accepted and restored (section 4.2.7).
    (
        ":cHJldGVuZCB0aGlzIGlzIGJpbmFyeSBjb250ZW50Lg:",
        "item",
        ":cHJldGVuZCB0aGlzIGlzIGJpbmFyeSBjb250ZW50Lg==:",
    ),
    (
        '  sig1=("@method" "@path");created=1618884473;keyid="k"  ',
        "dictionary",
        'sig1=("@method" "@path");created=1618884473;keyid="k"',
    ),
    ("()", "list", "()"),
]

FAILURES = [
    ("a=1,", "dictionary"),
    ("A=1", "dictionary"),
    ("a=1 b=2", "dictionary"),
    ('"\\a"', "item"),
    ('"unterminated', "item"),
    ('"tab\there"', "item"),
    ("1234567890123456", "item"),
    ("1.5000", "item"),
    ("1234567890123.5", "item"),
    ("1.", "item"),
    ("-", "item"),
    ("?2", "item"),
    ("@1.5", "item"),
    (":a*b:", "item"),
    (":Y=Q=:", "item"),
    (":YQ==", "item"),
    ('%"%C3%BC"', "item"),
    ('%"%c3"', "item"),
    ("café", "item"),
    ("(a b", "list"),
    ("a, ", "list"),
    ("1 2", "item"),
    ("", "item"),
]


def _round_trip(text: str, kind: str) -> str:
    if kind == "dictionary":
        return serialize_dictionary(parse_dictionary(text))
    if kind == "list":
        return serialize_list(parse_list(text))
    return serialize_item(parse_item(text))


@pytest.mark.parametrize("text,kind,expected", ROUND_TRIPS)
def test_round_trips(text: str, kind: str, expected: str) -> None:
    assert _round_trip(text, kind) == expected


@pytest.mark.parametrize("text,kind", FAILURES)
def test_failures(text: str, kind: str) -> None:
    with pytest.raises(AgentHttpSigError):
        _round_trip(text, kind)


def test_bare_items_decode_to_typed_values() -> None:
    assert parse_item("42").value == 42
    assert parse_item("1.25").value == Decimal("1.25")
    assert parse_item('"a\\"b"').value == 'a"b'
    token = parse_item("*tok:en/1").value
    assert isinstance(token, Token) and token == "*tok:en/1"
    assert parse_item("?0").value is False
    date = parse_item("@-1").value
    assert isinstance(date, Date) and date == -1
    display = parse_item('%"%c3%bc"').value
    assert isinstance(display, DisplayString) and display == "ü"
    assert parse_item(":cHJldGVuZCB0aGlzIGlzIGJpbmFyeSBjb250ZW50Lg==:").value == (
        b"pretend this is binary content."
    )


def test_empty_list_and_dictionary_serialize_to_empty_string() -> None:
    assert serialize_list(parse_list("")) == ""
    assert serialize_dictionary(parse_dictionary("")) == ""


def test_serialization_refusals() -> None:
    with pytest.raises(AgentHttpSigError):
        serialize_item(Item("a\nb"))
    with pytest.raises(AgentHttpSigError):
        serialize_item(Item(10**15))
    with pytest.raises(AgentHttpSigError):
        serialize_item(Item(Token("1abc")))
