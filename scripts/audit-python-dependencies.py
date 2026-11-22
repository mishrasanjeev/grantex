#!/usr/bin/env python3

from __future__ import annotations

import argparse
import importlib.metadata
import json
import re
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import url2pathname

from packaging.requirements import Requirement
from packaging.version import Version


ROOT = Path(__file__).resolve().parent.parent
ALLOWED_SPDX = frozenset(
    {
        "0BSD",
        "Apache-2.0",
        "BSD-2-Clause",
        "BSD-3-Clause",
        "CC0-1.0",
        "ISC",
        "MIT",
        "MIT-0",
        "MPL-2.0",
        "PSF-2.0",
        "Python-2.0",
        "Unlicense",
    }
)
ALLOWED_LEGACY_MARKERS = (
    "apache",
    "bsd",
    "cc0",
    "isc",
    "mit",
    "mozilla public license 2.0",
    "mpl-2.0",
    "python software foundation",
    "unlicense",
)
FORBIDDEN_LICENSE_MARKERS = (
    "agpl",
    "gnu affero",
    "gnu general public",
    "gpl",
    "gnu lesser",
    "lgpl",
    "sspl",
    "server side public",
    "commons clause",
    "business source",
    "busl",
    "polyform",
    "elastic license",
)


def tracked_files() -> list[Path]:
    output = subprocess.check_output(
        ["git", "ls-files", "*pyproject.toml", "*requirements*.txt"],
        cwd=ROOT,
        text=True,
    )
    return [ROOT / line for line in output.splitlines() if line]


def dependency_audit(path: Path) -> subprocess.CompletedProcess[str]:
    target = [str(path.parent)] if path.name == "pyproject.toml" else ["-r", str(path)]
    return subprocess.run(
        [sys.executable, "-m", "pip_audit", *target, "--progress-spinner", "off"],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=600,
    )


def license_findings(metadata: dict) -> list[str]:
    name = str(metadata.get("name", "<unknown>"))
    version = str(metadata.get("version", "<unknown>"))
    expression = metadata.get("license_expression")
    if isinstance(expression, str) and expression.strip():
        identifiers = {
            token
            for token in re.findall(r"[A-Za-z0-9][A-Za-z0-9.+-]*", expression)
            if token not in {"AND", "OR", "WITH"}
        }
        if identifiers - ALLOWED_SPDX:
            return [f"{name}@{version} has unapproved SPDX expression {expression}"]
        return []

    evidence = [str(metadata.get("license", ""))]
    classifiers = metadata.get("classifiers", metadata.get("classifier", []))
    evidence.extend(
        classifier
        for classifier in classifiers
        if isinstance(classifier, str) and classifier.startswith("License ::")
    )
    combined = " | ".join(value for value in evidence if value).lower()
    if any(marker in combined for marker in FORBIDDEN_LICENSE_MARKERS):
        return [f"{name}@{version} has prohibited license metadata: {combined}"]
    if not combined or not any(marker in combined for marker in ALLOWED_LEGACY_MARKERS):
        return [f"{name}@{version} has unknown or unapproved license metadata: {combined or 'missing'}"]
    return []


def license_audit(path: Path) -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory(prefix="grantex-license-") as directory:
        report_path = Path(directory) / "pip-report.json"
        target = [str(path.parent)] if path.name == "pyproject.toml" else ["-r", str(path)]
        resolve = subprocess.run(
            [
                sys.executable,
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                "--no-input",
                "--dry-run",
                "--ignore-installed",
                "--report",
                str(report_path),
                *target,
            ],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=600,
        )
        if resolve.returncode != 0:
            return resolve

        report = json.loads(report_path.read_text(encoding="utf-8"))
        findings: list[str] = []
        for item in report.get("install", []):
            findings.extend(license_findings(item.get("metadata", {})))

        return subprocess.CompletedProcess(
            args=["pip", "install", "--dry-run", *target],
            returncode=1 if findings else 0,
            stdout="",
            stderr="\n".join(findings),
        )


def audit(path: Path) -> tuple[Path, subprocess.CompletedProcess[str], subprocess.CompletedProcess[str]]:
    return path, dependency_audit(path), license_audit(path)


