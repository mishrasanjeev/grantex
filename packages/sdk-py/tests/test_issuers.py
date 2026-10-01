"""The accredited issuer seam: the protocol, the mock adapter over the mock
issuer CLI, the entry-point loader, and the documented example adapter.

The mock adapter is exercised against a fake CLI that speaks the mock issuer's
command line (JSON on stdout, ``code: message`` refusals on stderr), so these
tests need no Node.js; the real mock issuer is driven the same way by
``make demo-attest``. ``test_mock_round_trip_against_the_repository_cli`` runs
the real one when it is available and is skipped otherwise.
"""

from __future__ import annotations

import base64
import importlib
import json
import os
import shutil
import subprocess
import sys
import textwrap
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List

import httpx
import pytest

from grantex.issuers import (
    ADAPTER_AMBIGUOUS,
    ADAPTER_INVALID,
    ADAPTER_NOT_CONFIGURED,
    ADAPTER_NOT_INSTALLED,
    ISSUER_RESPONSE_INVALID,
    KEY_BINDING_MISMATCH,
    AccreditedIssuerClient,
    AgentRecord,
    CredentialRef,
    IssuedAttestation,
    IssuerAdapterConfig,
    IssuerAdapterError,
    IssuerMetadata,
    MockIssuerClient,
    ProvedKey,
    installed_adapters,
    load_issuer_client,
)
from grantex.issuers._mock import AGENT_KEYS_ENV, CLI_ENV, STATE_DIR_ENV, TYPES_ENV
from tests.docs_examples.issuer_adapter import ExampleIssuerClient, create_client

ROOT = Path(__file__).resolve().parents[3]
THUMBPRINT = "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs"
AGENT = AgentRecord(
    agent_id="ag_01",
    did="did:web:provider.example:agents:shopper-01",
    provider_did="did:web:provider.example",
    software_name="Nimbus Shopper",
    software_version="2.4",
)
KEY = ProvedKey(
    thumbprint=THUMBPRINT,
    public_jwk={"kty": "EC", "crv": "P-256", "x": "x", "y": "y"},
    possession_proved_at=datetime(2026, 9, 30, tzinfo=timezone.utc),
)

