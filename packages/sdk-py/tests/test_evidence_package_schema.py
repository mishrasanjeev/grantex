"""Evidence package format 1.0 (PRD G-5): the published JSON Schema and examples.

The verifiers in grantex.evidence apply the full verification rules of
spec/evidence-package.md; these tests check the schema itself with a stock
JSON Schema validator.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

import pytest

jsonschema = pytest.importorskip("jsonschema")

SPEC = Path(__file__).resolve().parents[3] / "spec"
SCHEMA_PATH = SPEC / "evidence-package-1.0.schema.json"
EXAMPLES = SPEC / "examples" / "evidence"


def _schema() -> Dict[str, Any]:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def _validator() -> Any:
    return jsonschema.Draft202012Validator(_schema())


def _example(name: str) -> Dict[str, Any]:
    return json.loads((EXAMPLES / name).read_bytes())


def test_schema_is_valid_json_schema_2020_12() -> None:
    jsonschema.Draft202012Validator.check_schema(_schema())
    assert _schema()["$id"] == "https://grantex.dev/spec/evidence-package-1.0.schema.json"


@pytest.mark.parametrize("name", ["package.json", "package-disclosed.json", "package-signed.json"])
def test_example_packages_match_the_schema(name: str) -> None:
    assert list(_validator().iter_errors(_example(name))) == []


def test_example_packages_are_canonical_json_without_whitespace() -> None:
    for name in ("package.json", "package-disclosed.json", "package-signed.json"):
        raw = (EXAMPLES / name).read_bytes()
        value = json.loads(raw)
        compact = json.dumps(value, separators=(",", ":"), sort_keys=True, ensure_ascii=False)
        assert raw.decode("utf-8") == compact, name


@pytest.mark.parametrize(
    "path,value",
    [
        (["extra"], True),
        (["version"], "2.0"),
        (["entries", 3, "data", "outcome"], "maybe"),
        (["entries", 3, "data", "notes"], "free text"),
        (["entries", 10, "data", "approval_position"], 3),
        (["entries", 0, "at"], "2026-09-14T09:00:00Z"),
        (["chain", "root"], "sha256:ABC"),
        (["privacy", "disclosed"], ["approver", "approver"]),
        (["case", "ext"], {"not-namespaced": 1}),
        (["signature"], {"alg": "none", "jws": "a..b", "kid": "k"}),
    ],
)
def test_schema_refuses_invalid_structure(path: list, value: Any) -> None:
    document = _example("package.json")
    node = document
    for key in path[:-1]:
        node = node[key]
    node[path[-1]] = value
    assert list(_validator().iter_errors(document)), path


def test_schema_refuses_missing_required_members() -> None:
    document = _example("package.json")
    del document["entries"][4]["data"]["upstream_records"]
    assert list(_validator().iter_errors(document))
    document = _example("package.json")
    del document["chain"]["root"]
    assert list(_validator().iter_errors(document))
