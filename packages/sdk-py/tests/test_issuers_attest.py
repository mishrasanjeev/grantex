"""The attestation step: key proof on the agent's side, attest_agent() on the
registry's side, and the grantex-attest command over both."""

from __future__ import annotations

import io
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
import jwt
import pytest
import respx

from grantex import Grantex
from grantex.cli.attest import run
from grantex.issuers import (
    AccreditedIssuerClient,
    AgentRecord,
    CredentialRef,
    IssuedAttestation,
    IssuerAdapterError,
    IssuerMetadata,
    IssuerStatus,
    ProvedKey,
)
from grantex.issuers._attest import ATTESTATION_MEDIA_TYPE, attest_agent, post_attestation
from grantex.issuers._proof import KEY_PROOF_TYP, generate_agent_key, jwk_thumbprint, public_jwk, sign_key_proof
from grantex.resources._agent_keys import KeyChallenge

BASE = "https://api.grantex.dev"
AGENT_ID = "ag_01HXYZ123abc"
DID = "did:grantex:ag_01HXYZ123abc"
AGENT = {
    "id": AGENT_ID, "did": DID, "name": "Nimbus Shopper", "description": "", "scopes": [], "status": "active",
    "developerId": "dev_01", "createdAt": "2026-09-30T00:00:00Z", "updatedAt": "2026-09-30T00:00:00Z",
}


# ─── thumbprints and proofs ─────────────────────────────────────────────────


def test_thumbprint_matches_the_rfc_7638_vector() -> None:
    rsa = {
        "kty": "RSA", "kid": "2011-04-29", "use": "sig", "e": "AQAB",
        "n": "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
    }
    assert jwk_thumbprint(rsa) == "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs"


def test_thumbprint_matches_the_rfc_8037_vector() -> None:
    okp = {"kty": "OKP", "crv": "Ed25519", "x": "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"}
    assert jwk_thumbprint(okp) == "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k"


def test_thumbprint_refuses_private_members_and_unknown_types() -> None:
    with pytest.raises(IssuerAdapterError, match="private JWK"):
        jwk_thumbprint({"kty": "EC", "crv": "P-256", "x": "x", "y": "y", "d": "secret"})
    with pytest.raises(IssuerAdapterError, match="key type"):
        jwk_thumbprint({"kty": "oct", "k": "secret"})
    with pytest.raises(IssuerAdapterError, match="missing"):
        jwk_thumbprint({"kty": "EC", "crv": "P-256", "x": "x"})


@pytest.mark.parametrize("alg", ["ES256", "EdDSA"])
def test_generate_agent_key_and_sign_a_proof_the_registry_can_verify(alg: str) -> None:
    private, pub, thumbprint = generate_agent_key(alg)
    assert "d" in private and "d" not in pub and jwk_thumbprint(pub) == thumbprint
    assert public_jwk(private) == pub
    challenge = KeyChallenge(thumbprint, "n" * 43, "https://grantex.dev", AGENT_ID, KEY_PROOF_TYP, alg, None)
    proof = sign_key_proof(challenge, private, now=1_790_596_800)
    header = jwt.get_unverified_header(proof)
    assert header == {"alg": alg, "typ": KEY_PROOF_TYP, "kid": thumbprint}
    claims = jwt.decode(proof, jwt.PyJWK(pub).key, algorithms=[alg], audience="https://grantex.dev")
    assert claims == {"aud": "https://grantex.dev", "sub": AGENT_ID, "nonce": "n" * 43, "iat": 1_790_596_800}


def test_sign_key_proof_takes_the_challenge_as_returned_by_the_api() -> None:
    private, _pub, thumbprint = generate_agent_key()
    raw = {"thumbprint": thumbprint, "challenge": "c", "audience": "a", "subject": AGENT_ID, "typ": KEY_PROOF_TYP, "alg": "ES256", "expiresAt": None}
    assert sign_key_proof(raw, private).count(".") == 2