def normalized_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def owned_projects() -> dict[str, tuple[Path, str]]:
    try:
        import tomllib
    except ModuleNotFoundError:
        import tomli as tomllib

    projects = {}
    for path in tracked_files():
        if path.name != "pyproject.toml":
            continue
        if not path.resolve().is_relative_to(ROOT.resolve()):
            raise ValueError("Owned project manifest leaves the repository")
        project = tomllib.loads(path.read_text(encoding="utf-8"))["project"]
        name = normalized_name(project["name"])
        if name in projects or not isinstance(project["version"], str) or not project["version"]:
            raise ValueError("Duplicate or invalid owned project identity")
        projects[name] = (path.parent.resolve(), project["version"])
    return projects


def verified_owned_editable(distribution, projects: dict[str, tuple[Path, str]]) -> bool:
    raw = distribution.read_text("direct_url.json")
    if raw is None:
        return False
    direct = json.loads(raw)
    if not isinstance(direct, dict):
        raise ValueError("Invalid installed direct-url metadata")
    directory = direct.get("dir_info", {})
    if not isinstance(directory, dict):
        raise ValueError("Invalid installed direct-url directory metadata")
    editable = directory.get("editable", False)
    if not isinstance(editable, bool):
        raise ValueError("Invalid installed editable flag")
    if not editable:
        return False
    name = normalized_name(distribution.metadata["Name"])
    parsed = urlsplit(direct["url"])
    expected = projects.get(name)
    if (
        expected is None
        or parsed.scheme != "file"
        or parsed.netloc not in ("", "localhost")
        or parsed.query
        or parsed.fragment
        or Path(url2pathname(parsed.path)).resolve() != expected[0]
        or distribution.version != expected[1]
    ):
        raise ValueError(f"Unverified editable distribution cannot be excluded: {name}")
    return True


