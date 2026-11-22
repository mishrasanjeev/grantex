# SPDX-License-Identifier: Apache-2.0
"""Audit the installed graph on every supported Python matrix interpreter."""
import importlib.util
import json
from email.message import Message
from pathlib import Path
import subprocess

from packaging.requirements import Requirement
import pytest
import yaml

try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("installed_dependency_audit", ROOT / "scripts/audit-python-dependencies.py")
assert SPEC and SPEC.loader
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


@pytest.mark.parametrize("manifest", sorted((ROOT / "packages").glob("*/pyproject.toml")))
def test_current_python_packages_have_a_security_supported_floor(manifest):
    data = tomllib.loads(manifest.read_text(encoding="utf-8"))
    project = data["project"]
    expected = ">=3.11" if manifest.parent.name == "strands-py" else ">=3.10"
    assert project["requires-python"] == expected
    assert "Programming Language :: Python :: 3.9" not in project.get("classifiers", [])
    for value in project.get("optional-dependencies", {}).get("dev", []):
        requirement = Requirement(value)
        if requirement.name == "pytest":
            assert requirement.marker is None
            assert "9.0.2" not in requirement.specifier


@pytest.mark.parametrize("package", ["sdk-py", "gemma-py", "fastapi"])
def test_http_runtime_dependencies_exclude_unpatched_anyio(package):
    project = tomllib.loads((ROOT / "packages" / package / "pyproject.toml").read_text())["project"]
    requirement = next(Requirement(value) for value in project["dependencies"] if Requirement(value).name == "anyio")
    assert "4.14.2" in requirement.specifier
    assert "4.14.1" not in requirement.specifier


def test_fastapi_requires_the_patched_starlette_and_supported_framework():
    project = tomllib.loads((ROOT / "packages/fastapi/pyproject.toml").read_text())["project"]
    requirements = {item.name: item for item in map(Requirement, project["dependencies"])}
    assert "1.3.1" in requirements["starlette"].specifier
    assert "1.3.0" not in requirements["starlette"].specifier
    assert "0.162.5" in requirements["fastapi"].specifier
    assert "0.162.4" not in requirements["fastapi"].specifier


@pytest.mark.parametrize("job_name", ["sdk-py", "python-integrations"])
def test_both_python_versions_require_an_actual_installed_audit(job_name):
    workflow = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())
    job = workflow["jobs"][job_name]
    assert job["strategy"]["matrix"]["python-version"] == ["3.10", "3.12"]
    assert not job.get("continue-on-error") and job["strategy"]["fail-fast"] is False
    steps = [step for step in job["steps"] if step.get("run") == "python scripts/audit-python-dependencies.py --installed"]
    assert len(steps) == 1
    assert not steps[0].get("if") and not steps[0].get("continue-on-error")
    assert steps[0].get("working-directory", ".") == "."
    bootstrap = next(step["run"] for step in job["steps"] if step.get("name") == "Install patched Python audit and bootstrap tools")
    assert "pip>=26.2" in bootstrap and "setuptools>=84.1.0" in bootstrap
    assert "pip-audit==2.10.1" in bootstrap


class Distribution:
    def __init__(self, name="dependency", version="1.0", direct=None, license="MIT"):
        self.metadata = Message()
        self.metadata["Name"] = name
        self.metadata["Version"] = version
        self.metadata["License-Expression"] = license
        self.version = version
        self.direct = json.dumps(direct) if direct is not None else None

    def read_text(self, name):
        assert name == "direct_url.json"
        return self.direct


def editable(path, *, name="grantex", version="0.7.2", **updates):
    direct = {"url": path.as_uri(), "dir_info": {"editable": True}, **updates}
    return Distribution(name=name, version=version, direct=direct, license="Apache-2.0")


def test_only_exact_owned_source_and_version_can_be_an_editable_exclusion(tmp_path):
    projects = {"grantex": (tmp_path, "0.7.2")}
    assert audit.verified_owned_editable(editable(tmp_path), projects)
    assert not audit.verified_owned_editable(Distribution(), projects)


@pytest.mark.parametrize("change", ["foreign-path", "foreign-name", "wrong-version", "remote-url", "query", "nonboolean"])
def test_unverified_editable_distributions_are_refused(tmp_path, change):
    projects = {"grantex": (tmp_path, "0.7.2")}
    distribution = editable(tmp_path)
    if change == "foreign-path":
        distribution = editable(tmp_path.parent)
    elif change == "foreign-name":
        distribution = editable(tmp_path, name="foreign")
    elif change == "wrong-version":
        distribution = editable(tmp_path, version="0.0.1")
    elif change == "remote-url":
        distribution = editable(tmp_path, url="https://example.invalid/source")
    elif change == "query":
        distribution = editable(tmp_path, url=tmp_path.as_uri() + "?external=true")
    else:
        distribution = editable(tmp_path, dir_info={"editable": "true"})
    with pytest.raises(ValueError):
        audit.verified_owned_editable(distribution, projects)