def test_sign_key_proof_refuses_a_foreign_typ_or_a_mac_algorithm() -> None:
    private, _pub, thumbprint = generate_agent_key()
    with pytest.raises(IssuerAdapterError, match="typ"):
        sign_key_proof(KeyChallenge(thumbprint, "c", "a", AGENT_ID, "JWT", "ES256", None), private)
    with pytest.raises(IssuerAdapterError, match="proof algorithm"):
        sign_key_proof(KeyChallenge(thumbprint, "c", "a", AGENT_ID, KEY_PROOF_TYP, "HS256", None), private)
    with pytest.raises(IssuerAdapterError, match="private JWK"):
        sign_key_proof(KeyChallenge(thumbprint, "c", "a", AGENT_ID, KEY_PROOF_TYP, "ES256", None), public_jwk(private))


# ─── attest_agent ───────────────────────────────────────────────────────────


class StubIssuer:
    """Records what it was asked and answers like the mock issuer."""

    def __init__(self, thumbprint_override: Optional[str] = None) -> None:
        self.requests: List[tuple[AgentRecord, ProvedKey]] = []
        self._override = thumbprint_override

    def issuer_metadata(self) -> IssuerMetadata:
        return IssuerMetadata(issuer_id="https://mock-issuer.example", scopes=("urn:grantex:tm:agent.identity",), jwks={"keys": []})

    def request_attestation(self, agent_record: AgentRecord, proved_key: ProvedKey) -> IssuedAttestation:
        self.requests.append((agent_record, proved_key))
        ref = CredentialRef("https://mock-issuer.example", "ppt-001", "sha-256:OiVR9AjgZRd6DJ8n_6dpLox_0KzFKt7gZ9MHpgHXOKQ", issuer_attestation_id="att-001")
        thumbprint = self._override or proved_key.thumbprint
        provider = IssuedAttestation(
            jws="eyJ0eXAiOiJncmFudGV4LWF0dGVzdGF0aW9uK2p3dCJ9.eyJ0eXBlIjoicHJvdmlkZXIifQ.c2ln",
            attestation_type="urn:grantex:tm:provider.entity", credential_ref=ref, key_thumbprint=thumbprint,
        )
        return IssuedAttestation(
            jws="eyJ0eXAiOiJncmFudGV4LWF0dGVzdGF0aW9uK2p3dCJ9.e30.c2ln",
            attestation_type="urn:grantex:tm:agent.identity",
            credential_ref=ref,
            key_thumbprint=thumbprint,
            expires_at=datetime(2026, 10, 28, 12, 0, tzinfo=timezone.utc),
            passport="eyJ.passport.sig~",
            companions=(provider,),
        )

    def fetch_status(self, credential_ref: CredentialRef) -> IssuerStatus:
        return IssuerStatus("valid", datetime.now(tz=timezone.utc), "stub")


def _key_row(thumbprint: str, pub: Dict[str, Any], status: str = "active") -> Dict[str, Any]:
    proved = status in ("active", "rotated")
    return {
        "thumbprint": thumbprint, "agentId": AGENT_ID, "jwk": pub, "alg": "ES256", "status": status,
        "validFrom": "2026-09-30T00:00:00.000Z", "validTo": None,
        "possessionProvedAt": "2026-09-30T00:01:00.000Z" if proved else None,
        "rotatedFrom": None, "createdAt": "2026-09-30T00:00:00.000Z", "usable": proved,
        **({} if proved else {"denial": "key_unproven"}),
    }


REGISTRY_RECORD = {
    "id": "ratt_01", "iss": "https://mock-issuer.example", "attestation_id": "att-001", "sub": DID,
    "type": "urn:grantex:tm:agent.identity", "state": "accepted", "issuer_status": "valid",
}


@pytest.fixture
def client() -> Grantex:
    return Grantex(api_key="test-key", revocation_check="offline")


