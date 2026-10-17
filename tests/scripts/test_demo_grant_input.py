"""Reject malformed pipe input before reading any local credential files."""
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
ARGS = [
    sys.executable, str(ROOT / "scripts" / "demo_verify_step.py"),
    "--registry-origin", "https://registry.example", "--registry-loopback", "http://127.0.0.1:3199",
    "--mock-origin", "https://mock-issuer.example", "--mock-loopback", "http://127.0.0.1:3200",
    "--passport", "nonexistent-fixture.sd-jwt", "--agent-key", "nonexistent-fixture.json",
    "--merchant", "https://merchant.example", "--audience", "https://merchant.example/checkout", "--expect", "ok",
]


@pytest.mark.parametrize("value", ["", "   ", "x" * 65537, "synthetic" + " " * 65537])
def test_demo_grant_stdin_rejects_empty_or_oversized_input(value: str) -> None:
    result = subprocess.run([*ARGS, "--grant-stdin"], input=value, text=True, capture_output=True, check=False)
    assert result.returncode == 2
    assert "grant stdin must contain" in result.stderr
    assert "FileNotFoundError" not in result.stderr


def test_demo_grant_input_modes_are_mutually_exclusive() -> None:
    result = subprocess.run([*ARGS, "--grant-stdin", "--grant", "fixture.jwt"],
                            input="synthetic", text=True, capture_output=True, check=False)
    assert result.returncode == 2
    assert "not allowed with argument" in result.stderr
