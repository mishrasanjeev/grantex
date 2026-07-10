"""Lightweight offline JWT decode for A2A grant token inspection."""

from __future__ import annotations

import base64
import json
import time
from typing import Any, Dict, cast


def decode_jwt_payload(token: str) -> Dict[str, Any]:
    """Decode a JWT payload without verification.

    Args:
        token: The JWT string (header.payload.signature)

    Returns:
        The decoded JWT payload as a dictionary.

    Raises:
        ValueError: If the token is not a valid JWT format.
    """
    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("Invalid JWT format: expected 3 parts")

    payload = parts[1]
    # Add padding if needed
    padding = 4 - len(payload) % 4
    if padding != 4:
        payload += "=" * padding

    decoded = base64.urlsafe_b64decode(payload)
    decoded_payload: object = json.loads(decoded)
    if not isinstance(decoded_payload, dict):
        raise ValueError("Invalid JWT payload: expected a JSON object")
    return cast(Dict[str, Any], decoded_payload)


def is_token_expired(payload: Dict[str, Any]) -> bool:
    """Check if a decoded JWT is expired.

    Args:
        payload: The decoded JWT payload.

    Returns:
        True if the token is expired, False otherwise.
    """
    exp = payload.get("exp")
    if exp is None:
        return False
    if isinstance(exp, bool) or not isinstance(exp, (int, float)):
        raise ValueError("Invalid JWT exp claim: expected a number")
    return time.time() >= float(exp)