@respx.mock
def test_attest_agent_round_trip(client: Grantex) -> None:
    _private, pub, thumbprint = generate_agent_key()
    assert isinstance(StubIssuer(), AccreditedIssuerClient)
    respx.get(f"{BASE}/v1/agents/{AGENT_ID}").mock(return_value=httpx.Response(200, json=AGENT))
    respx.get(f"{BASE}/v1/agents/{AGENT_ID}/keys").mock(return_value=httpx.Response(200, json={"keys": [_key_row(thumbprint, pub)]}))
    ingest = respx.post(f"{BASE}/v1/registry/attestations").mock(return_value=httpx.Response(201, json=REGISTRY_RECORD))
    respx.get(f"{BASE}/v1/registry/agents/{DID}").mock(
        return_value=httpx.Response(200, json={"agent_did": DID, "level": "attested", "flags": ["key_rotation_pending"]})
    )
    issuer = StubIssuer()

    outcome = attest_agent(client, AGENT_ID, thumbprint, issuer=issuer, provider_did="did:web:provider.example")

    record, proved = issuer.requests[0]
    assert record == AgentRecord(
        agent_id=AGENT_ID, did=DID, developer_id="dev_01", provider_did="did:web:provider.example", software_name="Nimbus Shopper"
    )
    assert proved.thumbprint == thumbprint and proved.public_jwk == pub
    assert proved.possession_proved_at == datetime(2026, 9, 30, 0, 1, tzinfo=timezone.utc)
    sent = ingest.calls[0].request
    assert sent.headers["content-type"] == ATTESTATION_MEDIA_TYPE
    assert "authorization" not in sent.headers
    assert sent.content.decode() == outcome.issued.jws
    assert outcome.created is True and outcome.registry["id"] == "ratt_01"
    # The companion (provider.entity) is posted after the main attestation.
    assert ingest.call_count == 2 and ingest.calls[1].request.content.decode() == outcome.issued.companions[0].jws
    assert len(outcome.companion_records) == 1 and outcome.companion_records[0]["id"] == "ratt_01"
    assert outcome.level == "attested" and outcome.flags == ("key_rotation_pending",)
    assert outcome.key.status == "active" and outcome.agent.did == DID


@respx.mock
def test_attest_agent_refuses_an_unproven_key_before_asking_the_issuer(client: Grantex) -> None:
    _private, pub, thumbprint = generate_agent_key()
    respx.get(f"{BASE}/v1/agents/{AGENT_ID}").mock(return_value=httpx.Response(200, json=AGENT))
    respx.get(f"{BASE}/v1/agents/{AGENT_ID}/keys").mock(return_value=httpx.Response(200, json={"keys": [_key_row(thumbprint, pub, "pending")]}))
    ingest = respx.post(f"{BASE}/v1/registry/attestations")
    issuer = StubIssuer()
    with pytest.raises(IssuerAdapterError) as info:
        attest_agent(client, AGENT_ID, thumbprint, issuer=issuer)
    assert info.value.code == "key_unproven" and issuer.requests == [] and not ingest.called
    with pytest.raises(IssuerAdapterError) as unknown:
        attest_agent(client, AGENT_ID, "k" * 43, issuer=issuer)
    assert unknown.value.code == "key_unproven"


@respx.mock
def test_attest_agent_accepts_a_rotated_key_within_its_overlap_and_refuses_one_past_it(client: Grantex) -> None:
    _private, pub, thumbprint = generate_agent_key()
    respx.get(f"{BASE}/v1/agents/{AGENT_ID}").mock(return_value=httpx.Response(200, json=AGENT))
    respx.post(f"{BASE}/v1/registry/attestations").mock(return_value=httpx.Response(201, json=REGISTRY_RECORD))
    respx.get(f"{BASE}/v1/registry/agents/{DID}").mock(return_value=httpx.Response(200, json={"agent_did": DID, "level": "attested", "flags": []}))
    overlap = {**_key_row(thumbprint, pub, "rotated"), "validTo": "2026-10-07T00:00:00.000Z", "usable": True}
    respx.get(f"{BASE}/v1/agents/{AGENT_ID}/keys").mock(return_value=httpx.Response(200, json={"keys": [overlap]}))
    assert attest_agent(client, AGENT_ID, thumbprint, issuer=StubIssuer()).key.status == "rotated"
    ended = {**overlap, "usable": False, "denial": "key_not_active"}
    respx.get(f"{BASE}/v1/agents/{AGENT_ID}/keys").mock(return_value=httpx.Response(200, json={"keys": [ended]}))
    with pytest.raises(IssuerAdapterError) as info:
        attest_agent(client, AGENT_ID, thumbprint, issuer=StubIssuer())
    assert info.value.code == "key_not_active"


