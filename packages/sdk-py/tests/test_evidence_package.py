"""Evidence package and verifier (PRD G-5, test matrix rows "evidence hash chain"
and "canonicalisation stability", end-to-end step 8).

Tests are named after the acceptance criteria. Fixtures in
spec/examples/evidence/ are shared with the TypeScript SDK, which must report
exactly the same failures.
"""

from __future__ import annotations

import base64
import copy
import hashlib
import json
import random
import re
import time
from pathlib import Path
from typing import Any, Dict, Iterator, List, Tuple

import pytest
from cryptography.hazmat.primitives.asymmetric import ec, rsa

from grantex.evidence import (
    IDENTIFIER_CLASSES,
    action_reference,
    case_key,
    keyed_content_digest,
    EvidenceBuildError,
    PrivacySettings,
    VerificationCode,
    attach_signature,
    audit_entry_hash,
    build_package,
    canonicalize,
    decision_action_hash,
    is_pseudonym,
    pseudonymise,
    serialize_package,
    sign_root,
    upstream_records_for,
    verify_package,
)
from grantex.evidence._schema import SCHEMA_KEYWORDS

from . import evidence_fixtures as fx

FIXTURES = fx.FIXTURES
SPEC_SCHEMA = FIXTURES.parent.parent / "evidence-package-1.0.schema.json"
EMBEDDED_SCHEMA = Path(__file__).resolve().parents[1] / "src" / "grantex" / "evidence" / "schema-1.0.json"


