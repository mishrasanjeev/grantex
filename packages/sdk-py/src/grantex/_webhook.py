from __future__ import annotations

import hashlib
import hmac


def verify_webhook_signature(
    payload: str | bytes,
    signature: str,
    secret: str,
) -> bool:
    """Verify that a webhook payload was sent by Grantex.

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