@respx.mock
def test_attest_agent_refuses_an_attestation_for_another_key(client: Grantex) -> None:
    _private, pub, thumbprint = generate_agent_key()
    respx.get(f"{BASE}/v1/agents/{AGENT_ID}").mock(return_value=httpx.Response(200, json=AGENT))
    respx.get(f"{BASE}/v1/agents/{AGENT_ID}/keys").mock(return_value=httpx.Response(200, json={"keys": [_key_row(thumbprint, pub)]}))
    ingest = respx.post(f"{BASE}/v1/registry/attestations")
    with pytest.raises(IssuerAdapterError) as info:
        attest_agent(client, AGENT_ID, thumbprint, issuer=StubIssuer(thumbprint_override="other"))
    assert info.value.code == "key_binding_mismatch" and not ingest.called


@respx.mock
def test_attest_agent_keeps_the_registrys_refusal_code(client: Grantex) -> None:
    _private, pub, thumbprint = generate_agent_key()
    respx.get(f"{BASE}/v1/agents/{AGENT_ID}").mock(return_value=httpx.Response(200, json=AGENT))
    respx.get(f"{BASE}/v1/agents/{AGENT_ID}/keys").mock(return_value=httpx.Response(200, json={"keys": [_key_row(thumbprint, pub)]}))
    respx.post(f"{BASE}/v1/registry/attestations").mock(
        return_value=httpx.Response(403, json={"code": "issuer_not_accredited", "message": "https://mock-issuer.example is not accredited"})
    )
    with pytest.raises(IssuerAdapterError) as info:
        attest_agent(client, AGENT_ID, thumbprint, issuer=StubIssuer())
    assert info.value.code == "issuer_not_accredited" and "403" in info.value.detail


@respx.mock
def test_attest_agent_reports_a_repeat_and_a_missing_lookup(client: Grantex) -> None:
    _private, pub, thumbprint = generate_agent_key()
    respx.get(f"{BASE}/v1/agents/{AGENT_ID}").mock(return_value=httpx.Response(200, json=AGENT))
    respx.get(f"{BASE}/v1/agents/{AGENT_ID}/keys").mock(return_value=httpx.Response(200, json={"keys": [_key_row(thumbprint, pub)]}))
    respx.post(f"{BASE}/v1/registry/attestations").mock(return_value=httpx.Response(200, json=REGISTRY_RECORD))
    respx.get(f"{BASE}/v1/registry/agents/{DID}").mock(return_value=httpx.Response(404, json={"code": "NOT_FOUND", "message": "no"}))
    outcome = attest_agent(client, AGENT_ID, thumbprint, issuer=StubIssuer())
    assert outcome.created is False and outcome.level is None and outcome.flags == ()


def test_post_attestation_transport_errors_and_bodiless_answers() -> None:
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(IssuerAdapterError) as info:
        post_attestation(BASE, "h.p.s", transport=httpx.MockTransport(down))
    assert info.value.code == "registry_unreachable"
    with pytest.raises(IssuerAdapterError) as empty:
        post_attestation(BASE, "h.p.s", transport=httpx.MockTransport(lambda r: httpx.Response(201, text="")))
    assert empty.value.code == "registry_refused"
    with pytest.raises(IssuerAdapterError) as html:
        post_attestation(BASE, "h.p.s", transport=httpx.MockTransport(lambda r: httpx.Response(502, text="<html>bad gateway</html>")))
    assert html.value.code == "registry_refused" and "502" in html.value.detail


