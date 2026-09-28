# SPDX-License-Identifier: Apache-2.0
"""Structured Field Values for HTTP, RFC 9651.

Parsing (section 4.2) and serialization (section 4.1). RFC 9421 relies on
both (sections 2.1.1, 2.3, 4.1, 4.2), and its section 7.5.3 warns that a lax
parser opens attacks on the signature base, so this follows the RFC's
algorithms step by step and fails on anything they fail on.

Bare items map to Python types: Integer ``int``, Decimal ``decimal.Decimal``,
String ``str``, Token :class:`Token`, Byte Sequence ``bytes``, Boolean
``bool``, Date :class:`Date` and Display String :class:`DisplayString`.
"""

from __future__ import annotations

import base64
import binascii
import re
from dataclasses import dataclass, field
from decimal import ROUND_HALF_EVEN, Decimal
from typing import Dict, List, Union

from ._errors import AgentHttpSigError


class Token(str):
    """An RFC 9651 Token (section 3.3.4)."""


class DisplayString(str):
    """An RFC 9651 Display String (section 3.3.8)."""


class Date(int):
    """An RFC 9651 Date (section 3.3.7), in UNIX seconds."""


BareItem = Union[int, Decimal, str, bytes, bool]
Parameters = Dict[str, BareItem]


@dataclass
class Item:
    value: BareItem
    params: Parameters = field(default_factory=dict)


@dataclass
class InnerList:
    items: List[Item]
    params: Parameters = field(default_factory=dict)


Member = Union[Item, InnerList]
Dictionary = Dict[str, Member]
SfList = List[Member]

_MAX_INTEGER = 999_999_999_999_999
_TCHAR = "!#$%&'*+-.^_`|~"
_BASE64 = re.compile(r"[A-Za-z0-9+/]*={0,2}")
_KEY = re.compile(r"[a-z*][a-z0-9_\-.*]*")
_TOKEN = re.compile(r"[A-Za-z*][A-Za-z0-9!#$%&'*+\-.^_`|~:/]*")
_HEX = re.compile(r"[0-9a-f]{2}")


def _fail(message: str) -> AgentHttpSigError:
    return AgentHttpSigError("structured field: " + message)


def _is_digit(c: str) -> bool:
    return "0" <= c <= "9"


def _is_lcalpha(c: str) -> bool:
    return "a" <= c <= "z"


def _is_alpha(c: str) -> bool:
    return "a" <= c <= "z" or "A" <= c <= "Z"


def _is_tchar(c: str) -> bool:
    return c != "" and (_is_alpha(c) or _is_digit(c) or c in _TCHAR)


def _is_key_char(c: str) -> bool:
    return c != "" and (_is_lcalpha(c) or _is_digit(c) or c in "_-.*")


def decode_base64(text: str) -> bytes:
    """Standard base64 as RFC 9651 section 4.2.7 accepts it.

    Characters outside the alphabet fail, missing padding is synthesized, and
    "=" may only end the value.
    """
    if not _BASE64.fullmatch(text):
        raise _fail("invalid base64")
    unpadded = text.rstrip("=")
    if len(unpadded) % 4 == 1:
        raise _fail("invalid base64 length")
    try:
        return base64.b64decode(unpadded + "=" * (-len(unpadded) % 4), validate=True)
    except binascii.Error as exc:
        # Unreachable after the checks above; a decoding error still fails parsing.
        raise _fail("invalid base64") from exc


def encode_base64(data: bytes) -> str:
    """Padded standard base64 (RFC 9651 section 4.1.8)."""
    return base64.b64encode(data).decode("ascii")