def _read(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def _expected() -> Dict[str, Any]:
    return json.loads(_read("expected.json"))


def _files() -> Dict[str, bytes]:
    return {path.name: path.read_bytes() for path in FIXTURES.glob("*.json")}


# ── Fixtures and schema ──────────────────────────────────────────────────────


def test_fixtures_are_current() -> None:
    committed = _files()
    rendered = fx.render()
    assert sorted(rendered) == sorted(committed)
    for name, data in rendered.items():
        assert committed[name] == data, f"{name} is stale: run python -m tests.evidence_fixtures"


def test_embedded_schema_is_the_published_schema() -> None:
    # Line endings may differ between checkouts; the content may not.
    assert EMBEDDED_SCHEMA.read_bytes().replace(b"\r\n", b"\n") == SPEC_SCHEMA.read_bytes().replace(b"\r\n", b"\n")


def test_published_schema_uses_only_interpreted_keywords() -> None:
    def walk(node: Any, key: str = "") -> Iterator[str]:
        if isinstance(node, dict):
            for name, child in node.items():
                if key not in ("properties", "$defs"):
                    yield name
                yield from walk(child, name)
        elif isinstance(node, list) and key == "allOf":
            for child in node:
                yield from walk(child)

    schema = json.loads(SPEC_SCHEMA.read_text(encoding="utf-8"))
    assert set(walk(schema)) - SCHEMA_KEYWORDS == set()


# ── Canonicalisation stability ───────────────────────────────────────────────

RFC8785_EXAMPLES: List[Tuple[str, str]] = [
    # RFC 8785 section 3.2.2 (sorting and whitespace) and appendix B number samples.
    (
        '{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],'
        ' "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",'
        ' "literals": [null, true, false]}',
        '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],'
        '"string":"\u20ac$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    ),
    ('{"\\u20ac": "Euro Sign", "\\r": "Carriage Return", "\\ufb33": "Hebrew Letter Dalet With Dagesh",'
     ' "1": "One", "\\ud83d\\ude00": "Emoji: Grinning Face", "\\u0080": "Control", "\\u00f6": "Latin Small Letter O With Diaeresis"}',
     '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis",'
     '"\u20ac":"Euro Sign","\U0001f600":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}'),
    ("[0, -0, 1e21, 1e-7, 123e-20, 9007199254740991, 295147905179352830000]",
     "[0,0,1e+21,1e-7,1.23e-18,9007199254740991,295147905179352830000]"),
]


@pytest.mark.parametrize("source,canonical", RFC8785_EXAMPLES)
def test_canonicalisation_matches_rfc8785_examples(source: str, canonical: str) -> None:
    assert canonicalize(json.loads(source)) == canonical


def test_canonicalisation_is_stable_under_reordering_and_whitespace() -> None:
    rng = random.Random(8785)
    document = json.loads(_read("evidence-package.json"))
    reference = canonicalize(document)
    for _ in range(50):
        def shuffle(node: Any) -> Any:
            if isinstance(node, dict):
                items = list(node.items())
                rng.shuffle(items)
                return {k: shuffle(v) for k, v in items}
            if isinstance(node, list):
                return [shuffle(v) for v in node]
            return node

        text = json.dumps(shuffle(document), indent=rng.choice([None, 1, 4]), ensure_ascii=rng.random() < 0.5)
        assert canonicalize(json.loads(text)) == reference


def test_canonicalisation_agrees_with_grantex_canonical_when_available() -> None:
    canonical = pytest.importorskip("grantex.canonical")
    for name in ("evidence-package.json", "case-input.json", "invalid-cases.json"):
        value = json.loads(_read(name))
        assert canonical.canonicalize(value) == canonicalize(value)


# ── Build ────────────────────────────────────────────────────────────────────


def test_build_produces_the_shared_fixture_bytes() -> None:
    documents = fx.packages()
    assert serialize_package(documents["evidence-package.json"]) == _read("evidence-package.json")
    assert serialize_package(documents["evidence-package-disclosed.json"]) == _read("evidence-package-disclosed.json")


def test_identifiers_are_pseudonymised_by_default() -> None:
    document = json.loads(_read("evidence-package.json"))
    raw = _read("evidence-package.json").decode("utf-8")
    for secret in ("user:approver-a", "user:approver-b", "user:underwriting-team", "gb:00000001", "mock:registry:00000001"):
        assert secret not in raw
    assert is_pseudonym(document["case"]["subject"])
    decision = document["entries"][fx.I_DEC1]["data"]
    assert is_pseudonym(decision["approver"]) and is_pseudonym(decision["action"]["subject"])
    assert "action_hash" not in decision and decision["action_ref"].startswith("ak:")
    assert document["entries"][fx.I_CALL1]["data"]["input_hash"].startswith("hmac-sha256:")
    assert document["privacy"] == {"disclosed": [], "key_id": "example-key-1", "scheme": "hmac-sha256-v1"}


def test_the_subject_cannot_be_confirmed_by_guessing() -> None:
    """An unkeyed action_hash or content digest would let anyone test a guessed subject."""
    raw = _read("evidence-package.json").decode("utf-8")
    source = fx.case_input()
    for entry in source["entries"]:
        data = entry["data"]
        for name in ("action_hash", "input_hash", "output_hash"):
            if isinstance(data.get(name), str):
                assert data[name] not in raw, name
    for guess in ("gb:00000001", "gb:00000002"):
        action = {"action": "case_decision", "case_id": fx.CASE_ID, "decision": "decline", "subject": guess}
        assert decision_action_hash(action) not in raw


def test_packages_of_two_cases_share_no_keyed_values() -> None:
    first = fx.case_input()
    second = copy.deepcopy(first)
    second["case"]["case_id"] = "case_demo_0002"
    for entry in second["entries"]:
        if entry["type"] == "decision":
            entry["data"]["action"]["case_id"] = "case_demo_0002"
            entry["data"]["action_hash"] = decision_action_hash(entry["data"]["action"])
        if entry["type"] == "decision_consumption":
            entry["data"]["action_hash"] = second["entries"][fx.I_DEC1]["data"]["action_hash"]
    settings = fx.privacy_settings(first["privacy"])
    a = build_package(case=first["case"], entries=first["entries"], privacy=settings).data.decode("utf-8")
    b = build_package(case=second["case"], entries=second["entries"], privacy=settings).data.decode("utf-8")
    keyed = re.compile(r"(?:pz:|ak:)[A-Za-z0-9_-]{43}|hmac-sha256:[0-9a-f]{64}")
    assert set(keyed.findall(a)) and not set(keyed.findall(a)) & set(keyed.findall(b))


def test_opt_out_discloses_only_the_configured_classes() -> None:
    source = fx.case_input()
    built = build_package(
        case=source["case"],
        entries=source["entries"],
        privacy=PrivacySettings(key=fx.example_key(), key_id="k1", disclosed=frozenset({"approver"})),
    )
    decision = built.document["entries"][fx.I_DEC1]["data"]
    assert decision["approver"] == "user:approver-a"
    assert is_pseudonym(decision["action"]["subject"])
    assert is_pseudonym(built.document["entries"][0]["data"]["principal"])
    assert verify_package(built.data, expected_root=built.root).ok


def test_pseudonyms_are_stable_per_case_and_match_vectors() -> None:
    vectors = json.loads(_read("pseudonyms.json"))
    key = hashlib.sha256(vectors["key_seed"].encode("utf-8")).digest()
    seen = set()
    for item in vectors["identifiers"]:
        token = pseudonymise(key, item["tenant_id"], item["case_id"], item["class"], item["value"])
        assert token == item["pseudonym"] and is_pseudonym(token)
        assert token not in seen
        seen.add(token)
    content = vectors["content"]
    assert keyed_content_digest(case_key(key, content["tenant_id"], content["case_id"]), content["digest"]) == content["keyed"]
    action = vectors["action"]
    assert action_reference(case_key(key, action["tenant_id"], action["case_id"]), action["action_hash"]) == action["action_ref"]


def test_build_refuses_pseudonymisation_without_a_key() -> None:
    source = fx.case_input()
    with pytest.raises(EvidenceBuildError) as info:
        build_package(case=source["case"], entries=source["entries"], privacy=PrivacySettings())
    assert info.value.code == "privacy_violation"


def test_build_refuses_invalid_records_with_the_verifier_rules() -> None:
    source = fx.case_input()
    entries = copy.deepcopy(source["entries"])
    entries[3]["data"]["notes"] = "free text is not part of the format"
    with pytest.raises(EvidenceBuildError) as info:
        build_package(case=source["case"], entries=entries, privacy=PrivacySettings(disclosed=frozenset(IDENTIFIER_CLASSES)))
    assert (info.value.code, info.value.field_path) == ("schema_violation", "entries[3].data.notes")

    entries = copy.deepcopy(source["entries"])
    entries[fx.I_REC]["data"]["sections"][0]["evidence"][0]["record_id"] = "mock:registry:unknown"
    with pytest.raises(EvidenceBuildError) as info:
        build_package(case=source["case"], entries=entries, privacy=PrivacySettings(disclosed=frozenset(IDENTIFIER_CLASSES)))
    assert info.value.code == "dangling_reference"


# ── Verification ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize("name", ["evidence-package.json", "evidence-package-disclosed.json"])
def test_fixture_packages_verify(name: str) -> None:
    expected = _expected()[name]
    result = verify_package(_read(name), expected_root=expected["root"])
    assert result.ok, result
    assert result.entry_count == expected["entry_count"]
    assert result.root == expected["root"]


def test_anchor_is_checked_and_can_be_pinned() -> None:
    expected = _expected()["evidence-package.json"]
    result = verify_package(
        _read("evidence-package.json"),
        expected_root=expected["root"],
        expected_anchor_hash=expected["anchor_hash"],
        require_anchor=True,
    )
    assert result.ok and result.anchor_status == "pinned"
    unpinned = verify_package(_read("evidence-package.json"), expected_root=expected["root"])
    assert unpinned.anchor_status == "internal-consistency-only"
    assert (unpinned.unsourced_inputs, unpinned.late_entries, unpinned.tenant_asserted_entries) == (1, 1, 12)


def test_signed_package_verifies_with_the_key_set() -> None:
    expected = _expected()["evidence-package-signed.json"]
    jwks = json.loads(_read("jwks.json"))
    result = verify_package(_read("evidence-package-signed.json"), expected_root=expected["root"], jwks=jwks, require_signature=True)
    assert result.ok and (result.signature_status, result.anchor_status) == ("verified", "signed")
    assert result.signature_kid == "evidence-example-es256"
    skipped = verify_package(_read("evidence-package-signed.json"), expected_root=expected["root"], allow_unverified_signature=True)
    assert skipped.ok and (skipped.signature_status, skipped.anchor_status) == ("unchecked", "internal-consistency-only")


def test_trailing_line_feed_is_accepted_once() -> None:
    root = _expected()["evidence-package.json"]["root"]
    assert verify_package(_read("evidence-package.json") + b"\n", expected_root=root).ok
    assert verify_package(_read("evidence-package.json") + b"\n\n", expected_root=root).code == "non_canonical_document"


def _invalid_cases() -> List[Dict[str, Any]]:
    return json.loads(_read("invalid-cases.json"))["cases"]


@pytest.mark.parametrize("case", _invalid_cases(), ids=lambda c: c["name"])
def test_verification_reports_the_exact_failing_link(case: Dict[str, Any]) -> None:
    files = _files()
    data = fx.apply_case(case, files)
    result = verify_package(data, **fx.verify_options(case, _expected(), files))
    assert not result.ok
    got = {k: getattr(result, k) for k in ("code", "entry_index", "field_path", "expected", "actual")}
    assert got == case["expect"]


def test_every_failure_code_is_exercised_by_shared_cases() -> None:
    codes = {c["expect"]["code"] for c in _invalid_cases()}
    declared = {v for k, v in vars(VerificationCode).items() if k.isupper()}
    assert declared - codes == set()


def _leaves(node: Any, path: Tuple[Any, ...] = ()) -> Iterator[Tuple[Tuple[Any, ...], Any]]:
    if isinstance(node, dict):
        for key, value in node.items():
            yield from _leaves(value, path + (key,))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from _leaves(value, path + (index,))
    else:
        yield path, node


def _changed(value: Any) -> Any:
    if isinstance(value, bool):
        return not value
    if isinstance(value, int):
        return value + 1
    if isinstance(value, float):
        return value + 0.5
    if isinstance(value, str):
        return value[:-1] + ("0" if value[-1:] != "0" else "1") if value else "x"
    return "x"


def _set(document: Any, path: Tuple[Any, ...], value: Any) -> None:
    node = document
    for key in path[:-1]:
        node = node[key]
    node[path[-1]] = value


def test_tampering_with_any_field_fails_verification() -> None:
    """Change every leaf and delete every member, with and without rehashing."""
    for name in ("evidence-package.json", "evidence-package-signed.json"):
        data = _read(name)
        root = _expected()[name]["root"]
        jwks = json.loads(_read("jwks.json"))
        document = json.loads(data)
        leaves = list(_leaves(document))
        assert len(leaves) > 150
        for path, value in leaves:
            mutated = copy.deepcopy(document)
            _set(mutated, path, _changed(value))
            result = verify_package(serialize_package(mutated), expected_root=root, jwks=jwks)
            assert not result.ok, (name, path)
            if path[0] == "entries" and path[-1] not in ("hash", "prev", "seq"):
                # A rehashed forgery still fails: its root is not the trusted root.
                fx.rehash_chain(mutated)
                rehashed = verify_package(serialize_package(mutated), expected_root=root, jwks=jwks)
                assert not rehashed.ok, (name, path, "rehashed")

        def members(node: Any, path: Tuple[Any, ...] = ()) -> Iterator[Tuple[Any, ...]]:
            if isinstance(node, dict):
                for key, value in node.items():
                    yield path + (key,)
                    yield from members(value, path + (key,))
            elif isinstance(node, list):
                for index, value in enumerate(node):
                    yield from members(value, path + (index,))

        for path in members(document):
            mutated = copy.deepcopy(document)
            parent = mutated
            for key in path[:-1]:
                parent = parent[key]
            del parent[path[-1]]
            # anchor and signature are detachable; a verifier that relies on them requires them.
            result = verify_package(
                serialize_package(mutated),
                expected_root=root,
                jwks=jwks,
                require_anchor=True,
                require_signature=name == "evidence-package-signed.json",
            )
            assert not result.ok, (name, path, "deleted")


def _small_package() -> Tuple[bytes, str]:
    source = fx.case_input()
    entries = [source["entries"][i] for i in (0, 1, 2, 3, 4, fx.I_REVOKE)]
    built = build_package(case=source["case"], entries=entries, privacy=fx.privacy_settings(source["privacy"]))
    return built.data, built.root


def test_changing_any_byte_of_a_package_fails_verification() -> None:
    """Flip each of two bits at every byte position of a sample package."""
    data, root = _small_package()
    assert verify_package(data, expected_root=root).ok
    for position in range(len(data)):
        for mask in (0x01, 0x20):
            mutated = bytearray(data)
            mutated[position] ^= mask
            result = verify_package(bytes(mutated), expected_root=root)
            assert not result.ok, (position, mask, chr(data[position]))


def test_e2e_step8_export_verify_corrupt_one_byte_fails() -> None:
    """PRD 8.4 step 8: a verified package fails after corrupting one byte."""
    data = _read("evidence-package.json")
    root = _expected()["evidence-package.json"]["root"]
    assert verify_package(data, expected_root=root).ok
    rng = random.Random(8)
    for _ in range(25):
        position = rng.randrange(len(data))
        mutated = bytearray(data)
        mutated[position] = (mutated[position] + rng.randrange(1, 256)) % 256
        assert not verify_package(bytes(mutated), expected_root=root).ok


def test_verification_refuses_a_malformed_trusted_root() -> None:
    data = _read("evidence-package.json")
    root = _expected()["evidence-package.json"]["root"]
    for bad in ("", root.upper(), root[7:], root + "0"):
        assert verify_package(data, expected_root=bad).code == "missing_root"


# ── Auditor, anchors and signatures ──────────────────────────────────────────


def test_auditor_identifies_every_upstream_record_behind_a_recommendation_from_the_package_alone() -> None:
    document = json.loads(_read("evidence-package-disclosed.json"))
    assert verify_package(_read("evidence-package-disclosed.json"), expected_root=_expected()["evidence-package-disclosed.json"]["root"]).ok
    records = upstream_records_for(document, "rec_0001")
    assert [(r["call_id"], r["tool"], r["provider"], r["record_id"]) for r in records] == [
        ("call_0001", "resolve_business", "mock", "mock:registry:00000001"),
        ("call_0002", "verify_business", "mock", "mock:verification:v-0001"),
        ("call_0002", "verify_business", "mock", "mock:officers:00000001"),
        ("call_0003", "ownership", "mock", "mock:ownership:g-0001"),
        ("call_0004", "screen_person", "mock", "mock:screening:hit-0001"),
    ]
    assert all(r["grant_id"] == "grnt_demo_leaf" and r["cited_by"] for r in records)
    ownership = records[3]
    assert ownership["cited_by"] == [
        f"entries[{fx.I_REC}].data.sections[2].evidence[0]",
        f"entries[{fx.I_EVAL}].data.inputs[1].evidence[0]",
    ]
    # In the default (pseudonymised) package the same records appear under stable per-case pseudonyms.
    pseudonymised = upstream_records_for(json.loads(_read("evidence-package.json")), "rec_0001")
    assert [r["record_id"] for r in pseudonymised] == [
        pseudonymise(fx.example_key(), fx.TENANT_ID, fx.CASE_ID, "record", r["record_id"]) for r in records
    ]


def test_anchor_hash_uses_the_auth_service_audit_layout() -> None:
    entry = {
        "id": "alog_TEST01",
        "agentId": "ag_01",
        "agentDid": "did:grantex:ag_01",
        "grantId": "grnt_01",
        "principalId": "user_01",
        "developerId": "dev_TEST",
        "action": "tool.run",
        "metadata": {"zebra": 1, "alpha": {"yankee": True, "bravo": [3, 2]}},
        "timestamp": "2026-08-14T00:00:00.000Z",
        "prevHash": None,
        "status": "success",
    }
    text = (
        '{"id":"alog_TEST01","agentId":"ag_01","agentDid":"did:grantex:ag_01","grantId":"grnt_01",'
        '"principalId":"user_01","developerId":"dev_TEST","action":"tool.run",'
        '"metadata":{"alpha":{"bravo":[3,2],"yankee":true},"zebra":1},'
        '"timestamp":"2026-08-14T00:00:00.000Z","prevHash":null,"status":"success"}'
    )
    assert audit_entry_hash(entry) == hashlib.sha256(text.encode("utf-8")).hexdigest()


def test_decision_action_hash_matches_the_decision_grant_profile() -> None:
    action = {"case_id": "case_8841", "action": "case_decision", "decision": "approve", "subject": "gb:12345678"}
    raw = hashlib.sha256(b'{"action":"case_decision","case_id":"case_8841","decision":"approve","subject":"gb:12345678"}').digest()
    assert decision_action_hash(action) == "sha256:" + base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
    decisions = pytest.importorskip("grantex.decisions")
    assert decisions.compute_action_hash(action) == decision_action_hash(action)


@pytest.mark.parametrize("kind", ["ES256", "RS256"])
def test_detached_signature_round_trip(kind: str) -> None:
    data = _read("evidence-package-disclosed.json")
    root = _expected()["evidence-package-disclosed.json"]["root"]
    document = json.loads(data)
    key: Any = ec.generate_private_key(ec.SECP256R1()) if kind == "ES256" else rsa.generate_private_key(65537, 2048)
    signature = sign_root(root, key, "kid-1")
    assert signature["alg"] == kind
    signed = serialize_package(attach_signature(document, signature))
    public = key.public_key().public_numbers()

    def b64(n: int, size: int) -> str:
        return base64.urlsafe_b64encode(n.to_bytes(size, "big")).rstrip(b"=").decode()

    if kind == "ES256":
        jwk = {"kty": "EC", "crv": "P-256", "kid": "kid-1", "x": b64(public.x, 32), "y": b64(public.y, 32)}
    else:
        jwk = {"kty": "RSA", "kid": "kid-1", "n": b64(public.n, 256), "e": b64(public.e, 3)}
    assert verify_package(signed, expected_root=root, jwks={"keys": [jwk]}).ok
    other = ec.generate_private_key(ec.SECP256R1()) if kind == "ES256" else rsa.generate_private_key(65537, 2048)
    forged = serialize_package(attach_signature(document, sign_root(root, other, "kid-1")))
    assert verify_package(forged, expected_root=root, jwks={"keys": [jwk]}).code == "signature_invalid"
    wrong_alg = dict(jwk, alg="RS256" if kind == "ES256" else "ES256")
    assert verify_package(signed, expected_root=root, jwks={"keys": [wrong_alg]}).code == "signature_invalid"


def test_non_canonical_base64_in_a_signature_is_refused() -> None:
    data = _read("evidence-package-signed.json")
    document = json.loads(data)
    root = _expected()["evidence-package-signed.json"]["root"]
    jwks = json.loads(_read("jwks.json"))
    head, _, sig = document["signature"]["jws"].partition("..")
    last = sig[-1]
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    # 64 bytes encode to 86 characters; the last character carries 4 unused bits.
    sibling = alphabet[(alphabet.index(last) // 4) * 4 + ((alphabet.index(last) % 4) + 1) % 4]
    assert base64.urlsafe_b64decode(sig[:-1] + sibling + "==") == base64.urlsafe_b64decode(sig + "==")
    document["signature"]["jws"] = f"{head}..{sig[:-1]}{sibling}"
    result = verify_package(serialize_package(document), expected_root=root, jwks=jwks)
    assert result.code == "signature_invalid"


def test_verification_of_a_realistic_case_is_fast() -> None:
    source = fx.case_input()
    entries = source["entries"][:3]
    template = source["entries"][4]
    for n in range(400):
        call = copy.deepcopy(template)
        call["data"]["call_id"] = f"call_bulk_{n:04d}"
        entries.append(call)
    built = build_package(case=source["case"], entries=entries, privacy=fx.privacy_settings(source["privacy"]))
    started = time.perf_counter()
    assert verify_package(built.data, expected_root=built.root).ok
    assert time.perf_counter() - started < 5.0


def test_structural_failures_agree_with_a_stock_json_schema_validator() -> None:
    jsonschema = pytest.importorskip("jsonschema")
    validator = jsonschema.Draft202012Validator(json.loads(SPEC_SCHEMA.read_text(encoding="utf-8")))
    files = _files()
    # Calendar validity and the unsourced rule are verifier rules beyond JSON Schema keywords.
    beyond_schema = {"impossible calendar date", "input cites evidence and is marked unsourced"}
    structural = [c for c in _invalid_cases() if c["expect"]["code"] == "schema_violation" and c["name"] not in beyond_schema]
    assert structural
    for case in structural:
        assert list(validator.iter_errors(json.loads(fx.apply_case(case, files)))), case["name"]
    for name in ("evidence-package.json", "evidence-package-disclosed.json", "evidence-package-signed.json"):
        assert list(validator.iter_errors(json.loads(_read(name)))) == [], name


def test_concept_page_python_example_runs(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    """Documentation examples are executed so they cannot rot."""
    page = (FIXTURES.parents[2] / "docs" / "concepts" / "evidence-and-verification.md").read_text(encoding="utf-8")
    block = page.split("```python\n", 1)[1].split("```", 1)[0]
    monkeypatch.chdir(FIXTURES.parents[2])
    exec(compile(block, "evidence-and-verification.md", "exec"), {})  # noqa: S102
    assert "mock verify_business mock:verification:v-0001" in capsys.readouterr().out