def installed_audit(auditor_python: Path | None = None) -> int:
    findings: list[str] = []
    seen: set[str] = set()
    editables: set[str] = set()
    versions: dict[str, str] = {}
    pins: dict[str, str] = {}
    try:
        projects = owned_projects()
        for distribution in importlib.metadata.distributions():
            name = normalized_name(distribution.metadata["Name"])
            if not name or name in seen:
                raise ValueError(f"Missing or duplicate installed distribution: {name}")
            seen.add(name)
            if not isinstance(distribution.version, str):
                raise ValueError(f"Invalid installed version: {name}")
            versions[name] = str(Version(distribution.version))
            if verified_owned_editable(distribution, projects):
                editables.add(name)
            else:
                requirement = Requirement(f"{name}=={versions[name]}")
                if (
                    normalized_name(requirement.name) != name
                    or requirement.url
                    or requirement.marker
                    or requirement.extras
                    or str(requirement.specifier) != f"=={versions[name]}"
                ):
                    raise ValueError(f"Invalid installed audit requirement: {name}")
                pins[name] = str(requirement)
            findings.extend(license_findings({
                "name": name,
                "version": distribution.version,
                "license_expression": distribution.metadata.get("License-Expression"),
                "license": distribution.metadata.get("License", ""),
                "classifiers": distribution.metadata.get_all("Classifier", []),
            }))
        if len(seen) <= len(editables):
            raise ValueError("No installed third-party distributions to audit")
        listed = subprocess.run(
            [sys.executable, "-m", "pip", "list", "--editable", "--format=json", "--disable-pip-version-check"],
            cwd=ROOT, check=False, capture_output=True, text=True, timeout=60,
        )
        if listed.returncode:
            raise ValueError("Cannot independently inspect installed editable distributions")
        native_editables = json.loads(listed.stdout)
        if not isinstance(native_editables, list):
            raise ValueError("Invalid native editable inventory")
        native_names: set[str] = set()
        for item in native_editables:
            name = normalized_name(item["name"])
            if name not in editables or name in native_names:
                raise ValueError("Native auditor could skip an unverified or duplicate editable")
            native_names.add(name)
            if item["version"] != projects[name][1] or Path(item["editable_project_location"]).resolve() != projects[name][0]:
                raise ValueError("Native editable source or version differs")
        if native_names != editables:
            raise ValueError("Installed editable inventories disagree")
        inventory = subprocess.run(
            [sys.executable, "-m", "pip", "list", "--format=json", "--disable-pip-version-check"],
            cwd=ROOT, check=False, capture_output=True, text=True, timeout=60,
        )
        if inventory.returncode:
            raise ValueError("Cannot independently inspect the complete installed inventory")
        native_inventory = json.loads(inventory.stdout)
        if not isinstance(native_inventory, list):
            raise ValueError("Invalid native complete inventory")
        native_versions: dict[str, str] = {}
        for item in native_inventory:
            name = normalized_name(item["name"])
            if name not in versions or name in native_versions:
                raise ValueError("Native installed inventory has an unknown or duplicate distribution")
            native_versions[name] = str(Version(item["version"]))
        if native_versions != versions or set(pins) != seen - editables:
            raise ValueError("Complete installed inventories disagree")
    except (KeyError, TypeError, ValueError, OSError, subprocess.TimeoutExpired) as error:
        print(f"Installed graph validation failed: {error}", file=sys.stderr)
        return 1

    # The complete graph is already installed and independently verified. Freeze every
    # third-party version so strict mode never mistakes an owned editable for a failed lookup.
    try:
        with tempfile.TemporaryDirectory(prefix="grantex-installed-audit-") as directory:
            requirements = Path(directory) / "installed.txt"
            requirements.write_text("\n".join(pins[name] for name in sorted(pins)) + "\n", encoding="utf-8")
            result = subprocess.run(
                [str(auditor_python) if auditor_python is not None else sys.executable,
                 "-m", "pip_audit", "-r", str(requirements),
                 "--no-deps", "--disable-pip", "--strict", "--vulnerability-service", "osv",
                 "--format=json", "--progress-spinner", "off"],
                cwd=ROOT, check=False, capture_output=True, text=True, timeout=600,
            )
    except (OSError, subprocess.TimeoutExpired) as error:
        print(f"Installed vulnerability audit failed: {error}", file=sys.stderr)
        return 1
    print(result.stdout)
    if result.stderr:
        print(result.stderr, file=sys.stderr)
    for finding in findings:
        print(finding, file=sys.stderr)
    if result.returncode or findings:
        return 1
    try:
        report = json.loads(result.stdout)
        dependencies = report["dependencies"]
        if not isinstance(dependencies, list):
            raise ValueError("Invalid auditor dependency inventory")
        audited_versions: dict[str, str] = {}
        for item in dependencies:
            name = normalized_name(item["name"])
            if (
                name not in pins
                or name in audited_versions
                or item.get("skip_reason")
                or not isinstance(item["vulns"], list)
                or item["vulns"]
            ):
                raise ValueError("Auditor returned an unknown, duplicate, skipped or vulnerable dependency")
            audited_versions[name] = str(Version(item["version"]))
        if audited_versions != {name: versions[name] for name in pins}:
            raise ValueError("Auditor did not cover every installed third-party version")
    except (KeyError, TypeError, ValueError) as error:
        print(f"Installed audit coverage validation failed: {error}", file=sys.stderr)
        return 1
    print(f"Installed Python audit PASS: {len(seen)} distributions; {len(editables)} verified local source projects.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit resolved or actual installed Python dependencies and licenses")
    parser.add_argument("--installed", action="store_true", help="Audit the actual current interpreter environment")
    parser.add_argument("--auditor-python", type=Path, help="Run strict vulnerability queries with a separately audited tool interpreter")
    arguments = parser.parse_args()
    if arguments.auditor_python is not None and not arguments.installed:
        parser.error("--auditor-python requires --installed")
    if arguments.installed:
        return installed_audit(arguments.auditor_python)
    targets = tracked_files()
    failures = 0
    with ThreadPoolExecutor(max_workers=min(4, len(targets))) as executor:
        futures = [executor.submit(audit, target) for target in targets]
        for future in as_completed(futures):
            path, dependency_result, license_result = future.result()
            label = path.relative_to(ROOT)
            if dependency_result.returncode == 0 and license_result.returncode == 0:
                print(f"PASS {label}")
                continue
            failures += 1
            print(f"FAIL {label}", file=sys.stderr)
            if dependency_result.returncode != 0:
                print("Dependency vulnerability audit failed:", file=sys.stderr)
                print(dependency_result.stdout, file=sys.stderr)
                print(dependency_result.stderr, file=sys.stderr)
            if license_result.returncode != 0:
                print("Dependency license audit failed:", file=sys.stderr)
                print(license_result.stdout, file=sys.stderr)
                print(license_result.stderr, file=sys.stderr)
    if failures == 0:
        print(
            "Python dependency and license audit PASS: "
            f"{len(targets)} tracked project/requirements surfaces."
        )
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