class _Parser:
    def __init__(self, text: str) -> None:
        # Section 4.2 step 1: the field value must be ASCII.
        if any(ord(c) > 0x7F for c in text):
            raise _fail("non-ASCII input")
        self.s = text
        self.pos = 0

    @property
    def done(self) -> bool:
        return self.pos >= len(self.s)

    def peek(self) -> str:
        return self.s[self.pos] if self.pos < len(self.s) else ""

    def take(self) -> str:
        c = self.peek()
        self.pos += 1
        return c

    def skip_sp(self) -> None:
        while self.peek() == " ":
            self.pos += 1

    def skip_ows(self) -> None:
        while self.peek() in (" ", "\t") and not self.done:
            self.pos += 1

    # Section 4.2.1
    def parse_list(self) -> SfList:
        members: SfList = []
        while not self.done:
            members.append(self.parse_item_or_inner_list())
            self.skip_ows()
            if self.done:
                return members
            if self.take() != ",":
                raise _fail('expected "," in list')
            self.skip_ows()
            if self.done:
                raise _fail("trailing comma in list")
        return members

    # Section 4.2.1.1
    def parse_item_or_inner_list(self) -> Member:
        return self.parse_inner_list() if self.peek() == "(" else self.parse_item()

    # Section 4.2.1.2
    def parse_inner_list(self) -> InnerList:
        if self.take() != "(":
            raise _fail('expected "("')
        items: list[Item] = []
        while not self.done:
            self.skip_sp()
            if self.peek() == ")":
                self.pos += 1
                return InnerList(items, self.parse_parameters())
            items.append(self.parse_item())
            if self.peek() not in (" ", ")") or self.done:
                raise _fail('expected SP or ")" in inner list')
        raise _fail("unterminated inner list")

    # Section 4.2.2
    def parse_dictionary(self) -> Dictionary:
        dictionary: Dictionary = {}
        while not self.done:
            key = self.parse_key()
            member: Member
            if self.peek() == "=":
                self.pos += 1
                member = self.parse_item_or_inner_list()
            else:
                member = Item(True, self.parse_parameters())
            # Step 2.4: a repeated key overwrites the value and keeps its position.
            dictionary[key] = member
            self.skip_ows()
            if self.done:
                return dictionary
            if self.take() != ",":
                raise _fail('expected "," in dictionary')
            self.skip_ows()
            if self.done:
                raise _fail("trailing comma in dictionary")
        return dictionary

    # Section 4.2.3
    def parse_item(self) -> Item:
        value = self.parse_bare_item()
        return Item(value, self.parse_parameters())

    # Section 4.2.3.1
    def parse_bare_item(self) -> BareItem:
        c = self.peek()
        if c == "-" or (c != "" and _is_digit(c)):
            return self.parse_number()
        if c == '"':
            return self.parse_string()
        if c != "" and (_is_alpha(c) or c == "*"):
            return Token(self.parse_token())
        if c == ":":
            return self.parse_byte_sequence()
        if c == "?":
            return self.parse_boolean()
        if c == "@":
            return self.parse_date()
        if c == "%":
            return DisplayString(self.parse_display_string())
        raise _fail("unrecognized item")

    # Section 4.2.3.2
    def parse_parameters(self) -> Parameters:
        params: Parameters = {}
        while self.peek() == ";":
            self.pos += 1
            self.skip_sp()
            key = self.parse_key()
            value: BareItem = True
            if self.peek() == "=":
                self.pos += 1
                value = self.parse_bare_item()
            params[key] = value
        return params

    # Section 4.2.3.3
    def parse_key(self) -> str:
        first = self.peek()
        if not (first != "" and (_is_lcalpha(first) or first == "*")):
            raise _fail("invalid key")
        start = self.pos
        while _is_key_char(self.peek()):
            self.pos += 1
        return self.s[start : self.pos]

    # Section 4.2.4
    def parse_number(self) -> Union[int, Decimal]:
        is_decimal = False
        sign = ""
        digits = ""
        if self.peek() == "-":
            self.pos += 1
            sign = "-"
        if self.done:
            raise _fail("empty integer")
        if not _is_digit(self.peek()):
            raise _fail("expected a digit")
        while not self.done:
            c = self.peek()
            if _is_digit(c):
                digits += c
                self.pos += 1
            elif not is_decimal and c == ".":
                if len(digits) > 12:
                    raise _fail("decimal integer part too long")
                digits += c
                is_decimal = True
                self.pos += 1
            else:
                break
            if not is_decimal and len(digits) > 15:
                raise _fail("integer too long")
            if is_decimal and len(digits) > 16:
                raise _fail("decimal too long")
        if not is_decimal:
            return int(sign + digits)
        if digits.endswith("."):
            raise _fail('decimal ends with "."')
        if len(digits) - digits.index(".") - 1 > 3:
            raise _fail("decimal has more than three fractional digits")
        return Decimal(sign + digits)

    # Section 4.2.5
    def parse_string(self) -> str:
        if self.take() != '"':
            raise _fail("expected DQUOTE")
        out: list[str] = []
        while not self.done:
            c = self.take()
            if c == "\\":
                if self.done:
                    raise _fail("unterminated escape")
                nxt = self.take()
                if nxt not in ('"', "\\"):
                    raise _fail("invalid escape")
                out.append(nxt)
            elif c == '"':
                return "".join(out)
            elif ord(c) < 0x20 or ord(c) > 0x7E:
                raise _fail("invalid character in string")
            else:
                out.append(c)
        raise _fail("unterminated string")

    # Section 4.2.6
    def parse_token(self) -> str:
        first = self.peek()
        if not (first != "" and (_is_alpha(first) or first == "*")):
            raise _fail("invalid token")
        start = self.pos
        while not self.done:
            c = self.peek()
            if not _is_tchar(c) and c not in (":", "/"):
                break
            self.pos += 1
        return self.s[start : self.pos]

    # Section 4.2.7
    def parse_byte_sequence(self) -> bytes:
        if self.take() != ":":
            raise _fail('expected ":"')
        end = self.s.find(":", self.pos)
        if end == -1:
            raise _fail("unterminated byte sequence")
        content = self.s[self.pos : end]
        self.pos = end + 1
        return decode_base64(content)

    # Section 4.2.8
    def parse_boolean(self) -> bool:
        if self.take() != "?":
            raise _fail('expected "?"')
        c = self.peek()
        if c in ("1", "0") and c != "":
            self.pos += 1
            return c == "1"
        raise _fail("invalid boolean")

    # Section 4.2.9
    def parse_date(self) -> Date:
        if self.take() != "@":
            raise _fail('expected "@"')
        n = self.parse_number()
        if isinstance(n, Decimal):
            raise _fail("date is not an integer")
        return Date(n)

    # Section 4.2.10
    def parse_display_string(self) -> str:
        if self.s[self.pos : self.pos + 2] != '%"':
            raise _fail('expected %"')
        self.pos += 2
        data = bytearray()
        while not self.done:
            c = self.take()
            if ord(c) < 0x20 or ord(c) > 0x7E:
                raise _fail("invalid character in display string")
            if c == "%":
                hex_ = self.s[self.pos : self.pos + 2]
                if not _HEX.fullmatch(hex_):
                    raise _fail("invalid percent-encoding in display string")
                data.append(int(hex_, 16))
                self.pos += 2
            elif c == '"':
                try:
                    return bytes(data).decode("utf-8")
                except UnicodeDecodeError as exc:
                    # Invalid UTF-8 fails parsing (step 4.4.1).
                    raise _fail("display string is not UTF-8") from exc
            else:
                data.append(ord(c))
        raise _fail("unterminated display string")


