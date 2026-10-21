# SPDX-License-Identifier: Apache-2.0
"""Strict base64url and JSON helpers.

base64url is RFC 4648 section 5 without padding, as RFC 7515 section 2
requires; anything else is refused rather than guessed at.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
from typing import Any, Optional, Tuple

_ALPHABET = re.compile(r"[A-Za-z0-9_-]*")
MAX_SAFE_INTEGER = 2**53 - 1


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(text: str) -> Optional[bytes]:
    """Decode strict base64url, or return None. Non-canonical encodings are refused."""
    if not isinstance(text, str) or not _ALPHABET.fullmatch(text) or len(text) % 4 == 1:
        return None
    try:
        data = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except (binascii.Error, ValueError):
        # Unreachable after the alphabet and length checks; refuse the input anyway.
        return None
    return data if b64url_encode(data) == text else None


def _reject_constant(name: str) -> Any:
    # NaN and Infinity are not JSON (RFC 8259 section 6); JavaScript refuses them too.
    raise ValueError(f"{name} is not JSON")


def b64url_json(text: str) -> Optional[Tuple[Any]]:
    """Decode base64url UTF-8 JSON as a one-element tuple, or return None."""
    data = b64url_decode(text)
    if data is None:
        return None
    try:
        return (json.loads(data.decode("utf-8"), parse_constant=_reject_constant),)
    except (UnicodeDecodeError, ValueError, RecursionError):
        # Not UTF-8 or not JSON: the caller refuses the input with its own reason.
        return None


def json_compact(value: Any) -> str:
    """JSON without whitespace and with non-ASCII characters unescaped, as JSON.stringify writes it."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def is_object(value: Any) -> bool:
    return isinstance(value, dict)


def is_safe_int(value: Any) -> bool:
    """An integer JSON number read the same way in both libraries (JavaScript safe integers).

    1.0 parses as a float here and as 1 in JavaScript, so integral floats count.
    """
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return -MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER
    if isinstance(value, float):
        return value.is_integer() and -MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER
    return False
