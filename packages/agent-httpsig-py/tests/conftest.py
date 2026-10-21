# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.asymmetric import ed25519

from grantex_agent_httpsig import private_jwk_from_key

REPO_ROOT = Path(__file__).resolve().parents[3]
VECTORS: dict[str, Any] = json.loads(
    (REPO_ROOT / "spec" / "examples" / "agent-httpsig-vectors.json").read_text(
        encoding="utf-8"
    )
)


def vector_private_key(name: str) -> dict[str, str]:
    """The Ed25519 test key of the vectors: seed = SHA-256(UTF-8(seed_label))."""
    label = VECTORS["keys"][name]["seed_label"]
    seed = hashlib.sha256(label.encode("utf-8")).digest()
    return private_jwk_from_key(ed25519.Ed25519PrivateKey.from_private_bytes(seed))