# ─── grantex-attest ─────────────────────────────────────────────────────────


@pytest.fixture
def stub_adapter_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Dict[str, str]:
    """A ``stub`` adapter on sys.path, selected through the entry point like a private one."""
    site = tmp_path / "site"
    site.mkdir()
    (site / "stub_attest_issuer.py").write_text(
        "from tests.test_issuers_attest import StubIssuer\n\ndef create(config):\n    return StubIssuer()\n", encoding="utf-8"
    )
    info = site / "stub_attest_issuer-0.0.0.dist-info"
    info.mkdir()
    (info / "METADATA").write_text("Metadata-Version: 2.1\nName: stub-attest-issuer\nVersion: 0.0.0\n", encoding="utf-8")
    (info / "entry_points.txt").write_text("[grantex.issuers]\nstub-attest = stub_attest_issuer:create\n", encoding="utf-8")
    monkeypatch.syspath_prepend(str(site))
    import importlib

    importlib.invalidate_caches()
    return {"GRANTEX_API_KEY": "test-key", "GRANTEX_BASE_URL": BASE, "GRANTEX_ISSUER_ADAPTER": "stub-attest"}


def _steps(out: io.StringIO) -> List[Dict[str, Any]]:
    return [json.loads(line) for line in out.getvalue().splitlines()]


@respx.mock
def test_grantex_attest_registers_proves_and_attests_in_one_command(tmp_path: Path, stub_adapter_env: Dict[str, str]) -> None:
    key_file = tmp_path / "shopper.json"
    state: Dict[str, Any] = {"keys": []}

    def list_keys(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"keys": state["keys"]})

    def add_key(request: httpx.Request) -> httpx.Response:
        pub = json.loads(request.content)["publicJwk"]
        assert "d" not in pub
        state["keys"].append(_key_row(jwk_thumbprint(pub), pub, "pending"))
        return httpx.Response(201, json=state["keys"][-1])

    def challenge(request: httpx.Request) -> httpx.Response:
        thumbprint = request.url.path.split("/")[-2]
        return httpx.Response(201, json={
            "thumbprint": thumbprint, "challenge": "n" * 43, "audience": "https://grantex.dev", "subject": AGENT_ID,
            "typ": KEY_PROOF_TYP, "alg": "ES256", "expiresAt": None,
        })

    def prove(request: httpx.Request) -> httpx.Response:
        thumbprint = request.url.path.split("/")[-2]
        proof = json.loads(request.content)["proof"]
        row = next(k for k in state["keys"] if k["thumbprint"] == thumbprint)
        # The registry's check: signature with the registered key, typ, aud, sub, nonce, kid.
        assert jwt.get_unverified_header(proof)["typ"] == KEY_PROOF_TYP
        claims = jwt.decode(proof, jwt.PyJWK(row["jwk"]).key, algorithms=["ES256"], audience="https://grantex.dev")
        assert claims["nonce"] == "n" * 43 and claims["sub"] == AGENT_ID
        row.update(_key_row(thumbprint, row["jwk"], "active"))
        return httpx.Response(200, json=row)

    respx.get(f"{BASE}/v1/agents/{AGENT_ID}").mock(return_value=httpx.Response(200, json=AGENT))
    respx.get(f"{BASE}/v1/agents/{AGENT_ID}/keys").mock(side_effect=list_keys)
    respx.post(f"{BASE}/v1/agents/{AGENT_ID}/keys").mock(side_effect=add_key)
    respx.post(url__regex=rf"{BASE}/v1/agents/{AGENT_ID}/keys/[^/]+/challenge").mock(side_effect=challenge)
    respx.post(url__regex=rf"{BASE}/v1/agents/{AGENT_ID}/keys/[^/]+/prove").mock(side_effect=prove)
    respx.post(f"{BASE}/v1/registry/attestations").mock(return_value=httpx.Response(201, json=REGISTRY_RECORD))
    respx.get(f"{BASE}/v1/registry/agents/{DID}").mock(return_value=httpx.Response(200, json={"agent_did": DID, "level": "attested", "flags": []}))

    out, err = io.StringIO(), io.StringIO()
    env = {**stub_adapter_env, "GRANTEX_PROVIDER_DID": "did:web:provider.example"}
    assert run([AGENT_ID, "--key", str(key_file), "--generate-key"], out, err, env) == 0, err.getvalue()
    steps = _steps(out)
    assert [s["step"] for s in steps] == [
        "key_generated", "key_added", "key_proved", "issuer",
        "attestation_issued", "attestation_ingested", "attestation_issued", "attestation_ingested", "lookup",
    ]
    assert {s["source"] for s in steps if s["step"] in ("key_added", "key_proved", "attestation_ingested", "lookup")} == {"live"}
    assert steps[3]["source"] == "stub-attest" and steps[4]["source"] == "stub-attest"
    issued_types = [s["attestation_type"] for s in steps if s["step"] == "attestation_issued"]
    assert issued_types == ["urn:grantex:tm:agent.identity", "urn:grantex:tm:provider.entity"]
    assert steps[2]["status"] == "active" and steps[5]["id"] == "ratt_01" and steps[8]["level"] == "attested"
    assert "d" in json.loads(key_file.read_text(encoding="utf-8"))

    # A second run finds the active key and skips registration and proof.
    out2 = io.StringIO()
    assert run([AGENT_ID, "--key", str(key_file)], out2, io.StringIO(), stub_adapter_env) == 0
    assert [s["step"] for s in _steps(out2)] == [
        "issuer", "attestation_issued", "attestation_ingested", "attestation_issued", "attestation_ingested", "lookup",
    ]


