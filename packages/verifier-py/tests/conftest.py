# SPDX-License-Identifier: Apache-2.0
"""A local fake registry and an agent, built at run time for the verifier tests.

Every key is generated when the tests run and never written to disk. The
registry (registry.example) signs its manifest, its acceptance status list and
the grant tokens with an RSA key (RS256, the auth service's default); the mock
accredited issuer (mock-issuer.example) signs the Agent Passport and its own
status list with a P-256 key. Documents are served by an injected fetcher, so
nothing touches the network.
"""

from __future__ import annotations

import base64
import copy
import json
import sys
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

from grantex_agent_httpsig import HttpRequest, InMemoryNonceStore, sign
from grantex_agent_passport import external_credential_hash, issue_passport, jwk_thumbprint

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parent / "docs" / "examples"))

NOW = 1_790_000_000
REGISTRY = "https://registry.example"
ISSUER = "https://mock-issuer.example"
ORIGIN = "https://merchant.example"
AGENT_DID = "did:grantex:ag_01J8Z3K4M5N6P7Q8R9S0T1V2W3"
ATTESTATION_ID = "att_01J00000000000000000000000"
ISSUER_LIST_URI = "https://mock-issuer.example/status/1"
ISSUER_IDX = 42
ACCEPTANCE_URI = "https://registry.example/status/attestations/racl_01J8Z3K4M5N6P7Q8R9S0T1V2W3"
ACCEPTANCE_IDX = 4127
MANIFEST_URL = "https://registry.example/.well-known/agent-registry.json"
JWKS_URL = "https://registry.example/.well-known/jwks.json"
COMMERCE = "urn:grantex:commerce:v1"
BUDGET = "urn:grantex:params:oauth:authorization-details:budget"

VALID, INVALID, SUSPENDED = 0x00, 0x01, 0x02


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _json(value: Any) -> bytes:
    return json.dumps(value, separators=(",", ":")).encode("utf-8")


@dataclass
class P256:
    private_jwk: Dict[str, Any]
    public_jwk: Dict[str, Any]
    key: ec.EllipticCurvePrivateKey


def p256(kid: Optional[str] = None) -> P256:
    key = ec.generate_private_key(ec.SECP256R1())
    n = key.private_numbers()
    public: Dict[str, Any] = {
        "kty": "EC",
        "crv": "P-256",
        "x": b64(n.public_numbers.x.to_bytes(32, "big")),
        "y": b64(n.public_numbers.y.to_bytes(32, "big")),
    }
    if kid is not None:
        public["kid"] = kid
    private = dict(public, d=b64(n.private_value.to_bytes(32, "big")))
    return P256(private, public, key)


@dataclass
class Rsa:
    key: rsa.RSAPrivateKey
    public_jwk: Dict[str, Any]


