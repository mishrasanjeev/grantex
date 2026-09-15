"""``grantex evidence verify|export`` (PRD G-5 CLI, end-to-end step 8)."""

from __future__ import annotations

import io
import json
from pathlib import Path
from typing import List, Tuple

import httpx
import pytest
import respx

from grantex.cli import main
from grantex.cli.evidence import EXIT_FAILED, EXIT_OK, EXIT_USAGE, run
from grantex.evidence._client import EvidenceApiError, export_package, record_evidence

EXAMPLES = Path(__file__).resolve().parents[3] / "spec" / "examples" / "evidence"
EXPECTED = json.loads((EXAMPLES / "expected.json").read_text(encoding="utf-8"))
ROOT = EXPECTED["package.json"]["root"]
ANCHOR = EXPECTED["package.json"]["anchor_hash"]
BASE = "https://auth.example.com"


def _run(*argv: str) -> Tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    code = run(list(argv), out, err)
    return code, out.getvalue(), err.getvalue()


def test_verify_exits_zero_for_a_valid_package() -> None:
    code, out, err = _run("evidence", "verify", str(EXAMPLES / "package.json"), "--root", ROOT, "--anchor", ANCHOR)
    assert code == EXIT_OK, err
    assert out.startswith("verified: 15 entries") and "anchor" in out


def test_e2e_step8_verify_then_corrupt_one_byte_fails_with_the_link(tmp_path: Path) -> None:
    data = bytearray((EXAMPLES / "package.json").read_bytes())
    assert _run("evidence", "verify", str(EXAMPLES / "package.json"), "--root", ROOT)[0] == EXIT_OK
    data[data.index(b"61250") + 1] = ord("2")
    corrupted = tmp_path / "corrupted.json"
    corrupted.write_bytes(bytes(data))
    code, out, err = _run("evidence", "verify", str(corrupted), "--root", ROOT)
    assert code == EXIT_FAILED
    assert out == ""
    assert err.splitlines()[0] == "FAILED entry_hash_mismatch: entry 10 content does not match its hash"
    assert "  entry:    10" in err and "  field:    entries[10].hash" in err
    assert "  expected: sha256:" in err and "  actual:   sha256:" in err


def test_verify_json_output_matches_the_library_result(tmp_path: Path) -> None:
    code, out, _ = _run("evidence", "verify", str(EXAMPLES / "package.json"), "--root", "sha256:" + "0" * 64, "--json")
    assert code == EXIT_FAILED
    body = json.loads(out)
    assert body["code"] == "root_not_trusted" and body["field_path"] == "chain.root" and body["ok"] is False


def test_verify_requires_a_root() -> None:
    code, _, _ = _run("evidence", "verify", str(EXAMPLES / "package.json"))
    assert code == EXIT_USAGE
    code, _, err = _run("evidence", "verify", str(EXAMPLES / "package.json"), "--root", "not-a-root")
    assert code == EXIT_FAILED and err.startswith("FAILED missing_root")


def test_verify_signed_package_needs_keys_or_explicit_skip() -> None:
    signed = str(EXAMPLES / "package-signed.json")
    code, _, err = _run("evidence", "verify", signed, "--root", ROOT)
    assert code == EXIT_FAILED and "signature_unverified" in err
    code, out, _ = _run("evidence", "verify", signed, "--root", ROOT, "--jwks", str(EXAMPLES / "jwks.json"), "--require-signature")
    assert code == EXIT_OK and "signature" in out
    assert _run("evidence", "verify", signed, "--root", ROOT, "--skip-signature")[0] == EXIT_OK
    assert _run("evidence", "verify", signed, "--root", ROOT, "--skip-signature", "--jwks", str(EXAMPLES / "jwks.json"))[0] == EXIT_USAGE


def test_verify_input_errors_exit_2(tmp_path: Path) -> None:
    assert _run("evidence", "verify", str(tmp_path / "missing.json"), "--root", ROOT)[0] == EXIT_USAGE
    bad = tmp_path / "jwks.json"
    bad.write_text("[]", encoding="utf-8")
    assert _run("evidence", "verify", str(EXAMPLES / "package-signed.json"), "--root", ROOT, "--jwks", str(bad))[0] == EXIT_USAGE


def test_verify_reads_standard_input(monkeypatch: pytest.MonkeyPatch) -> None:
    data = (EXAMPLES / "package.json").read_bytes()
    monkeypatch.setattr("sys.stdin", io.TextIOWrapper(io.BytesIO(data)))
    assert _run("evidence", "verify", "-", "--root", ROOT)[0] == EXIT_OK


def test_main_is_the_console_entry_point(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["evidence", "verify", str(EXAMPLES / "package.json"), "--root", ROOT]) == EXIT_OK
    assert "verified" in capsys.readouterr().out