@respx.mock
def test_grantex_attest_with_the_mock_adapter_hands_it_the_generated_key(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The documented command, --generate-key with GRANTEX_ISSUER_ADAPTER=mock: the mock
    (here the fake of its CLI) must find the key the command just wrote."""
    from tests.test_issuers import FAKE_CLI
    import textwrap

    script = tmp_path / "fake_mock_issuer.py"
    script.write_text(textwrap.dedent(FAKE_CLI), encoding="utf-8")
    state = tmp_path / "state"
    state.mkdir()
    monkeypatch.setenv("GRANTEX_MOCK_ISSUER_CLI", f"{sys.executable} {script}")
    monkeypatch.setenv("GRANTEX_MOCK_ISSUER_DIR", str(state))
    key_file = tmp_path / "agent-key.json"
    state_keys: Dict[str, Any] = {"keys": []}

    def add_key(request: httpx.Request) -> httpx.Response:
        pub = json.loads(request.content)["publicJwk"]
        state_keys["keys"].append(_key_row(jwk_thumbprint(pub), pub, "pending"))
        return httpx.Response(201, json=state_keys["keys"][-1])

    def prove(request: httpx.Request) -> httpx.Response:
        thumbprint = request.url.path.split("/")[-2]
        row = next(k for k in state_keys["keys"] if k["thumbprint"] == thumbprint)
        row.update(_key_row(thumbprint, row["jwk"], "active"))
        return httpx.Response(200, json=row)

    respx.get(f"{BASE}/v1/agents/{AGENT_ID}").mock(return_value=httpx.Response(200, json=AGENT))
    respx.get(f"{BASE}/v1/agents/{AGENT_ID}/keys").mock(side_effect=lambda r: httpx.Response(200, json=state_keys))
    respx.post(f"{BASE}/v1/agents/{AGENT_ID}/keys").mock(side_effect=add_key)
    respx.post(url__regex=rf"{BASE}/v1/agents/{AGENT_ID}/keys/[^/]+/challenge").mock(
        side_effect=lambda r: httpx.Response(201, json={
            "thumbprint": r.url.path.split("/")[-2], "challenge": "n" * 43, "audience": "https://grantex.dev",
            "subject": AGENT_ID, "typ": KEY_PROOF_TYP, "alg": "ES256", "expiresAt": None,
        })
    )
    respx.post(url__regex=rf"{BASE}/v1/agents/{AGENT_ID}/keys/[^/]+/prove").mock(side_effect=prove)
    respx.post(f"{BASE}/v1/registry/attestations").mock(return_value=httpx.Response(201, json=REGISTRY_RECORD))
    respx.get(f"{BASE}/v1/registry/agents/{DID}").mock(return_value=httpx.Response(200, json={"agent_did": DID, "level": "attested", "flags": []}))

    out, err = io.StringIO(), io.StringIO()
    env = {"GRANTEX_API_KEY": "test-key", "GRANTEX_BASE_URL": BASE, "GRANTEX_ISSUER_ADAPTER": "mock", "GRANTEX_PROVIDER_DID": "did:web:provider.example"}
    assert run([AGENT_ID, "--key", str(key_file), "--generate-key"], out, err, env) == 0, err.getvalue()
    steps = _steps(out)
    issued = [s for s in steps if s["step"] == "attestation_issued"]
    assert [s["attestation_type"] for s in issued] == ["urn:grantex:tm:agent.identity", "urn:grantex:tm:provider.entity"]
    assert issued[0]["external_credential_id"] == "ppt-att-001" and issued[0]["issuer_attestation_id"] == "att-001"
    # The fake CLI read the key file the command generated (the thumbprint it signed is the key's).
    assert issued[0]["issuer"] == "https://mock-issuer.example"
    assert json.loads((state / "state.json").read_text(encoding="utf-8"))["passports"]["att-001"]["thumb"] == jwk_thumbprint(public_jwk(json.loads(key_file.read_text(encoding="utf-8"))))


def test_grantex_attest_needs_an_api_key_and_a_key_file(tmp_path: Path) -> None:
    err = io.StringIO()
    assert run([AGENT_ID, "--key", str(tmp_path / "k.json")], io.StringIO(), err, {}) == 2
    assert "GRANTEX_API_KEY" in err.getvalue()
    err = io.StringIO()
    assert run([AGENT_ID, "--key", str(tmp_path / "k.json")], io.StringIO(), err, {"GRANTEX_API_KEY": "k"}) == 1
    assert "--generate-key" in err.getvalue()


def test_grantex_attest_fails_closed_without_an_installed_adapter(tmp_path: Path) -> None:
    private, _pub, _tp = generate_agent_key()
    key_file = tmp_path / "k.json"
    key_file.write_text(json.dumps(private), encoding="utf-8")
    err = io.StringIO()
    env = {"GRANTEX_API_KEY": "k", "GRANTEX_ISSUER_ADAPTER": "issuer-example"}
    assert run([AGENT_ID, "--key", str(key_file)], io.StringIO(), err, env) == 1
    assert err.getvalue().startswith("grantex-attest: adapter_not_installed:")


@respx.mock
def test_grantex_attest_reports_a_registry_refusal(tmp_path: Path, stub_adapter_env: Dict[str, str]) -> None:
    private, pub, thumbprint = generate_agent_key()
    key_file = tmp_path / "k.json"
    key_file.write_text(json.dumps(private), encoding="utf-8")
    respx.get(f"{BASE}/v1/agents/{AGENT_ID}").mock(return_value=httpx.Response(200, json=AGENT))
    respx.get(f"{BASE}/v1/agents/{AGENT_ID}/keys").mock(return_value=httpx.Response(200, json={"keys": [_key_row(thumbprint, pub)]}))
    respx.post(f"{BASE}/v1/registry/attestations").mock(return_value=httpx.Response(400, json={"code": "key_unproven", "message": "not proven"}))
    err = io.StringIO()
    assert run([AGENT_ID, "--key", str(key_file)], io.StringIO(), err, stub_adapter_env) == 1
    assert err.getvalue() == "grantex-attest: key_unproven: the registry refused the attestation (400): not proven\n"