@pytest.mark.parametrize("metadata", [
    {"license_expression": "GPL-3.0-only"},
    {"license_expression": "LicenseRef-Unknown"},
    {"license": "GNU Affero GPL"},
    {},
])
def test_installed_license_policy_does_not_allow_unknown_or_prohibited_metadata(metadata):
    assert audit.license_findings({"name": "dependency", "version": "1.0", **metadata})


@pytest.mark.parametrize("metadata", [
    {"license_expression": "Apache-2.0 OR BSD-3-Clause"},
    {"license": "MIT"},
    {"classifiers": ["License :: OSI Approved :: Apache Software License"]},
])
def test_installed_license_policy_preserves_existing_permitted_metadata(metadata):
    assert not audit.license_findings({"name": "dependency", "version": "1.0", **metadata})


def configure_graph(monkeypatch, tmp_path, distributions=None):
    monkeypatch.setattr(audit, "owned_projects", lambda: {"grantex": (tmp_path, "0.7.2")})
    monkeypatch.setattr(audit.importlib.metadata, "distributions", lambda: distributions or [editable(tmp_path), Distribution()])


@pytest.mark.parametrize("exit_code", [0, 1, 2])
def test_actual_installed_osv_audit_propagates_vulnerabilities_and_transport_errors(monkeypatch, tmp_path, exit_code):
    configure_graph(monkeypatch, tmp_path)
    calls = []

    def run(command, **kwargs):
        calls.append(command)
        assert kwargs["check"] is False
        if command[2] == "pip":
            assert kwargs["timeout"] == 60
            return subprocess.CompletedProcess(command, 0, json.dumps([{
                "name": "grantex", "version": "0.7.2", "editable_project_location": str(tmp_path)}]), "")
        assert kwargs["timeout"] == 600
        return subprocess.CompletedProcess(command, exit_code, "audit-output", "audit-diagnostics")

    monkeypatch.setattr(audit.subprocess, "run", run)
    assert audit.installed_audit() == (0 if exit_code == 0 else 1)
    assert len(calls) == 2
    assert calls[0][2:] == ["pip", "list", "--editable", "--format=json", "--disable-pip-version-check"]
    assert calls[1][2:] == ["pip_audit", "--skip-editable", "--strict", "--vulnerability-service", "osv", "--progress-spinner", "off"]


def test_foreign_editable_cannot_reach_a_skip_editable_audit(monkeypatch, tmp_path):
    configure_graph(monkeypatch, tmp_path, [editable(tmp_path.parent), Distribution()])
    monkeypatch.setattr(audit.subprocess, "run", lambda *_args, **_kwargs: pytest.fail("Unverified exclusion reached auditor"))
    assert audit.installed_audit() == 1


def test_duplicate_installed_distribution_fails_before_audit(monkeypatch, tmp_path):
    configure_graph(monkeypatch, tmp_path, [Distribution(), Distribution()])
    monkeypatch.setattr(audit.subprocess, "run", lambda *_args, **_kwargs: pytest.fail("Ambiguous graph reached auditor"))
    assert audit.installed_audit() == 1


def test_installed_license_failure_is_not_hidden_by_a_zero_vulnerability_result(monkeypatch, tmp_path):
    configure_graph(monkeypatch, tmp_path, [editable(tmp_path), Distribution(license="AGPL-3.0-only")])

    def run(command, **_kwargs):
        output = json.dumps([{"name": "grantex", "version": "0.7.2", "editable_project_location": str(tmp_path)}]) if command[2] == "pip" else ""
        return subprocess.CompletedProcess(command, 0, output, "")

    monkeypatch.setattr(audit.subprocess, "run", run)
    assert audit.installed_audit() == 1


@pytest.mark.parametrize("inventory", [
    [],
    [{"name": "foreign", "version": "1.0", "editable_project_location": "/foreign"}],
    [{"name": "grantex", "version": "0.0.1", "editable_project_location": "/foreign"}],
    {"not": "a-list"},
])
def test_native_editable_inventory_cannot_hide_excluded_packages(monkeypatch, tmp_path, inventory):
    configure_graph(monkeypatch, tmp_path)

    def run(command, **_kwargs):
        assert command[2] == "pip", "Mismatched editable graph must fail before the vulnerability auditor"
        return subprocess.CompletedProcess(command, 0, json.dumps(inventory), "")

    monkeypatch.setattr(audit.subprocess, "run", run)
    assert audit.installed_audit() == 1


@pytest.mark.parametrize("error", [OSError("audit tool unavailable"), subprocess.TimeoutExpired("pip_audit", 600)])
def test_missing_auditor_and_timeout_fail_closed(monkeypatch, tmp_path, error):
    configure_graph(monkeypatch, tmp_path)

    def fail(*_args, **_kwargs):
        raise error

    monkeypatch.setattr(audit.subprocess, "run", fail)
    assert audit.installed_audit() == 1
