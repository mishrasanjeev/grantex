from __future__ import annotations

import hashlib
import hmac
import re
import time

_DEFAULT_TOLERANCE_SECONDS = 300
_TIMESTAMP_RE = re.compile(r"^\d{1,15}$")


def verify_webhook_signature(
    payload: str | bytes,
    signature: str,
    secret: str,
) -> bool:
    """Verify that a webhook payload was sent by Grantex.

    .. deprecated::
        This checks only that the body was signed with your secret. It commits
        to nothing time-bound, so a delivery captured once stays valid forever
        and can be replayed at will. Prefer :func:`verify_webhook`, which binds
        the signature to a timestamp and rejects stale deliveries.

    Args:
        payload:   The raw request body received from Grantex.
        signature: The value of the X-Grantex-Signature header.
        secret:    The webhook secret returned when the endpoint was created.

    Returns:
        True if the signature is valid, False otherwise.
    """
    if isinstance(payload, str):
        payload = payload.encode()
    expected = "sha256=" + hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature, expected)


def verify_webhook(
    payload: str | bytes,
    signature: str,
    timestamp: str,
    secret: str,
    tolerance_seconds: int = _DEFAULT_TOLERANCE_SECONDS,
) -> bool:
    """Verify a timestamped webhook delivery.

    Checks that the signature covers ``<timestamp>.<payload>`` and that the
    timestamp is recent. Both halves matter: without the signature the
    timestamp could be rewritten, and without the timestamp the signature never
    expires.

    Pass the untouched request body. A body that has been parsed and
    re-serialized will not hash to the same value.

    Args:
        payload:           The raw request body received from Grantex.
        signature:         The value of the X-Grantex-Signature-V2 header.
        timestamp:         The value of the X-Grantex-Timestamp header.
        secret:            The webhook secret returned when the endpoint was created.
        tolerance_seconds: How old a delivery may be. Deliveries dated this far
                           into the future are refused too, so a forged clock
                           cannot buy an unbounded window.

    Returns:
        True if the signature is valid and the delivery is fresh, else False.
    """
    if not isinstance(signature, str) or not signature:
        return False
    if not isinstance(timestamp, str) or not _TIMESTAMP_RE.match(timestamp):
        return False

    age_seconds = int(time.time()) - int(timestamp)
    if abs(age_seconds) > tolerance_seconds:
        return False

    if isinstance(payload, str):
        payload = payload.encode()

    signed = timestamp.encode() + b"." + payload
    expected = "sha256=" + hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature, expected)
