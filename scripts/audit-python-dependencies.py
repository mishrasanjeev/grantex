#!/usr/bin/env python3

from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


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
            metadata = item.get("metadata", {})
            name = str(metadata.get("name", "<unknown>"))
            version = str(metadata.get("version", "<unknown>"))
            expression = metadata.get("license_expression")
            if isinstance(expression, str) and expression.strip():
                identifiers = {
                    token
                    for token in re.findall(r"[A-Za-z0-9][A-Za-z0-9.+-]*", expression)
                    if token not in {"AND", "OR", "WITH"}
                }
                unapproved = sorted(identifiers - ALLOWED_SPDX)
                if unapproved:
                    findings.append(
                        f"{name}@{version} has unapproved SPDX expression {expression}"
                    )
                continue

            evidence = [str(metadata.get("license", ""))]
            classifiers = metadata.get("classifiers", metadata.get("classifier", []))
            evidence.extend(
                classifier
                for classifier in classifiers
                if isinstance(classifier, str) and classifier.startswith("License ::")
            )
            combined = " | ".join(value for value in evidence if value).lower()
            if any(marker in combined for marker in FORBIDDEN_LICENSE_MARKERS):
                findings.append(f"{name}@{version} has prohibited license metadata: {combined}")
            elif not combined or not any(marker in combined for marker in ALLOWED_LEGACY_MARKERS):
                findings.append(f"{name}@{version} has unknown or unapproved license metadata: {combined or 'missing'}")

        return subprocess.CompletedProcess(
            args=["pip", "install", "--dry-run", *target],
            returncode=1 if findings else 0,
            stdout="",
            stderr="\n".join(findings),
        )


def audit(path: Path) -> tuple[Path, subprocess.CompletedProcess[str], subprocess.CompletedProcess[str]]:
    return path, dependency_audit(path), license_audit(path)


def main() -> int:
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
