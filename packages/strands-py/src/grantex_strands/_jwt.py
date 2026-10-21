"""Read the claims of a compact JWT without checking its signature.

Use this only for tokens that were verified elsewhere, or where the claims
are informational (for example, listing scopes for display).
"""

from __future__ import annotations

import base64
import json
from typing import Any


def _decode_segment(segment: str) -> bytes:
    # JWS base64url segments drop the "=" padding (RFC 7515, section 2);
    # put it back so the standard decoder accepts the segment.
    return base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))


def decode_jwt_payload(token: str) -> dict[str, Any]:
    """Return the decoded claims segment of ``token``.

    Raises ``ValueError`` when the token is not three dot-separated segments
    or the claims segment is not valid base64url JSON.
    """
    segments = token.split(".")
    if len(segments) != 3:
        raise ValueError("Invalid JWT: expected 3 parts separated by '.'")
    claims: dict[str, Any] = json.loads(_decode_segment(segments[1]).decode("utf-8"))
    return claims
