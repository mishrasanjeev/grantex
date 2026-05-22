"""JWT payload decoding — offline, no signature verification."""

from __future__ import annotations

import base64
import json
from typing import Any, Dict


def _b64url_decode(data: str) -> bytes:
    padding = 4 - len(data) % 4
    if padding != 4:
        data += "=" * padding
    return base64.urlsafe_b64decode(data)


def decode_jwt_payload(token: str) -> Dict[str, Any]:
    """Decode the payload of a JWT without verifying the signature.

    This is intentionally an offline operation — the token must already
    have been verified (e.g. by Grantex) before being passed here.
    """
    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("Invalid JWT: expected 3 parts separated by '.'")
    payload_bytes = _b64url_decode(parts[1])
    return json.loads(payload_bytes.decode("utf-8"))  # type: ignore[no-any-return]
