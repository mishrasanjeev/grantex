from __future__ import annotations

import hashlib
import base64
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class PkceChallenge:
    code_verifier: str
    code_challenge: str
    code_challenge_method: str


def generate_pkce() -> PkceChallenge:
    """Generate a PKCE code verifier and S256 challenge pair.

    Use ``code_challenge`` + ``code_challenge_method`` in the authorize request,
    and ``code_verifier`` in the token exchange request.
    """
    verifier_bytes = os.urandom(32)
    code_verifier = base64.urlsafe_b64encode(verifier_bytes).rstrip(b"=").decode("ascii")
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    code_challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return PkceChallenge(
        code_verifier=code_verifier,
        code_challenge=code_challenge,
        code_challenge_method="S256",
    )
