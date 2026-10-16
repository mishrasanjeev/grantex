"""Keep supported dependency surfaces off vulnerable MCP releases."""

from pathlib import Path

import pytest
from packaging.requirements import Requirement

try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib


ROOT = Path(__file__).resolve().parents[2]


def mcp_requirement(surface: str) -> Requirement:
    path = ROOT / surface
    if path.suffix == ".toml":
        dependencies = tomllib.loads(path.read_text(encoding="utf-8"))["project"]["dependencies"]
    else:
        dependencies = [
            line.split("#", 1)[0].strip()
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]
    requirements = [Requirement(value) for value in dependencies]
    return next(requirement for requirement in requirements if requirement.name.lower() == "mcp")


@pytest.mark.parametrize("surface", ["requirements.txt", "packages/strands-py/pyproject.toml"])
def test_mcp_dependency_excludes_unpatched_sessions(surface: str) -> None:
    requirement = mcp_requirement(surface)
    # GHSA-84m7-p3x7-pcfv fixes the supported 1.x line at 1.30.0.
    assert "1.30.0" in requirement.specifier
    assert "1.29.1" not in requirement.specifier
    assert "2.1.1" not in requirement.specifier