def _parse_field(text: str, kind: str) -> object:
    # Section 4.2 steps 2, 6 and 7: surrounding spaces are discarded and
    # nothing may follow the value.
    p = _Parser(text)
    p.skip_sp()
    out: object
    if kind == "list":
        out = p.parse_list()
    elif kind == "dictionary":
        out = p.parse_dictionary()
    else:
        out = p.parse_item()
    p.skip_sp()
    if not p.done:
        raise _fail("unexpected characters after the value")
    return out


def parse_list(text: str) -> SfList:
    out = _parse_field(text, "list")
    assert isinstance(out, list)
    return out


def parse_dictionary(text: str) -> Dictionary:
    out = _parse_field(text, "dictionary")
    assert isinstance(out, dict)
    return out


def parse_item(text: str) -> Item:
    out = _parse_field(text, "item")
    assert isinstance(out, Item)
    return out


# Section 4.1.1
def serialize_list(members: SfList) -> str:
    return ", ".join(_serialize_member(m) for m in members)


def _serialize_member(member: Member) -> str:
    if isinstance(member, InnerList):
        return serialize_inner_list(member)
    return serialize_item(member)


# Section 4.1.1.1
def serialize_inner_list(inner: InnerList) -> str:
    return (
        "(" + " ".join(serialize_item(i) for i in inner.items) + ")"
        + serialize_parameters(inner.params)
    )