# A stand-in for packages/mock-issuer/src/cli.ts: same commands, flags, output
# shapes and refusal format. State is a JSON file under --dir.
FAKE_CLI = r'''
import base64, json, os, sys
args = sys.argv[1:]
command, rest = args[0], args[1:]
opts = {}
i = 0
while i < len(rest):
    if not rest[i].startswith("--"):
        sys.stderr.write(f"grantex-mock-issuer: unexpected argument {rest[i]}\n\nusage\n"); sys.exit(2)
    name = rest[i][2:]
    if name == "generate-agent-key":
        opts[name] = "true"; i += 1
    else:
        opts[name] = rest[i + 1]; i += 2
d = opts.get("dir") or os.environ.get("MOCK_ISSUER_DIR")
if not d:
    sys.stderr.write("grantex-mock-issuer: --dir (or MOCK_ISSUER_DIR) is required\n\nusage\n"); sys.exit(2)
state_path = os.path.join(d, "state.json")
state = json.load(open(state_path)) if os.path.exists(state_path) else {"passports": {}}
def save():
    json.dump(state, open(state_path, "w"))
def b64(obj):
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip("=")
def refuse(code, message):
    sys.stderr.write(f"grantex-mock-issuer: {code}: {message}\n"); sys.exit(1)
if command == "keys":
    print(json.dumps({"entity_id": "https://mock-issuer.example", "status_list_base": "https://mock-issuer.example/status/",
                      "kid": "mock-1", "jwks": {"keys": [{"kty": "EC", "crv": "P-256", "x": "mx", "y": "my", "kid": "mock-1"}]}}))
elif command == "issue-passport":
    key_file = opts.get("agent-key")
    if not key_file or not os.path.exists(key_file):
        refuse("key_unproven", "no agent key")
    agent_jwk = json.load(open(key_file))
    thumb = agent_jwk.get("thumbprint")
    if thumb is None:  # a real private JWK: RFC 7638 over the EC members
        import hashlib
        members = {m: agent_jwk[m] for m in ("crv", "kty", "x", "y")}
        canonical = json.dumps(members, separators=(",", ":"), sort_keys=True).encode()
        thumb = base64.urlsafe_b64encode(hashlib.sha256(canonical).digest()).decode().rstrip("=")
    if os.environ.get("FAKE_CLI_WRONG_KEY"):
        thumb = "other-thumbprint"
    att = f"att-{len(state['passports']) + 1:03d}"
    state["passports"][att] = {"status": "valid", "thumb": thumb, "did": opts.get("agent-did")}
    save()
    print(json.dumps({"attestation_id": att, "passport_id": f"ppt-{att}", "passport": "eyJ.passport.sig~",
                      "external_credential_hash": "sha-256:OiVR9AjgZRd6DJ8n_6dpLox_0KzFKt7gZ9MHpgHXOKQ",
                      "key_thumbprint": thumb, "status": {"uri": "https://mock-issuer.example/status/1", "idx": 7},
                      "iat": 1790596800, "exp": 1793188800, "agent_key_file": key_file}))
elif command == "attest":
    att = opts["attestation-id"]
    if att not in state["passports"]:
        refuse("attestation_not_registered", f"{att} was never issued")
    if state["passports"][att]["status"] != "valid":
        refuse("passport_revoked", f"{att} is {state['passports'][att]['status']}")
    typ = os.environ.get("FAKE_CLI_TYP", "grantex-attestation+jwt")
    header = {"typ": typ, "alg": "ES256", "kid": "mock-1"}
    payload = {"iss": "https://mock-issuer.example", "id": att, "sub": state["passports"][att]["did"],
               "type": opts.get("type", "urn:grantex:tm:agent.identity"), "external_credential_id": f"ppt-{att}"}
    if not os.environ.get("FAKE_CLI_NO_THUMB"):
        payload["key_thumbprint"] = state["passports"][att]["thumb"]
    print(f"{b64(header)}.{b64(payload)}.c2ln")
elif command in ("revoke", "suspend", "reinstate", "status"):
    att = opts["attestation-id"]
    if att not in state["passports"]:
        refuse("attestation_not_registered", f"{att} was never issued")
    p = state["passports"][att]
    if command == "revoke": p["status"] = "invalid"
    elif command == "suspend": p["status"] = "suspended"
    elif command == "reinstate": p["status"] = "valid"
    save()
    print(json.dumps({"attestation_id": att, "status": p["status"]}))
else:
    sys.stderr.write(f"grantex-mock-issuer: unknown command {command}\n\nusage\n"); sys.exit(2)
'''


@pytest.fixture()
def fake_cli(tmp_path: Path) -> List[str]:
    script = tmp_path / "fake_mock_issuer.py"
    script.write_text(textwrap.dedent(FAKE_CLI), encoding="utf-8")
    return [sys.executable, str(script)]


@pytest.fixture()
def state_dir(tmp_path: Path) -> Path:
    d = tmp_path / "state"
    (d / "agents").mkdir(parents=True)
    (d / "agents" / f"{THUMBPRINT}.json").write_text(json.dumps({"thumbprint": THUMBPRINT, "d": "secret"}), encoding="utf-8")
    return d


@pytest.fixture()
def mock_client(fake_cli: List[str], state_dir: Path) -> MockIssuerClient:
    return MockIssuerClient(cli=fake_cli, state_dir=str(state_dir))


def _header(jws: str) -> Dict[str, Any]:
    segment = jws.split(".")[0]
    return json.loads(base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)))  # type: ignore[no-any-return]


# ─── the protocol ───────────────────────────────────────────────────────────


def test_mock_client_satisfies_the_protocol(mock_client: MockIssuerClient) -> None:
    assert isinstance(mock_client, AccreditedIssuerClient)


def test_an_object_missing_an_operation_is_not_a_client() -> None:
    class Partial:
        def issuer_metadata(self) -> IssuerMetadata:
            raise NotImplementedError

        def request_attestation(self, agent_record: AgentRecord, proved_key: ProvedKey) -> IssuedAttestation:
            raise NotImplementedError

    assert not isinstance(Partial(), AccreditedIssuerClient)


# ─── the mock adapter ───────────────────────────────────────────────────────