def rsa_key(kid: str) -> Rsa:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pn = key.public_key().public_numbers()
    public = {
        "kty": "RSA",
        "kid": kid,
        "alg": "RS256",
        "use": "sig",
        "n": b64(pn.n.to_bytes((pn.n.bit_length() + 7) // 8, "big")),
        "e": b64(pn.e.to_bytes((pn.e.bit_length() + 7) // 8, "big")),
    }
    return Rsa(key, public)


def sign_jwt(header: Mapping[str, Any], payload: Mapping[str, Any], key: Any) -> str:
    """Compact JWS with RS256 (an RSA key) or ES256 (a P-256 key)."""
    signing_input = b64(_json(dict(header))) + "." + b64(_json(dict(payload)))
    data = signing_input.encode("ascii")
    if isinstance(key, rsa.RSAPrivateKey):
        signature = key.sign(data, padding.PKCS1v15(), hashes.SHA256())
    else:
        r, s = decode_dss_signature(key.sign(data, ec.ECDSA(hashes.SHA256())))
        signature = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    return signing_input + "." + b64(signature)


def encode_status_list(entries: Mapping[int, int], size: int = 8192, bits: int = 2) -> str:
    """draft-ietf-oauth-status-list-21 section 4.1: LSB-first packing, ZLIB."""
    per_byte = 8 // bits
    data = bytearray((size + per_byte - 1) // per_byte)
    for idx, status in entries.items():
        data[idx // per_byte] |= status << ((idx % per_byte) * bits)
    return b64(zlib.compress(bytes(data), 9))


class FakeFetcher:
    """Serves documents by URL. A missing URL, or one marked down, raises."""

    def __init__(self) -> None:
        self.documents: Dict[str, str] = {}
        self.down: set = set()
        self.calls: List[str] = []

    def __call__(self, url: str) -> str:
        self.calls.append(url)
        if url in self.down or url not in self.documents:
            raise ConnectionError("unreachable: " + url)
        return self.documents[url]


@dataclass
class GrantStatusFake:
    state: str = "active"
    raises: bool = False
    calls: int = 0

    def grant_status(
        self, *, grant_id: str, token_id: str, parent_grant_id: Optional[str]
    ) -> Any:
        from grantex_verifier import GrantStatus

        self.calls += 1
        if self.raises:
            raise ConnectionError("revocation status endpoint unreachable")
        return GrantStatus(state=self.state, checked_at=float(NOW))


@dataclass
class World:
    """The registry, the issuer, the agent and what they publish, at NOW."""

    now: float = float(NOW)
    registry: Rsa = field(default_factory=lambda: rsa_key("registry-rs256-1"))
    issuer: P256 = field(default_factory=lambda: p256("mock-issuer-2026"))
    agent: P256 = field(default_factory=p256)
    fetcher: FakeFetcher = field(default_factory=FakeFetcher)
    grant_status: GrantStatusFake = field(default_factory=GrantStatusFake)
    issuer_status: int = VALID
    acceptance: int = VALID
    issuer_state: str = "active"
    issuer_trust_marks: List[str] = field(
        default_factory=lambda: ["urn:grantex:tm:agent.identity", "urn:grantex:tm:provider.entity"]
    )
    issuer_manifest_keys: Optional[List[Dict[str, Any]]] = None
    lookup_answers: Dict[str, Any] = field(default_factory=dict)
    lookup_calls: int = 0
    lookup_raises: bool = False
    list_ttl: int = 600

    def __post_init__(self) -> None:
        self.passport = issue_passport(
            issuer_key=self.issuer.private_jwk,
            iss=ISSUER,
            sub=AGENT_DID,
            cnf_jwk=self.agent.public_jwk,
            iat=int(self.now) - 3600,
            exp=int(self.now) + 30 * 86_400,
            status={"status_list": {"uri": ISSUER_LIST_URI, "idx": ISSUER_IDX}},
            claims={
                "provider": {"did": "did:web:provider.example", "name": "Provider Example Ltd"},
                "agent": {"software_name": "Nimbus Shopper", "software_version": "2.4"},
                "verification": {"level": "substantial"},
                "attestation_id": ATTESTATION_ID,
            },
        ).compact
        self.lookup_answers[self.agent_thumbprint] = self.lookup_answer()
        self.publish()

    # ── what the parties publish ────────────────────────────────────────────

    @property
    def agent_thumbprint(self) -> str:
        return jwk_thumbprint(self.agent.public_jwk)

    def lookup_answer(self, **overrides: Any) -> Dict[str, Any]:
        answer: Dict[str, Any] = {
            "agent_did": AGENT_DID,
            "level": "attested",
            "flags": [],
            "issuers": [ISSUER],
            "attestations": [],
            "keys": [{"thumbprint": self.agent_thumbprint, "status": "active", "current": True}],
            "key_thumbprint": self.agent_thumbprint,
            "key_status": "active",
            "key_current": True,
        }
        answer.update(overrides)
        return answer

    def manifest_claims(self, **overrides: Any) -> Dict[str, Any]:
        keys = self.issuer_manifest_keys
        if keys is None:
            keys = [self.issuer.public_jwk]
        claims: Dict[str, Any] = {
            "iss": REGISTRY,
            "iat": int(self.now) - 120,
            "exp": int(self.now) - 120 + 3600,
            "issuers": [
                {
                    "entity_id": ISSUER,
                    "trust_marks": list(self.issuer_trust_marks),
                    "status": self.issuer_state,
                    "status_list_base": "https://mock-issuer.example/status/",
                    "jwks": {"keys": keys},
                }
            ],
            "trust_mark_types": ["urn:grantex:tm:agent.identity"],
            "acceptance_status_lists": [
                {
                    "token_status_list": ACCEPTANCE_URI,
                    "bitstring_status_list": {
                        "revocation": ACCEPTANCE_URI + "/bitstring",
                        "suspension": ACCEPTANCE_URI + "/bitstring/suspension",
                    },
                }
            ],
            "endpoints": {
                "agent_by_did": REGISTRY + "/v1/registry/agents/{agent_did}",
                "agent_by_key_thumbprint": REGISTRY + "/v1/registry/agents?key_thumbprint={key_thumbprint}",
                "agent_by_credential": REGISTRY + "/v1/registry/agents?issuer={issuer}",
                "issuers": REGISTRY + "/v1/registry/issuers",
                "acceptance_status_list": REGISTRY + "/status/attestations/{list}",
                "jwks_uri": JWKS_URL,
            },
        }
        claims.update(overrides)
        return claims

    def manifest(self, header: Optional[Dict[str, Any]] = None, **overrides: Any) -> str:
        h = {"alg": "RS256", "kid": "registry-rs256-1", "typ": "grantex-registry-manifest+jwt"}
        if header is not None:
            h = header
        return sign_jwt(h, self.manifest_claims(**overrides), self.registry.key)

    def issuer_list(self, **overrides: Any) -> str:
        claims: Dict[str, Any] = {
            "sub": ISSUER_LIST_URI,
            "iat": int(self.now) - 30,
            "exp": int(self.now) + 3600,
            "ttl": self.list_ttl,
            "status_list": {"bits": 2, "lst": encode_status_list({ISSUER_IDX: self.issuer_status})},
        }
        claims.update(overrides)
        header = {"alg": "ES256", "kid": "mock-issuer-2026", "typ": "statuslist+jwt"}
        return sign_jwt(header, claims, self.issuer.key)

    def acceptance_list(self, **overrides: Any) -> str:
        claims: Dict[str, Any] = {
            "iss": REGISTRY,
            "sub": ACCEPTANCE_URI,
            "iat": int(self.now) - 30,
            "exp": int(self.now) + 3600,
            "ttl": self.list_ttl,
            "status_list": {"bits": 2, "lst": encode_status_list({ACCEPTANCE_IDX: self.acceptance})},
        }
        claims.update(overrides)
        header = {"alg": "RS256", "kid": "registry-rs256-1", "typ": "statuslist+jwt"}
        return sign_jwt(header, claims, self.registry.key)

    def publish(self) -> None:
        self.fetcher.documents[MANIFEST_URL] = self.manifest()
        self.fetcher.documents[JWKS_URL] = json.dumps({"keys": [self.registry.public_jwk]})
        self.fetcher.documents[ISSUER_LIST_URI] = self.issuer_list()
        self.fetcher.documents[ACCEPTANCE_URI] = self.acceptance_list()

    # ── the grant ───────────────────────────────────────────────────────────

    def commerce_entry(self, **overrides: Any) -> Dict[str, Any]:
        entry: Dict[str, Any] = {
            "type": COMMERCE,
            "passport": {
                "issuer": ISSUER,
                "id": ATTESTATION_ID,
                "hash": external_credential_hash(self.passport),
                "key_thumbprint": self.agent_thumbprint,
            },
            "acceptance_status": {"uri": ACCEPTANCE_URI, "idx": ACCEPTANCE_IDX},
            "constraints": {
                "amount_range": {"min_minor": 100, "max_minor": 50_000},
                "currency": "EUR",
                "allowed_merchants": [ORIGIN],
                "window": {"not_before": int(self.now) - 3600, "not_after": int(self.now) + 86_400},
                "human_present": True,
            },
        }
        entry.update(overrides)
        return entry

    def grant_claims(self, **overrides: Any) -> Dict[str, Any]:
        claims: Dict[str, Any] = {
            "iss": REGISTRY,
            "sub": "user_shopper",
            "aud": ORIGIN,
            "exp": int(self.now) + 3600,
            "iat": int(self.now) - 60,
            "jti": "tok_01J8Z3K4M5N6P7Q8R9S0T1V2W4",
            "client_id": "ag_01J8Z3K4M5N6P7Q8R9S0T1V2W3",
            "scope": "checkout:create",
            "cnf": {"jkt": self.agent_thumbprint},
            "authorization_details": [
                {"type": BUDGET, "amount": 400.0, "currency": "EUR"},
                self.commerce_entry(),
            ],
            "urn:grantex:grant": {
                "grant_id": "grnt_01J8Z3K4M5N6P7Q8R9S0T1V2W5",
                "agent_did": AGENT_DID,
                "developer_id": "dev_01J8Z3K4M5N6P7Q8R9S0T1V2W6",
                "parent_grant_id": "grnt_01J8Z3K4M5N6P7Q8R9S0T1V2W7",
                "delegation_depth": 1,
            },
        }
        claims.update(overrides)
        return claims

    def grant(self, header: Optional[Dict[str, Any]] = None, **overrides: Any) -> str:
        h = {"alg": "RS256", "kid": "registry-rs256-1", "typ": "at+jwt"}
        if header is not None:
            h = header
        return sign_jwt(h, self.grant_claims(**overrides), self.registry.key)

    # ── the relying party's view ────────────────────────────────────────────

    def lookup(self, thumbprint: str) -> Optional[Mapping[str, Any]]:
        self.lookup_calls += 1
        if self.lookup_raises:
            raise ConnectionError("registry lookup unreachable")
        answer = self.lookup_answers.get(thumbprint)
        return copy.deepcopy(answer) if answer is not None else None

    def config(self, **overrides: Any) -> Any:
        from grantex_verifier import VerifierConfig

        params: Dict[str, Any] = {
            "origin": ORIGIN,
            "registry_issuer": REGISTRY,
            "registry_jwks": JWKS_URL,
            "manifest_url": MANIFEST_URL,
            "fetch": self.fetcher,
            "registry_lookup": self.lookup,
            "grant_status": self.grant_status,
            "nonce_store": InMemoryNonceStore(clock=lambda: int(self.now)),
            "hitl_threshold_minor": 20_000,
            "clock": lambda: self.now,
        }
        params.update(overrides)
        return VerifierConfig(**params)

    def signed_request(
        self,
        passport: Optional[str] = None,
        grant: Optional[str] = None,
        *,
        key: Optional[Dict[str, Any]] = None,
        url: str = "https://merchant.example/v1/checkout",
        body: bytes = b'{"cart_id":"c-1001","amount_minor":12500,"currency":"EUR"}',
        created: Optional[int] = None,
        nonce: Optional[str] = None,
    ) -> Tuple[HttpRequest, str, str]:
        """A request signed by the agent; returns it with origin-form target."""
        passport = self.passport if passport is None else passport
        grant = self.grant() if grant is None else grant
        headers = {"content-type": "application/json"}
        unsigned = HttpRequest("POST", url, headers, body)
        signed = sign(
            unsigned,
            key=key if key is not None else self.agent.private_jwk,
            agent_passport=passport,
            agent_grant=grant,
            created=int(self.now) if created is None else created,
            nonce=nonce,
        )
        path = "/" + url.split("/", 3)[3] if url.count("/") >= 3 else "/"
        request = HttpRequest("POST", path, {**headers, **signed.headers}, body)
        return request, passport, grant


@pytest.fixture
def world() -> World:
    return World()


def tx(**overrides: Any) -> Any:
    from grantex_verifier import Transaction

    params: Dict[str, Any] = {"amount_minor": 12_500, "currency": "EUR", "merchant": ORIGIN}
    params.update(overrides)
    return Transaction(**params)


Checker = Callable[..., Any]
