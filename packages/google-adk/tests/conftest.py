from __future__ import annotations

import base64
import json
from typing import Any


# ─── JWT helpers ──────────────────────────────────────────────────────────────
def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def make_grant_token(scopes: list[str], extra: dict[str, Any] | None = None) -> str:
    """Build a fake (unsigned) JWT with the given scp claim."""
    header = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    payload_data: dict[str, Any] = {
        "iss": "https://api.grantex.dev",
        "sub": "user_01",
        "agt": "did:grantex:ag_01",
        "dev": "dev_01",
        "scp": scopes,
        "iat": 1700000000,
        "exp": 9999999999,
        "jti": "tok_01",
        "grnt": "grnt_01",
    }
    if extra:
        payload_data.update(extra)
    payload = _b64url(json.dumps(payload_data).encode())
    return f"{header}.{payload}.fakesignature"