def test_mock_adapter_round_trip(mock_client: MockIssuerClient) -> None:
    """metadata → attestation bound to the proved key → status → revoke → status."""
    metadata = mock_client.issuer_metadata()
    assert metadata.issuer_id == "https://mock-issuer.example"
    assert metadata.scopes == ("urn:grantex:tm:agent.identity", "urn:grantex:tm:provider.entity")
    assert metadata.jwks is not None and metadata.jwks["keys"][0]["kid"] == "mock-1"  # type: ignore[index]
    assert metadata.status_list_base == "https://mock-issuer.example/status/"

    issued = mock_client.request_attestation(AGENT, KEY)
    assert _header(issued.jws)["typ"] == "grantex-attestation+jwt"
    assert issued.attestation_type == "urn:grantex:tm:agent.identity"
    # The same passport also attests the provider's entity; both make the level attested.
    assert [c.attestation_type for c in issued.companions] == ["urn:grantex:tm:provider.entity"]
    assert issued.companions[0].credential_ref == issued.credential_ref and issued.companions[0].jws != issued.jws
    assert issued.key_thumbprint == THUMBPRINT
    # The reference names the passport (what the attestation's external_credential_id
    # says) and keeps the issuer's own attestation id for status operations.
    assert issued.credential_ref == CredentialRef(
        "https://mock-issuer.example", "ppt-att-001", "sha-256:OiVR9AjgZRd6DJ8n_6dpLox_0KzFKt7gZ9MHpgHXOKQ",
        issuer_attestation_id="att-001",
    )
    assert issued.expires_at == datetime(2026, 10, 28, 12, 0, tzinfo=timezone.utc)
    assert issued.passport == "eyJ.passport.sig~"

    assert mock_client.fetch_status(issued.credential_ref).state == "valid"
    subprocess.run([*mock_client._cli, "revoke", "--attestation-id", "att-001", "--dir", mock_client._state_dir], check=True)
    status = mock_client.fetch_status(issued.credential_ref)
    assert status.state == "revoked" and status.source == "cli"


def test_mock_adapter_passes_the_agent_record_to_the_issuer(mock_client: MockIssuerClient, state_dir: Path) -> None:
    mock_client.request_attestation(AGENT, KEY)
    state = json.loads((state_dir / "state.json").read_text(encoding="utf-8"))
    assert state["passports"]["att-001"]["did"] == AGENT.did


def test_mock_adapter_refuses_an_unproven_key(mock_client: MockIssuerClient) -> None:
    unknown = ProvedKey(thumbprint="not-on-file", public_jwk=KEY.public_jwk)
    with pytest.raises(IssuerAdapterError) as info:
        mock_client.request_attestation(AGENT, unknown)
    assert info.value.code == "key_unproven"


def test_mock_adapter_takes_a_named_agent_key_file(fake_cli: List[str], tmp_path: Path) -> None:
    key_file = tmp_path / "shopper.json"
    key_file.write_text(json.dumps({"thumbprint": THUMBPRINT}), encoding="utf-8")
    (tmp_path / "empty").mkdir()
    client = MockIssuerClient(cli=fake_cli, state_dir=str(tmp_path / "empty"), agent_key_files={THUMBPRINT: str(key_file)})
    assert client.request_attestation(AGENT, KEY).key_thumbprint == THUMBPRINT


