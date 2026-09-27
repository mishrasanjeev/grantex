# SPDX-License-Identifier: Apache-2.0
"""Vendor-name denylist check (scripts/check_denylist.py).

Uses its own salt and invented terms. Two tests read the committed hash list:
one checks its shape, and one audits the tracked files that were reworded when
the check was added. Runs on Python 3.9 or later. Run from the repository root
(also part of ``make test``):

    python -m pytest -q tests/scripts
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_script():
    # scripts/ is not a package; load the file the Makefile and CI run.
    path = REPO_ROOT / "scripts" / "check_denylist.py"
    spec = importlib.util.spec_from_file_location("check_denylist", path)
    assert spec is not None and spec.loader is not None, f"cannot load {path}"
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


dl = _load_script()

TEST_SALT = bytes.fromhex("7e57" * 16)
TEST_TERMS = ["acme verify", "Globex Screening Hub", "initechkyb"]


def _git(repo: Path, *args: str) -> str:
    argv = ["git", "-C", str(repo), *args]
    return subprocess.run(argv, check=True, capture_output=True, text=True).stdout.strip()  # noqa: S603, S607


@pytest.fixture()
def denylist() -> dl.Denylist:
    text, _ = dl.render(TEST_TERMS, TEST_SALT)
    return dl.Denylist(
        salt=TEST_SALT,
        max_tokens=3,
        hashes=frozenset(line for line in text.splitlines() if len(line) == 64),
    )


@pytest.fixture()
def hash_file(tmp_path: Path) -> Path:
    path = tmp_path / "hashes" / "denylist.sha256"
    path.parent.mkdir()
    path.write_text(dl.render(TEST_TERMS, TEST_SALT)[0], encoding="utf-8")
    return path


@pytest.fixture()
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init", "-q", "-b", "main")
    _git(root, "config", "user.email", "ci@example.com")
    _git(root, "config", "user.name", "ci")
    _git(root, "config", "commit.gpgsign", "false")
    # Keep line endings as written on every platform.
    _git(root, "config", "core.autocrlf", "false")
    (root / "existing.py").write_text("legacy = 'AcmeVerify'  # predates the change\nkeep = 1\n")
    _git(root, "add", "-A")
    _git(root, "commit", "-qm", "base")
    _git(root, "checkout", "-q", "-b", "feat/neutral-provider")
    return root


@pytest.fixture()
def clean_repo(tmp_path: Path) -> Path:
    root = tmp_path / "clean"
    root.mkdir()
    _git(root, "init", "-q", "-b", "main")
    _git(root, "config", "user.email", "ci@example.com")
    _git(root, "config", "user.name", "ci")
    _git(root, "config", "commit.gpgsign", "false")
    _git(root, "config", "core.autocrlf", "false")
    (root / "providers").mkdir()
    (root / "providers" / "mock.py").write_text("PROVIDER = 'acme_kyb'\nISSUER = 'mock-issuer.example'\n")
    (root / "README.md").write_text("Nimbus Shopper 2.4 acts for shopper-01 at merchant.example.\n")
    _git(root, "add", "-A")
    _git(root, "commit", "-qm", "base")
    return root


def _commit(repo: Path, files: dict[str, str], message: str = "change") -> None:
    for name, body in files.items():
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", message)


def _scan(repo: Path, hash_file: Path, capsys: pytest.CaptureFixture[str], *extra: str) -> tuple[int, str, str]:
    argv = ["--repo", str(repo), "--hash-file", str(hash_file), "scan", "--base", "main", "--head", "HEAD", *extra]
    code = dl.main(argv)
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def _audit(repo: Path, hash_file: Path, capsys: pytest.CaptureFixture[str], *paths: str) -> tuple[int, str, str]:
    code = dl.main(["--repo", str(repo), "--hash-file", str(hash_file), "audit", *paths])
    captured = capsys.readouterr()
    return code, captured.out, captured.err


# ── Matching ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "text",
    [
        "acme verify",
        "AcmeVerify",
        "acme_verify",
        "ACME-VERIFY",
        "use the acmeverify client",
        "class AcmeVerifyProvider:",
        "Ácme Vérify",
        "globex screening hub",
        "GlobexScreeningHub",
        "initech-kyb",
        "INITECH_KYB_TOKEN",
    ],
)
def test_spelling_variants_of_a_term_match(denylist: dl.Denylist, text: str) -> None:
    assert denylist.matches(text)


@pytest.mark.parametrize(
    "text",
    [
        "acme",
        "verify the acme_kyb example",
        "globex screening",
        "provider = mock",
        'integrity "sha512-Q2x0AcmeVerify9z8y7x6w5v4u3t2s1r0qAbCdEfGhIjKlMnOp=="',
    ],
)
def test_unrelated_text_and_encoded_data_do_not_match(denylist: dl.Denylist, text: str) -> None:
    assert denylist.matches(text) == []


def test_match_reports_token_position(denylist: dl.Denylist) -> None:
    assert denylist.matches("configure the Acme Verify adapter") == [2]


def _single(term: str) -> dl.Denylist:
    """A denylist built exactly as ``build`` would, from one invented term."""
    return dl.load_text(dl.render([term], TEST_SALT)[0])


@pytest.mark.parametrize("text", ["myacmeverify", "use_theacmeverify", "INITECHKYB-free", "legacyinitechkyb"])
def test_term_glued_to_the_end_of_a_word_matches(denylist: dl.Denylist, text: str) -> None:
    assert denylist.matches(text)


def test_word_tails_are_not_joined_to_the_following_words() -> None:
    walls = _single("stone wall")
    assert walls.matches("gemstonewall")
    assert walls.matches("stone wall")
    assert walls.matches("gemstone wall") == [], "a tail joined across a word boundary would be a chance match"


def test_window_has_headroom_for_terms_split_into_more_tokens() -> None:
    one_token = _single("initechkyb")
    assert one_token.max_tokens == 1
    assert one_token.matches("Ini-Tech-Kyb")  # three tokens: the longest term plus the headroom
    assert one_token.matches("I-ni-Tech-Kyb") == []  # four tokens: beyond the headroom


def test_long_identifiers_with_digits_are_still_checked(denylist: dl.Denylist) -> None:
    identifier = "AcmeVerify2024ClientConfigurationSettingsHandler"
    assert len(identifier) >= 40
    assert not dl.looks_encoded(identifier)
    assert denylist.matches(f"client = {identifier}()")
    assert denylist.matches("acmeverify20240915clientconfigurationsettings")


@pytest.mark.parametrize(
    ("run", "encoded"),
    [
        ("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", True),
        ("Q2x0AcmeVerify9z8y7x6w5v4u3t2s1r0qAbCdEfGhIjKlMnOp==", True),
        ("AcmeVerify2024ClientConfigurationSettingsHandler", False),
        ("abcdefabcdefabcdefabcdefabcdefabcdef", False),
        ("configurationsettingsforthedevelopmentstackv2", False),
    ],
)
def test_encoded_data_detection(run: str, encoded: bool) -> None:
    assert dl.looks_encoded(run) is encoded


# ── Scanning a change ───────────────────────────────────────────────────────


def test_clean_change_passes(repo: Path, hash_file: Path, capsys: pytest.CaptureFixture[str]) -> None:
    _commit(repo, {"providers/mock.py": "PROVIDER = 'acme_kyb'\n"}, "feat: add the mock provider")
    code, out, _ = _scan(repo, hash_file, capsys)
    assert code == 0
    assert "no denylisted terms" in out


def test_added_line_is_reported_by_location_without_echoing_the_term(
    repo: Path, hash_file: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _commit(repo, {"providers/client.py": "x = 1\nbase_url = 'https://acmeverify.example.com'\n"})
    code, out, _ = _scan(repo, hash_file, capsys)
    assert code == 1
    assert "providers/client.py:2" in out
    assert "verify" not in out.lower()


def test_file_path_is_checked(repo: Path, hash_file: Path, capsys: pytest.CaptureFixture[str]) -> None:
    _commit(repo, {"providers/globex_screening_hub/__init__.py": ""})
    code, out, _ = _scan(repo, hash_file, capsys)
    assert code == 1
    assert "file path providers/" in out


def test_commit_message_is_checked(repo: Path, hash_file: Path, capsys: pytest.CaptureFixture[str]) -> None:
    _commit(repo, {"providers/mock.py": "ok = True\n"}, "feat: port the InitechKyb adapter")
    code, out, _ = _scan(repo, hash_file, capsys)
    assert code == 1
    assert "message line 1" in out


def test_branch_name_is_checked(repo: Path, hash_file: Path, capsys: pytest.CaptureFixture[str]) -> None:
    _git(repo, "checkout", "-q", "-b", "feat/acme-verify-adapter")
    _commit(repo, {"providers/mock.py": "ok = True\n"})
    code, out, _ = _scan(repo, hash_file, capsys)
    assert code == 1
    assert "branch name" in out


def test_explicit_branch_name_overrides_checkout(
    repo: Path, hash_file: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _commit(repo, {"providers/mock.py": "ok = True\n"})
    code, out, _ = _scan(repo, hash_file, capsys, "--branch", "feat/globex-screening-hub")
    assert code == 1
    assert "branch name" in out


def test_added_lines_that_look_like_diff_headers_are_checked(
    repo: Path, hash_file: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    (repo / "notes.md").write_text("intro\n-- old heading\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "notes")
    base = _git(repo, "rev-parse", "HEAD")
    # In the unified diff these become "--- old heading" and "+++ acme verify":
    # a removed and an added line, not a file header.
    (repo / "notes.md").write_text("intro\n++ acme verify\n")
    _git(repo, "commit", "-qam", "change")
    code = dl.main(["--repo", str(repo), "--hash-file", str(hash_file), "scan", "--base", base, "--head", "HEAD"])
    out = capsys.readouterr().out
    assert code == 1
    assert "notes.md:2" in out


def test_non_utf8_text_file_fails_closed(
    repo: Path, hash_file: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _commit(repo, {"providers/mock.py": "ok = True\n"})
    pr_text = tmp_path / "pull-request.txt"
    pr_text.write_bytes(b"Title\n\xff\xfe not utf-8\n")
    code, _, err = _scan(repo, hash_file, capsys, "--text-file", str(pr_text))
    assert code == 2
    assert "cannot read" in err


def test_extra_text_file_is_checked(
    repo: Path, hash_file: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _commit(repo, {"providers/mock.py": "ok = True\n"})
    pr_text = tmp_path / "pull-request.txt"
    pr_text.write_text("Adds a provider\n\nModelled on the Acme Verify API.\n", encoding="utf-8")
    code, out, _ = _scan(repo, hash_file, capsys, "--text-file", str(pr_text))
    assert code == 1
    assert "pull-request.txt line 3" in out


def test_removed_and_untouched_lines_are_not_reported(
    repo: Path, hash_file: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    (repo / "existing.py").write_text("keep = 1\n")
    _git(repo, "commit", "-qam", "refactor: drop the legacy name")
    code, _, _ = _scan(repo, hash_file, capsys)
    assert code == 0


# ── Auditing the tracked files ──────────────────────────────────────────────


def test_audit_of_a_clean_tree_passes(clean_repo: Path, hash_file: Path, capsys: pytest.CaptureFixture[str]) -> None:
    code, out, err = _audit(clean_repo, hash_file, capsys)
    assert code == 0
    assert "no denylisted terms" in out
    assert err == ""


def test_audit_reports_a_planted_term_by_location_only(
    clean_repo: Path, hash_file: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _commit(clean_repo, {"docs/setup.md": "# Setup\n\nConnect the Globex Screening Hub sandbox.\n"})
    code, out, _ = _audit(clean_repo, hash_file, capsys)
    assert code == 1
    assert "docs/setup.md:3 (word 3)" in out
    for word in ("globex", "screening", "hub"):
        assert word not in out.lower()


def test_audit_reports_mentions_that_predate_the_check(
    repo: Path, hash_file: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    code, out, _ = _audit(repo, hash_file, capsys)
    assert code == 1
    assert "existing.py:1" in out
    assert "verify" not in out.lower()


def test_audit_can_be_limited_to_paths(repo: Path, hash_file: Path, capsys: pytest.CaptureFixture[str]) -> None:
    _commit(repo, {"clean/ok.py": "ok = True\n"})
    base = ["--repo", str(repo), "--hash-file", str(hash_file), "audit"]
    assert dl.main([*base, "clean"]) == 0
    assert "existing.py" not in capsys.readouterr().out
    assert dl.main([*base, "existing.py"]) == 1
    assert "existing.py:1" in capsys.readouterr().out


def test_audit_of_paths_that_match_no_tracked_file_fails_closed(
    repo: Path, hash_file: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    code, out, err = _audit(repo, hash_file, capsys, "no/such/dir")
    assert code == 2
    assert "no tracked file under no/such/dir" in err
    assert "no denylisted terms" not in out


def test_audit_fails_closed_on_a_mistyped_path_next_to_one_that_matches(
    clean_repo: Path, hash_file: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    code, out, err = _audit(clean_repo, hash_file, capsys, "README.md", "docs/nope.md")
    assert code == 2
    assert "no tracked file under docs/nope.md" in err
    assert "README.md" not in err
    assert "no denylisted terms" not in out
    code, _, err = _audit(clean_repo, hash_file, capsys, "no/such/dir", "providers", "docs/nope.md")
    assert code == 2
    assert "no tracked file under no/such/dir, docs/nope.md" in err


def _add_gitlink(repo: Path, path: str) -> None:
    """Track ``path`` as a submodule (a gitlink) with an empty checkout, as after a clone."""
    head = _git(repo, "rev-parse", "HEAD")
    _git(repo, "update-index", "--add", "--cacheinfo", f"160000,{head},{path}")
    _git(repo, "commit", "-qm", "add a submodule")
    (repo / path).mkdir(parents=True)


def test_audit_skips_the_directory_of_a_submodule(
    clean_repo: Path, hash_file: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _add_gitlink(clean_repo, "vendor/widgets")
    assert "vendor/widgets" in _git(clean_repo, "ls-files")
    code, out, err = _audit(clean_repo, hash_file, capsys)
    assert code == 0, err
    assert "no denylisted terms" in out


def test_audit_still_checks_the_path_of_a_submodule(
    clean_repo: Path, hash_file: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _add_gitlink(clean_repo, "vendor/initech-kyb")
    code, out, err = _audit(clean_repo, hash_file, capsys)
    assert code == 1, err
    assert "file path vendor/" in out


def test_audit_skips_a_symlink_to_a_directory(
    clean_repo: Path, hash_file: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    try:
        (clean_repo / "providers-link").symlink_to("providers", target_is_directory=True)
    except (OSError, NotImplementedError) as exc:
        pytest.skip(f"cannot create a symlink here: {exc}")
    _git(clean_repo, "add", "-A")
    _git(clean_repo, "commit", "-qm", "link")
    code, out, err = _audit(clean_repo, hash_file, capsys)
    assert code == 0, err
    assert "no denylisted terms" in out


def test_default_hash_file_lives_under_security(clean_repo: Path, capsys: pytest.CaptureFixture[str]) -> None:
    (clean_repo / "security").mkdir()
    (clean_repo / "security" / "denylist.sha256").write_text(dl.render(TEST_TERMS, TEST_SALT)[0], encoding="utf-8")
    _commit(clean_repo, {"providers/client.py": "client = InitechKyb()\n"})
    code = dl.main(["--repo", str(clean_repo), "audit"])
    out = capsys.readouterr().out
    assert code == 1
    assert "providers/client.py:1" in out


# ── House terminology (warnings) ────────────────────────────────────────────


@pytest.mark.parametrize(
    ("text", "preferred"),
    [
        ("add a kill switch for the agent", "operator override"),
        ("the kill-switch endpoint", "operator override"),
        ("killSwitchEnabled = true", "operator override"),
        ("KILL_SWITCH_URL", "operator override"),
        ("a killswitch", "operator override"),
        ("two kill switches", "operator override"),
        ("killswitches", "operator override"),
        ("a white-label wallet", "issuer-branded"),
        ("a white label wallet", "issuer-branded"),
        ("WhiteLabelConfig", "issuer-branded"),
        ("a white-labelled page", "issuer-branded"),
        ("we sell white labels", "issuer-branded"),
        ("an anomaly was detected", "irregularity"),
        ("detectAnomaly(agent)", "irregularity"),
        ("list anomalies", "irregularity"),
        ("ANOMALOUS_SPEND", "irregularity"),
        ("anomalously high spend", "irregularity"),
        ("the trust provider signs it", "accredited issuer"),
        ("trust_providers:", "accredited issuer"),
        ("our verification partner", "accredited issuer"),
        ("verification partners", "accredited issuer"),
        ("return the verification result", "attestation"),
        ("verificationResults[0]", "attestation"),
    ],
)
def test_house_terminology_variants_are_found(text: str, preferred: str) -> None:
    assert [match.preferred for match in dl.house_terms(text)] == [preferred]


@pytest.mark.parametrize(
    "text",
    [
        "skill switch",
        "a switch to kill the process",
        "kill the worker, then switch regions",
        "label the white box",
        "trusted provider list",
        "the provider we trust",
        "verification of the result",
        "results of the verification",
        "the operator override is issuer-branded",
        # House terms that are also everyday words are left to review.
        "the registry directory",
        "a consumer group",
        "software name and version",
    ],
)
def test_other_text_is_not_a_terminology_hit(text: str) -> None:
    assert dl.house_terms(text) == []


def test_terminology_hit_reports_word_position_and_house_term() -> None:
    assert dl.house_terms("configure the Kill Switch endpoint") == [dl.TermMatch(2, "kill switch", "operator override")]
    assert dl.house_terms("two anomalies") == [dl.TermMatch(1, "anomalies", "irregularity")]


def test_terminology_term_warns_without_failing_a_scan(
    repo: Path, hash_file: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _commit(repo, {"docs/ops.md": "# Operations\n\nFlip the kill switch to stop an agent.\n"})
    code, out, err = _scan(repo, hash_file, capsys)
    assert code == 0
    assert "no denylisted terms" in out
    assert 'docs/ops.md:3 (word 3): "kill switch" -> operator override' in out
    assert err == ""


def test_terminology_in_commit_message_branch_and_text_file_warns(
    repo: Path, hash_file: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _git(repo, "checkout", "-q", "-b", "feat/anomaly-alerts")
    _commit(repo, {"providers/mock.py": "ok = True\n"}, "feat: return the verification result")
    pr_text = tmp_path / "pull-request.txt"
    pr_text.write_text("Adds a provider\n\nSigned by a trust provider.\n", encoding="utf-8")
    code, out, _ = _scan(repo, hash_file, capsys, "--text-file", str(pr_text))
    assert code == 0
    assert 'message line 1 (word 4): "verification result" -> attestation' in out
    assert 'branch name (word 2): "anomaly" -> irregularity' in out
    assert 'pull-request.txt line 3 (word 4): "trust provider" -> accredited issuer' in out


def test_terminology_does_not_change_the_exit_code_of_a_vendor_finding(
    repo: Path, hash_file: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _commit(repo, {"providers/client.py": "# white-label client\nclient = AcmeVerify()\n"})
    code, out, _ = _scan(repo, hash_file, capsys)
    assert code == 1
    assert "providers/client.py:2 (word 2)" in out
    assert 'providers/client.py:1 (word 1): "white label" -> issuer-branded' in out
    assert "verify" not in out.lower()


def test_terminology_term_warns_without_failing_an_audit(
    clean_repo: Path, hash_file: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _commit(clean_repo, {"docs/alerts.md": "Anomaly alerts\n"})
    code, out, _ = _audit(clean_repo, hash_file, capsys)
    assert code == 0
    assert 'docs/alerts.md:1 (word 1): "anomaly" -> irregularity' in out
    assert "no denylisted terms" in out


def test_terminology_is_not_checked_when_the_check_cannot_run(
    repo: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _commit(repo, {"docs/ops.md": "the kill switch\n"})
    code, out, err = _scan(repo, tmp_path / "absent.sha256", capsys)
    assert code == 2
    assert "cannot read hash file" in err
    assert "operator override" not in out


# ── Failing closed ──────────────────────────────────────────────────────────


def test_unresolvable_base_fails_closed(repo: Path, hash_file: Path, capsys: pytest.CaptureFixture[str]) -> None:
    code = dl.main(["--repo", str(repo), "--hash-file", str(hash_file), "scan", "--base", "no-such-ref"])
    assert code == 2
    assert "cannot resolve ref 'no-such-ref'" in capsys.readouterr().err


def test_not_a_git_repository_fails_closed(
    tmp_path: Path, hash_file: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    plain = tmp_path / "plain"
    plain.mkdir()
    # Stop git from discovering a repository above the temporary directory.
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(tmp_path))
    code = dl.main(["--repo", str(plain), "--hash-file", str(hash_file), "scan", "--base", "main", "--branch", "x"])
    assert code == 2
    assert "check_denylist:" in capsys.readouterr().err


def test_audit_outside_a_git_repository_fails_closed(
    tmp_path: Path, hash_file: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    plain = tmp_path / "plain"
    plain.mkdir()
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(tmp_path))
    code, _, err = _audit(plain, hash_file, capsys)
    assert code == 2
    assert "git ls-files failed" in err


def test_audit_skips_a_tracked_file_deleted_from_the_working_tree(
    repo: Path, hash_file: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    (repo / "existing.py").unlink()
    code, out, _ = _audit(repo, hash_file, capsys)
    assert code == 0
    assert "no denylisted terms" in out


def test_audit_fails_closed_on_a_tracked_file_it_cannot_read(
    clean_repo: Path, hash_file: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    real_read_bytes = Path.read_bytes

    def unreadable(path: Path) -> bytes:
        if path.name == "mock.py":
            raise PermissionError(13, "Permission denied (simulated)")
        return real_read_bytes(path)

    monkeypatch.setattr(Path, "read_bytes", unreadable)
    code, out, err = _audit(clean_repo, hash_file, capsys)
    assert code == 2
    assert "cannot read providers/mock.py" in err
    assert "no denylisted terms" not in out


def test_git_failure_after_refs_resolve_fails_closed(
    repo: Path, hash_file: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _commit(repo, {"providers/mock.py": "ok = True\n"})
    real_git = dl._git

    def failing_diff(repo_path: Path, *args: str) -> str:
        if args[0] == "diff":
            raise dl.DenylistError("git diff failed: simulated")
        return real_git(repo_path, *args)

    monkeypatch.setattr(dl, "_git", failing_diff)
    code, _, err = _scan(repo, hash_file, capsys)
    assert code == 2
    assert "simulated" in err


def test_missing_hash_file_fails_closed(repo: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    code, _, err = _scan(repo, tmp_path / "absent.sha256", capsys)
    assert code == 2
    assert "cannot read hash file" in err


@pytest.mark.parametrize(
    ("mutate", "reason"),
    [
        (lambda t: t.replace("format: 1", "format: 9"), "expected 'format: 1'"),
        (lambda t: "\n".join(line for line in t.splitlines() if not line.startswith("salt:")), "'salt'"),
        (lambda t: t.replace("max-tokens: 3", "max-tokens: 0"), "'max-tokens' must be between"),
        (lambda t: t.replace("max-tokens: 3", "max-tokens: many"), "'max-tokens' must be an integer"),
        (lambda t: t + "acme verify\n", "not a field or a lower-case SHA-256"),
        (lambda t: "\n".join(line for line in t.splitlines() if len(line) != 64), "contains no hashes"),
    ],
)
def test_malformed_hash_file_fails_closed(tmp_path: Path, hash_file: Path, mutate, reason: str) -> None:
    hash_file.write_text(mutate(hash_file.read_text(encoding="utf-8")), encoding="utf-8")
    with pytest.raises(dl.DenylistError, match=reason):
        dl.load(hash_file)


# ── Building and the committed list ─────────────────────────────────────────


def test_build_writes_only_salt_and_digests(
    repo: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    terms = tmp_path / "private-terms.txt"
    terms.write_text("# invented\nacme verify\nGlobex Screening Hub\n\n", encoding="utf-8")
    out_file = repo / "security" / "denylist.sha256"
    code = dl.main(["--repo", str(repo), "--hash-file", str(out_file), "build", "--terms-file", str(terms)])
    out = capsys.readouterr().out
    assert code == 0
    assert "with 2 terms" in out
    assert "acme" not in out.lower() and "globex" not in out.lower()
    written = out_file.read_text(encoding="utf-8").lower()
    assert "acme" not in written and "globex" not in written
    assert b"\r" not in out_file.read_bytes()
    loaded = dl.load(out_file)
    assert len(loaded.hashes) == 2
    assert loaded.max_tokens == 3
    assert loaded.matches("AcmeVerify")


def test_build_keep_salt_reuses_the_existing_salt(repo: Path, tmp_path: Path) -> None:
    terms = tmp_path / "private-terms.txt"
    terms.write_text("acme verify\n", encoding="utf-8")
    out_file = repo / "denylist.sha256"
    base = ["--repo", str(repo), "--hash-file", str(out_file), "build", "--terms-file", str(terms)]
    assert dl.main(base) == 0
    first = dl.load(out_file).salt
    assert dl.main([*base, "--keep-salt"]) == 0
    assert dl.load(out_file).salt == first
    assert dl.main(base) == 0
    assert dl.load(out_file).salt != first


def test_build_refuses_a_terms_file_inside_the_repository(
    repo: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    terms = repo / "terms.txt"
    terms.write_text("acme verify\n", encoding="utf-8")
    out_file = repo / "denylist.sha256"
    code = dl.main(["--repo", str(repo), "--hash-file", str(out_file), "build", "--terms-file", str(terms)])
    assert code == 2
    assert "outside the repository" in capsys.readouterr().err
    assert not out_file.exists()


# ── The committed tree and CI ───────────────────────────────────────────────

# Lines the first audit of this repository flagged, since reworded. The whole
# tree is audited by `make check` and the Vendor Denylist workflow, which takes
# about a minute: too long for this suite.
REWORDED_PATHS = ("apps/portal/src/pages/__tests__/SettingsPage.test.tsx", "docs/compliance/privacy-policy.md")


def test_audit_passes_on_the_files_that_were_reworded(capsys: pytest.CaptureFixture[str]) -> None:
    # A path that no longer matches a tracked file fails the audit (exit 2).
    code = dl.main(["--repo", str(REPO_ROOT), "audit", *REWORDED_PATHS])
    captured = capsys.readouterr()
    assert code == 0, captured.out + captured.err


def test_ci_scans_changes_and_audits_the_whole_tree() -> None:
    import yaml  # installed with the Python SDK's dev extras, which `make install` sets up

    workflow = yaml.safe_load((REPO_ROOT / ".github" / "workflows" / "vendor-denylist.yml").read_text("utf-8"))
    triggers = workflow.get("on", workflow.get(True))  # YAML 1.1 reads a bare `on` key as true
    assert "edited" in triggers["pull_request"]["types"]
    assert triggers["push"]["branches"] == ["main"]
    runs = [
        (job, step, " ".join(step.get("run", "").split()))
        for job in workflow["jobs"].values()
        for step in job["steps"]
    ]
    audits = [(job, step) for job, step, run in runs if run == "python scripts/check_denylist.py audit"]
    scans = [(job, step) for job, step, run in runs if "python scripts/check_denylist.py scan" in run]
    assert audits, "no job audits the whole tree"
    assert scans, "no job scans the change"
    for job, step in [*audits, *scans]:
        assert not job.get("continue-on-error") and not step.get("continue-on-error")
    for job, _ in audits:
        # Skipped only for an edited pull request (a new title, description or
        # base branch), which adds no commits.
        assert job.get("if") in (None, "github.event.action != 'edited'")


def test_ci_runs_these_tests_on_python_3_9() -> None:
    import yaml  # installed with the Python SDK's dev extras, which `make install` sets up

    # `make test` runs them on 3.12; a 3.9 job keeps the check working on the
    # oldest Python that CONTRIBUTING.md supports.
    ci = yaml.safe_load((REPO_ROOT / ".github" / "workflows" / "ci.yml").read_text("utf-8"))
    jobs = [
        job
        for job in ci["jobs"].values()
        if "3.9" in job.get("strategy", {}).get("matrix", {}).get("python-version", [])
        and any(step.get("run", "").strip() == "python -m pytest -q tests/scripts" for step in job["steps"])
    ]
    assert jobs, "no Python 3.9 CI job runs tests/scripts"


def test_committed_denylist_is_well_formed_and_holds_no_plaintext() -> None:
    path = REPO_ROOT / "security" / "denylist.sha256"
    loaded = dl.load(path)
    assert len(loaded.hashes) >= 50
    assert len(loaded.salt) >= 16
    for line in path.read_text(encoding="utf-8").splitlines():
        assert line.startswith(("#", "format:", "salt:", "max-tokens:")) or len(line) == 64