@respx.mock
def test_export_writes_a_verified_package(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GRANTEX_URL", BASE)
    monkeypatch.setenv("GRANTEX_KEY", "placeholder-api-key")
    route = respx.post(f"{BASE}/v1/evidence/cases/case_demo_0001/export").mock(
        return_value=httpx.Response(
            200,
            content=(EXAMPLES / "package.json").read_bytes(),
            headers={"Grantex-Evidence-Root": ROOT, "Grantex-Evidence-Anchor": ANCHOR, "Content-Type": "application/json"},
        )
    )
    target = tmp_path / "out.json"
    code, out, err = _run("evidence", "export", "case_demo_0001", "--out", str(target), "--disclose", "approver")
    assert code == EXIT_OK, err
    assert target.read_bytes() == (EXAMPLES / "package.json").read_bytes()
    assert f"--root {ROOT}" in out
    request = route.calls.last.request
    assert request.headers["Authorization"] == "Bearer placeholder-api-key"
    assert json.loads(request.content) == {"disclose": ["approver"], "sign": False}


@respx.mock
def test_export_refuses_to_save_a_package_that_does_not_match_its_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GRANTEX_URL", BASE)
    monkeypatch.setenv("GRANTEX_KEY", "placeholder-api-key")
    data = bytearray((EXAMPLES / "package.json").read_bytes())
    data[data.index(b"61250") + 1] = ord("2")
    respx.post(f"{BASE}/v1/evidence/cases/case_demo_0001/export").mock(
        return_value=httpx.Response(200, content=bytes(data), headers={"Grantex-Evidence-Root": ROOT, "Grantex-Evidence-Anchor": ANCHOR})
    )
    target = tmp_path / "out.json"
    code, _, err = _run("evidence", "export", "case_demo_0001", "--out", str(target))
    assert code == EXIT_FAILED and "entry_hash_mismatch" in err
    assert not target.exists()


@respx.mock
def test_export_reports_service_errors(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("GRANTEX_URL", BASE)
    monkeypatch.setenv("GRANTEX_KEY", "placeholder-api-key")
    monkeypatch.chdir(tmp_path)
    respx.post(f"{BASE}/v1/evidence/cases/case_demo_0001/export").mock(
        return_value=httpx.Response(403, json={"code": "FEATURE_DISABLED", "message": "evidence export is not enabled"})
    )
    code, _, err = _run("evidence", "export", "case_demo_0001")
    assert code == EXIT_FAILED and "403 FEATURE_DISABLED" in err
    respx.post(f"{BASE}/v1/evidence/cases/case_demo_0001/export").mock(return_value=httpx.Response(200, content=b"{}"))
    code, _, err = _run("evidence", "export", "case_demo_0001")
    assert code == EXIT_FAILED and "EVIDENCE_ROOT_HEADER_INVALID" in err


def test_export_needs_configuration_and_a_safe_default_file_name(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GRANTEX_URL", raising=False)
    monkeypatch.delenv("GRANTEX_KEY", raising=False)
    assert _run("evidence", "export", "case_demo_0001")[0] == EXIT_USAGE


@respx.mock
def test_export_does_not_derive_a_path_from_an_unsafe_case_id(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GRANTEX_URL", BASE)
    monkeypatch.setenv("GRANTEX_KEY", "placeholder-api-key")
    route = respx.post(url__regex=rf"{BASE}/v1/evidence/cases/.*/export").mock(
        return_value=httpx.Response(200, content=(EXAMPLES / "package.json").read_bytes(), headers={"Grantex-Evidence-Root": ROOT, "Grantex-Evidence-Anchor": ANCHOR})
    )
    code, _, err = _run("evidence", "export", "../case_demo_0001")
    assert code == EXIT_USAGE and "pass --out" in err
    assert str(route.calls.last.request.url).endswith("/cases/..%2Fcase_demo_0001/export")


@respx.mock
def test_record_evidence_sends_batches_of_100_in_order() -> None:
    seen: List[int] = []

    def reply(request: httpx.Request) -> httpx.Response:
        records = json.loads(request.content)["records"]
        seen.append(len(records))
        return httpx.Response(201, json={"case_id": "case_demo_0001", "records": [{"audit_entry_id": r["data"]["call_id"], "hash": "0" * 64} for r in records]})

    respx.post(f"{BASE}/v1/evidence/cases/case_demo_0001/records").mock(side_effect=reply)
    records = [{"type": "tool_call", "at": "2026-09-14T09:05:03.000Z", "data": {"call_id": f"call_{n:04d}"}} for n in range(150)]
    result = record_evidence("case_demo_0001", records, base_url=BASE, api_key="placeholder-api-key")
    assert seen == [100, 50]
    assert [r["audit_entry_id"] for r in result] == [f"call_{n:04d}" for n in range(150)]


@respx.mock
def test_record_evidence_raises_with_the_field_path() -> None:
    respx.post(f"{BASE}/v1/evidence/cases/case_demo_0001/records").mock(
        return_value=httpx.Response(400, json={"code": "EVIDENCE_RECORD_INVALID", "message": "unknown member", "field_path": "records[0].data.notes"})
    )
    with pytest.raises(EvidenceApiError) as info:
        record_evidence("case_demo_0001", [{"type": "tool_call"}], base_url=BASE, api_key="placeholder-api-key")
    assert (info.value.status, info.value.code, info.value.field_path) == (400, "EVIDENCE_RECORD_INVALID", "records[0].data.notes")
    with pytest.raises(ValueError):
        record_evidence("case_demo_0001", [], base_url=BASE, api_key="placeholder-api-key")
    with pytest.raises(ValueError):
        export_package("", base_url=BASE, api_key="placeholder-api-key")
