# SPDX-License-Identifier: Apache-2.0
"""Shared helpers for the grantex-agent-passport tests.

Test keys are generated at run time and never written to disk.
"""

from __future__ import annotations

import base64
import copy
import random
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)

ISSUER = "https://mock-issuer.example"
AGENT_DID = "did:web:provider.example:agents:shopper-01"
IAT = 1_790_000_000
NOW = IAT + 60

PROFILE_CLAIMS: Dict[str, Any] = {
    "provider": {
        "did": "did:web:provider.example",
        "legal_identifiers": [
            {"scheme": "registration_number", "value": "EX-0000001"}
        ],
        "name": "Provider Example Ltd",
    },
    "agent": {
        "software_name": "Nimbus Shopper",
        "software_version": "2.4",
        "cimd_uri": "https://provider.example/agents/shopper-01/client-metadata.json",
        "categories": ["shopping"],
        "declared_limits": {
            "max_transaction": {"amount": "500.00", "currency": "USD"}
        },
    },
    "verification": {
        "level": "standard",
        "types": ["business_registry", "domain_control"],
        "performed_at": IAT - 86_400,
    },
    "attestation_id": "att_01J00000000000000000000000",
}


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


@dataclass
class KeyPair:
    private_jwk: Dict[str, Any]
    public_jwk: Dict[str, Any]


def p256_key_pair(kid: Optional[str] = None) -> KeyPair:
    key = ec.generate_private_key(ec.SECP256R1())
    numbers = key.private_numbers()
    public = {
        "kty": "EC",
        "crv": "P-256",
        "x": _b64(numbers.public_numbers.x.to_bytes(32, "big")),
        "y": _b64(numbers.public_numbers.y.to_bytes(32, "big")),
    }
    private = dict(public, d=_b64(numbers.private_value.to_bytes(32, "big")))
    if kid is not None:
        public["kid"] = kid
        private["kid"] = kid
    return KeyPair(private, public)


def ed25519_key_pair(kid: Optional[str] = None) -> KeyPair:
    key = Ed25519PrivateKey.generate()
    x = key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    d = key.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
    public = {"kty": "OKP", "crv": "Ed25519", "x": _b64(x)}
    private = dict(public, d=_b64(d))
    if kid is not None:
        public["kid"] = kid
        private["kid"] = kid
    return KeyPair(private, public)


def passport_params(
    issuer: KeyPair, holder: KeyPair, **overrides: Any
) -> Dict[str, Any]:
    params: Dict[str, Any] = {
        "issuer_key": issuer.private_jwk,
        "iss": ISSUER,
        "sub": AGENT_DID,
        "cnf_jwk": holder.public_jwk,
        "iat": IAT,
        "exp": IAT + 30 * 86_400,
        "status": {
            "status_list": {"uri": "https://mock-issuer.example/status/1", "idx": 42}
        },
        "claims": copy.deepcopy(PROFILE_CLAIMS),
    }
    params.update(overrides)
    return params


def resolver_for(*keys: Dict[str, Any]) -> Callable[[str], List[Dict[str, Any]]]:
    return lambda iss: list(keys) if iss == ISSUER else []


def seeded(seed: int) -> random.Random:
    """A seeded generator so property tests replay the same cases."""
    return random.Random(seed)