# Section 4.1.1.2
def serialize_parameters(params: Parameters) -> str:
    out = ""
    for key, value in params.items():
        out += ";" + serialize_key(key)
        if value is not True:
            out += "=" + serialize_bare_item(value)
    return out


# Section 4.1.1.3
def serialize_key(key: str) -> str:
    if not _KEY.fullmatch(key):
        raise _fail("invalid key %r" % key)
    return key


# Section 4.1.2
def serialize_dictionary(dictionary: Dictionary) -> str:
    out: list[str] = []
    for key, member in dictionary.items():
        if isinstance(member, Item) and member.value is True:
            out.append(serialize_key(key) + serialize_parameters(member.params))
        else:
            out.append(serialize_key(key) + "=" + _serialize_member(member))
    return ", ".join(out)


# Section 4.1.3
def serialize_item(item: Item) -> str:
    return serialize_bare_item(item.value) + serialize_parameters(item.params)


# Section 4.1.3.1
def serialize_bare_item(value: BareItem) -> str:
    if isinstance(value, bool):
        # Section 4.1.9
        return "?1" if value else "?0"
    if isinstance(value, Date):
        # Section 4.1.10
        return "@" + _serialize_integer(int(value))
    if isinstance(value, int):
        return _serialize_integer(value)
    if isinstance(value, Decimal):
        return _serialize_decimal(value)
    if isinstance(value, Token):
        # Section 4.1.7
        if not _TOKEN.fullmatch(value):
            raise _fail("invalid token")
        return str(value)
    if isinstance(value, DisplayString):
        return _serialize_display_string(value)
    if isinstance(value, str):
        return _serialize_string(value)
    if isinstance(value, bytes):
        # Section 4.1.8
        return ":" + encode_base64(value) + ":"
    raise _fail("unsupported bare item")


# Section 4.1.4
def _serialize_integer(value: int) -> str:
    if value < -_MAX_INTEGER or value > _MAX_INTEGER:
        raise _fail("integer out of range")
    return str(value)


# Section 4.1.5
def _serialize_decimal(value: Decimal) -> str:
    if not value.is_finite():
        raise _fail("invalid decimal")
    # Step 2: round to three places, half to even.
    rounded = value.quantize(Decimal("0.001"), rounding=ROUND_HALF_EVEN)
    text = "{:f}".format(abs(rounded))
    integer, _, fraction = text.partition(".")
    if len(integer.lstrip("0")) > 12:
        raise _fail("decimal too large")
    fraction = fraction.rstrip("0") or "0"
    negative = rounded < 0
    return ("-" if negative else "") + (integer.lstrip("0") or "0") + "." + fraction


# Section 4.1.6
def _serialize_string(value: str) -> str:
    out = ['"']
    for c in value:
        if ord(c) < 0x20 or ord(c) > 0x7E:
            raise _fail("string has a character outside VCHAR and SP")
        if c in ("\\", '"'):
            out.append("\\")
        out.append(c)
    out.append('"')
    return "".join(out)


# Section 4.1.11
def _serialize_display_string(value: str) -> str:
    try:
        data = value.encode("utf-8")
    except UnicodeEncodeError as exc:
        # A lone surrogate cannot be encoded (step 2).
        raise _fail("display string is not well-formed Unicode") from exc
    out = ['%"']
    for byte in data:
        if byte in (0x25, 0x22) or byte < 0x20 or byte > 0x7E:
            out.append("%%%02x" % byte)
        else:
            out.append(chr(byte))
    out.append('"')
    return "".join(out)