def test_mock_adapter_refuses_an_attestation_for_another_key(
    mock_client: MockIssuerClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKE_CLI_WRONG_KEY", "1")
    with pytest.raises(IssuerAdapterError) as info:
        mock_client.request_attestation(AGENT, KEY)
    assert info.value.code == KEY_BINDING_MISMATCH


def test_mock_adapter_refuses_an_agent_attestation_without_the_bound_key(
    mock_client: MockIssuerClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # spec/attestation-1.0.md: an agent.* attestation always names key_thumbprint.
    monkeypatch.setenv("FAKE_CLI_NO_THUMB", "1")
    with pytest.raises(IssuerAdapterError) as info:
        mock_client.request_attestation(AGENT, KEY)
    assert info.value.code == KEY_BINDING_MISMATCH


def test_mock_adapter_needs_the_provider_did_for_provider_entity(mock_client: MockIssuerClient) -> None:
    without_provider = AgentRecord(agent_id=AGENT.agent_id, did=AGENT.did)
    with pytest.raises(IssuerAdapterError) as info:
        mock_client.request_attestation(without_provider, KEY)
    assert info.value.code == ADAPTER_INVALID and "provider_did" in info.value.detail
    only_identity = MockIssuerClient(cli=mock_client._cli, state_dir=mock_client._state_dir, attestation_types=["urn:grantex:tm:agent.identity"])
    assert only_identity.request_attestation(without_provider, KEY).companions == ()


def test_mock_adapter_takes_a_registered_agent_key_file(fake_cli: List[str], tmp_path: Path) -> None:
    key_file = tmp_path / "generated.json"
    key_file.write_text(json.dumps({"thumbprint": "tp3"}), encoding="utf-8")
    (tmp_path / "empty").mkdir()
    client = MockIssuerClient(cli=fake_cli, state_dir=str(tmp_path / "empty"))
    client.register_agent_key_file("tp3", str(key_file))
    assert client.request_attestation(AGENT, ProvedKey(thumbprint="tp3", public_jwk={})).key_thumbprint == "tp3"


def test_mock_adapter_refuses_an_attestation_with_the_wrong_typ(
    mock_client: MockIssuerClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKE_CLI_TYP", "JWT")
    with pytest.raises(IssuerAdapterError) as info:
        mock_client.request_attestation(AGENT, KEY)
    assert info.value.code == ISSUER_RESPONSE_INVALID and "typ" in info.value.detail


def test_mock_adapter_surfaces_the_issuers_refusal_code(mock_client: MockIssuerClient) -> None:
    with pytest.raises(IssuerAdapterError) as info:
        mock_client.fetch_status(CredentialRef("https://mock-issuer.example", "ppt-404", "sha-256:x", issuer_attestation_id="att-404"))
    assert info.value.code == "attestation_not_registered"


def test_mock_adapter_status_needs_the_issuers_attestation_id(mock_client: MockIssuerClient) -> None:
    with pytest.raises(IssuerAdapterError) as info:
        mock_client.fetch_status(CredentialRef("https://mock-issuer.example", "ppt-att-001", "sha-256:x"))
    assert info.value.code == ISSUER_RESPONSE_INVALID


def test_mock_adapter_refuses_a_credential_of_another_issuer(mock_client: MockIssuerClient) -> None:
    with pytest.raises(IssuerAdapterError) as info:
        mock_client.fetch_status(CredentialRef("https://issuer.example", "ppt-att-001", "sha-256:x", issuer_attestation_id="att-001"))
    assert info.value.code == ISSUER_RESPONSE_INVALID


def test_mock_adapter_reports_a_missing_command(state_dir: Path) -> None:
    client = MockIssuerClient(cli=[str(state_dir / "no-such-binary")], state_dir=str(state_dir))
    with pytest.raises(IssuerAdapterError) as info:
        client.issuer_metadata()
    assert info.value.code == ADAPTER_NOT_INSTALLED


def test_mock_adapter_reports_a_usage_error_as_invalid(fake_cli: List[str], state_dir: Path) -> None:
    client = MockIssuerClient(cli=[*fake_cli, "no-such-command"], state_dir=str(state_dir))
    with pytest.raises(IssuerAdapterError) as info:
        client.issuer_metadata()
    assert info.value.code == ADAPTER_INVALID


def test_mock_adapter_only_attests_the_mocks_trust_marks(fake_cli: List[str], state_dir: Path) -> None:
    with pytest.raises(IssuerAdapterError) as info:
        MockIssuerClient(cli=fake_cli, state_dir=str(state_dir), attestation_types=["urn:grantex:tm:provider.screening"])
    assert info.value.code == ADAPTER_INVALID
    only = MockIssuerClient(cli=fake_cli, state_dir=str(state_dir), attestation_types=["urn:grantex:tm:agent.identity"])
    assert only.request_attestation(AGENT, KEY).companions == ()


def test_mock_adapter_types_from_the_environment(fake_cli: List[str], state_dir: Path) -> None:
    environ = {CLI_ENV: " ".join(fake_cli), STATE_DIR_ENV: str(state_dir), TYPES_ENV: "urn:grantex:tm:provider.entity"}
    client = MockIssuerClient.from_config(IssuerAdapterConfig(adapter="mock"), environ=environ)
    issued = client.request_attestation(AGENT, KEY)
    assert issued.attestation_type == "urn:grantex:tm:provider.entity" and issued.companions == ()


def test_mock_adapter_from_the_environment(fake_cli: List[str], state_dir: Path, tmp_path: Path) -> None:
    key_file = tmp_path / "k.json"
    key_file.write_text(json.dumps({"thumbprint": "tp2"}), encoding="utf-8")
    environ = {CLI_ENV: " ".join(fake_cli), STATE_DIR_ENV: str(state_dir), AGENT_KEYS_ENV: f"tp2={key_file}"}
    client = MockIssuerClient.from_config(IssuerAdapterConfig(adapter="mock"), environ=environ)
    assert client._agent_key_files == {"tp2": str(key_file)}
    assert client.request_attestation(AGENT, ProvedKey(thumbprint="tp2", public_jwk={})).key_thumbprint == "tp2"


def test_mock_adapter_from_the_environment_needs_a_state_dir(fake_cli: List[str]) -> None:
    with pytest.raises(IssuerAdapterError) as info:
        MockIssuerClient.from_config(IssuerAdapterConfig(adapter="mock"), environ={CLI_ENV: " ".join(fake_cli)})
    assert info.value.code == ADAPTER_INVALID and STATE_DIR_ENV in info.value.detail


def test_mock_adapter_rejects_a_malformed_agent_keys_entry(fake_cli: List[str], state_dir: Path) -> None:
    environ = {CLI_ENV: " ".join(fake_cli), STATE_DIR_ENV: str(state_dir), AGENT_KEYS_ENV: "no-equals-sign"}
    with pytest.raises(IssuerAdapterError) as info:
        MockIssuerClient.from_config(IssuerAdapterConfig(adapter="mock"), environ=environ)
    assert info.value.code == ADAPTER_INVALID


# ─── the loader ─────────────────────────────────────────────────────────────


def test_the_sdk_registers_the_mock_adapter() -> None:
    assert "mock" in installed_adapters()


def test_load_mock_adapter_by_environment(fake_cli: List[str], state_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # The entry-point factory reads the process environment, as it will in production.
    monkeypatch.setenv(CLI_ENV, " ".join(fake_cli))
    monkeypatch.setenv(STATE_DIR_ENV, str(state_dir))
    client = load_issuer_client(environ={"GRANTEX_ISSUER_ADAPTER": "mock"})
    assert isinstance(client, MockIssuerClient)
    assert client.issuer_metadata().issuer_id == "https://mock-issuer.example"


def test_no_adapter_configured_fails_closed() -> None:
    with pytest.raises(IssuerAdapterError) as info:
        load_issuer_client(environ={})
    assert info.value.code == ADAPTER_NOT_CONFIGURED
    assert "GRANTEX_ISSUER_ADAPTER" in info.value.detail


def test_non_mock_adapter_missing_fails_closed() -> None:
    with pytest.raises(IssuerAdapterError) as info:
        load_issuer_client(environ={"GRANTEX_ISSUER_ADAPTER": "issuer-example"})
    assert info.value.code == ADAPTER_NOT_INSTALLED
    assert "'issuer-example'" in info.value.detail and "GRANTEX_ISSUER_ADAPTER=mock" in info.value.detail


def test_config_from_environ_reads_every_variable() -> None:
    config = IssuerAdapterConfig.from_environ(
        {
            "GRANTEX_ISSUER_ADAPTER": "example",
            "GRANTEX_ISSUER_BASE_URL": "https://issuer.example",
            "GRANTEX_ISSUER_CLIENT_ID": "client-id",
            "GRANTEX_ISSUER_CLIENT_SECRET": "placeholder-secret",
            "GRANTEX_ISSUER_SCOPES": "urn:grantex:tm:agent.identity, urn:grantex:tm:provider.entity",
        }
    )
    assert config.adapter == "example" and config.base_url == "https://issuer.example"
    assert config.client_id == "client-id" and config.client_secret == "placeholder-secret" and config.token is None
    assert config.scopes == ("urn:grantex:tm:agent.identity", "urn:grantex:tm:provider.entity")
    assert IssuerAdapterConfig.from_environ({"GRANTEX_ISSUER_ADAPTER": ""}).adapter is None


@pytest.fixture()
def stub_distribution(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """A distribution on sys.path providing grantex.issuers entry points, without pip."""
    site = tmp_path / "site"
    site.mkdir()
    (site / "stub_issuer.py").write_text(
        textwrap.dedent(
            '''
            from datetime import datetime, timezone
            from grantex.issuers import IssuedAttestation, IssuerMetadata, IssuerStatus, CredentialRef

            class StubClient:
                def __init__(self, config):
                    self.config = config
                def issuer_metadata(self):
                    return IssuerMetadata(issuer_id="https://issuer.example", scopes=self.config.scopes)
                def request_attestation(self, agent_record, proved_key):
                    return IssuedAttestation("h.p.s", "urn:grantex:tm:agent.identity",
                        CredentialRef("https://issuer.example", "c-1", "sha-256:x"), proved_key.thumbprint)
                def fetch_status(self, credential_ref):
                    return IssuerStatus("valid", datetime.now(tz=timezone.utc), "api")

            def create(config):
                return StubClient(config)

            def not_a_client(config):
                return object()

            not_callable = 42
            '''
        ),
        encoding="utf-8",
    )
    info = site / "stub_issuer-0.0.0.dist-info"
    info.mkdir()
    (info / "METADATA").write_text("Metadata-Version: 2.1\nName: stub-issuer\nVersion: 0.0.0\n", encoding="utf-8")
    (info / "entry_points.txt").write_text(
        "[grantex.issuers]\nstub = stub_issuer:create\nbroken = stub_issuer:not_a_client\n"
        "uncallable = stub_issuer:not_callable\nunimportable = stub_issuer_missing:create\n",
        encoding="utf-8",
    )
    monkeypatch.syspath_prepend(str(site))
    importlib.invalidate_caches()
    yield site
    sys.modules.pop("stub_issuer", None)


def test_stub_entry_point_is_loaded(stub_distribution: Path) -> None:
    """The private adapter path: a package installed beside the SDK is selected by name."""
    assert {"stub", "broken"} <= set(installed_adapters())
    client = load_issuer_client(
        environ={"GRANTEX_ISSUER_ADAPTER": "stub", "GRANTEX_ISSUER_SCOPES": "urn:grantex:tm:agent.identity"}
    )
    assert type(client).__name__ == "StubClient"
    assert client.issuer_metadata() == IssuerMetadata(issuer_id="https://issuer.example", scopes=("urn:grantex:tm:agent.identity",))
    assert client.request_attestation(AGENT, KEY).key_thumbprint == THUMBPRINT
    assert client.fetch_status(CredentialRef("https://issuer.example", "c-1", "sha-256:x")).state == "valid"


def test_an_entry_point_that_is_not_a_client_is_refused(stub_distribution: Path) -> None:
    for name in ("broken", "uncallable", "unimportable"):
        with pytest.raises(IssuerAdapterError) as info:
            load_issuer_client(name)
        assert info.value.code == ADAPTER_INVALID, name


def test_two_packages_with_the_same_adapter_name_are_refused(stub_distribution: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    other = stub_distribution.parent / "site2"
    info_dir = other / "other_issuer-0.0.0.dist-info"
    info_dir.mkdir(parents=True)
    (info_dir / "METADATA").write_text("Metadata-Version: 2.1\nName: other-issuer\nVersion: 0.0.0\n", encoding="utf-8")
    (info_dir / "entry_points.txt").write_text("[grantex.issuers]\nstub = stub_issuer:create\n", encoding="utf-8")
    monkeypatch.syspath_prepend(str(other))
    importlib.invalidate_caches()
    with pytest.raises(IssuerAdapterError) as info:
        load_issuer_client("stub")
    assert info.value.code == ADAPTER_AMBIGUOUS


# ─── the documented example ─────────────────────────────────────────────────

EXAMPLE = "packages/sdk-py/tests/docs_examples/issuer_adapter.py"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8").replace("\r\n", "\n")


def test_the_example_adapter_is_embedded_verbatim() -> None:
    import re

    doc = _read(ROOT / "docs" / "issuers" / "implementing-an-issuer-adapter.md")
    match = re.search(rf"\{{/\* snippet: {re.escape(EXAMPLE)} \*/\}}\n```python\n([\s\S]*?)\n```", doc)
    assert match is not None
    assert match.group(1) == _read(ROOT / EXAMPLE).rstrip("\n")


def test_the_example_adapter_is_a_client_and_fails_closed() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer placeholder-token"
        if request.url.path == "/.well-known/issuer":
            return httpx.Response(200, json={"issuer": "https://issuer.example", "jwks": {"keys": []}})
        if request.url.path == "/attestations":
            body = json.loads(request.content)
            assert "d" not in body["key"] and body["thumbprint"] == THUMBPRINT
            return httpx.Response(
                200,
                json={"attestation": "h.p.s", "type": "urn:grantex:tm:agent.identity", "issuer": "https://issuer.example",
                      "credential_id": "c-9", "credential_hash": "sha-256:y", "exp": 1793188800},
            )
        if request.url.path == "/credentials/c-9/status":
            return httpx.Response(200, json={"status": "suspended"})
        return httpx.Response(403, json={"code": "scope_not_accredited", "message": "no"})

    config = IssuerAdapterConfig(adapter="example", base_url="https://issuer.example", token="placeholder-token")
    client = ExampleIssuerClient(config, transport=httpx.MockTransport(handler))
    assert isinstance(client, AccreditedIssuerClient)
    assert isinstance(create_client(config), ExampleIssuerClient)
    assert client.issuer_metadata().issuer_id == "https://issuer.example"
    issued = client.request_attestation(AGENT, KEY)
    assert issued.credential_ref.external_credential_id == "c-9"
    assert client.fetch_status(issued.credential_ref).state == "suspended"
    with pytest.raises(IssuerAdapterError) as info:
        client.fetch_status(CredentialRef("https://issuer.example", "other", "sha-256:z"))
    assert info.value.code == "scope_not_accredited"
    with pytest.raises(IssuerAdapterError) as missing:
        ExampleIssuerClient(IssuerAdapterConfig(adapter="example"))
    assert missing.value.code == "adapter_invalid"


# ─── the real mock issuer, when it can run here ─────────────────────────────


def _repository_mock_issuer() -> List[str]:
    configured = os.environ.get(CLI_ENV)
    if configured:
        return configured.split()
    cli = ROOT / "packages" / "mock-issuer" / "src" / "cli.ts"
    node = shutil.which("node")
    if node is None or not cli.is_file() or not (ROOT / "packages" / "mock-issuer" / "node_modules").is_dir():
        pytest.skip("the mock issuer is not runnable here (node, packages/mock-issuer/node_modules)")
    return [node, str(cli)]


def test_mock_round_trip_against_the_repository_cli(tmp_path: Path) -> None:
    cli = _repository_mock_issuer()
    state = tmp_path / "mock-issuer"
    state.mkdir()
    # The agent's key: generated by the CLI itself, as a demo would.
    issued = subprocess.run(
        [*cli, "issue-passport", "--generate-agent-key", "--agent-did", AGENT.did, "--dir", str(state)],
        capture_output=True, text=True, check=False, encoding="utf-8",
    )
    if issued.returncode != 0:
        pytest.skip(f"the mock issuer could not issue here: {issued.stderr.strip().splitlines()[:1]}")
    thumbprint = json.loads(issued.stdout)["key_thumbprint"]
    client = MockIssuerClient(cli=cli, state_dir=str(state))
    key = ProvedKey(thumbprint=thumbprint, public_jwk={})
    metadata = client.issuer_metadata()
    assert metadata.issuer_id == "https://mock-issuer.example" and metadata.jwks is not None
    attested = client.request_attestation(AGENT, key)
    assert _header(attested.jws)["typ"] == "grantex-attestation+jwt"
    assert attested.key_thumbprint == thumbprint and attested.passport is not None
    assert attested.credential_ref.external_credential_id.startswith("ppt_")
    assert attested.credential_ref.issuer_attestation_id is not None and attested.credential_ref.issuer_attestation_id.startswith("att_")
    assert client.fetch_status(attested.credential_ref).state == "valid"
    subprocess.run([*cli, "revoke", "--attestation-id", attested.credential_ref.issuer_attestation_id, "--dir", str(state)], check=True)
    assert client.fetch_status(attested.credential_ref).state == "revoked"
    with pytest.raises(IssuerAdapterError) as info:
        client.request_attestation(AGENT, ProvedKey(thumbprint="unknown", public_jwk={}))
    assert info.value.code == "key_unproven"
