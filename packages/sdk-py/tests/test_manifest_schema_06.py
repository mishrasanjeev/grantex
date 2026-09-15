"""Manifest schema 0.6 (PRD G-1): object-form tools, strict loading, JSON Schema.

The fixtures in ``spec/examples/manifest-0.6`` are shared with the TypeScript
SDK so both loaders and the published schema agree on what is valid.
"""
from __future__ import annotations

import json
import warnings
from pathlib import Path
from typing import Any, Dict, List

import pytest
from jsonschema import Draft202012Validator

from grantex import (
    ManifestValidationError,
    Permission,
    ToolCaps,
    ToolManifest,
    ToolSpec,
)

SPEC_DIR = Path(__file__).resolve().parents[3] / "spec"
SCHEMA_PATH = SPEC_DIR / "manifest-0.6.schema.json"
EXAMPLES_DIR = SPEC_DIR / "examples" / "manifest-0.6"
VALID_FILES = sorted((EXAMPLES_DIR / "valid").glob("*.json"))
INVALID_CASES: List[Dict[str, Any]] = json.loads(
    (EXAMPLES_DIR / "invalid.json").read_text(encoding="utf-8")
)["cases"]


@pytest.fixture(scope="module")
def validator() -> Draft202012Validator:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def _acme_kyb_path() -> Path:
    return EXAMPLES_DIR / "valid" / "acme_kyb.json"


# ── Acceptance criteria ─────────────────────────────────────────────────────


class TestManifest06AcceptanceCriteria:
    def test_string_and_object_forms_load_from_the_same_file(self) -> None:
        m = ToolManifest.from_file(str(EXAMPLES_DIR / "valid" / "acme_kyb_mixed_forms.json"))
        assert m.get_permission("get_case") == "read"
        assert m.get_tool_spec("get_case") == ToolSpec(permission="read")
        spec = m.get_tool_spec("verify_business")
        assert spec is not None
        assert spec.permission == "read"
        assert spec.allowed_purposes == ("aml.cdd.onboarding", "x-acme-bank.kyb_refresh")
        assert spec.caps == ToolCaps(per_day=500, per_case=3)
        assert spec.cost_units == {"base": 5}

    def test_unknown_key_is_rejected_at_load_with_a_clear_error(self, tmp_path: Path) -> None:
        p = tmp_path / "acme_kyb.json"
        p.write_text(
            json.dumps(
                {
                    "connector": "acme_kyb",
                    "tools": {"verify_business": {"permission": "read", "max_calls": 5}},
                }
            ),
            encoding="utf-8",
        )
        with pytest.raises(ManifestValidationError) as exc:
            ToolManifest.from_file(str(p))
        assert str(exc.value) == (
            'ToolManifest: tools.verify_business: unknown key "max_calls" '
            "(allowed: permission, allowed_purposes, caps, cost_units, "
            "requires_decision, four_eyes_on, decision_fields)"
        )

    def test_manifest_declaring_requires_decision_on_a_read_tool_is_rejected(self) -> None:
        with pytest.raises(ManifestValidationError, match="requires_decision is not allowed on a tool with read permission"):
            ToolManifest(
                connector="acme_kyb",
                tools={"resolve_business": {"permission": "read", "requires_decision": True}},
            )

    def test_schema_is_published_as_json_schema_2020_12(self) -> None:
        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
        assert schema["$id"] == "https://grantex.dev/spec/manifest-0.6.schema.json"
        Draft202012Validator.check_schema(schema)


# ── Schema and loader agree on the shared fixtures ──────────────────────────


@pytest.mark.parametrize("path", VALID_FILES, ids=[p.name for p in VALID_FILES])
def test_example_manifest_validates_against_schema(
    path: Path, validator: Draft202012Validator
) -> None:
    errors = list(validator.iter_errors(json.loads(path.read_text(encoding="utf-8"))))
    assert errors == []


@pytest.mark.parametrize("path", VALID_FILES, ids=[p.name for p in VALID_FILES])
def test_example_manifest_loads(path: Path) -> None:
    m = ToolManifest.from_file(str(path))
    assert m.connector == "acme_kyb"
    assert m.tool_count >= 1


@pytest.mark.parametrize("case", INVALID_CASES, ids=[c["name"] for c in INVALID_CASES])
def test_invalid_manifest_is_rejected_by_schema(
    case: Dict[str, Any], validator: Draft202012Validator
) -> None:
    assert list(validator.iter_errors(case["manifest"])) != []


@pytest.mark.parametrize("case", INVALID_CASES, ids=[c["name"] for c in INVALID_CASES])
def test_invalid_manifest_is_rejected_by_loader(case: Dict[str, Any]) -> None:
    with pytest.raises(ValueError) as exc:
        ToolManifest.from_dict(case["manifest"])
    assert case["error"] in str(exc.value)


def test_rendered_manifest_validates_against_schema_and_round_trips(
    validator: Draft202012Validator,
) -> None:
    m = ToolManifest.from_file(str(_acme_kyb_path()))
    rendered = m.to_dict()
    assert list(validator.iter_errors(rendered)) == []
    again = ToolManifest.from_dict(rendered)
    for name in m.tools:
        assert again.get_tool_spec(name) == m.get_tool_spec(name)


def test_prebuilt_manifests_are_valid_0_6_documents(validator: Draft202012Validator) -> None:
    import grantex.manifests as prebuilt

    manifests = [v for v in vars(prebuilt).values() if isinstance(v, ToolManifest)]
    assert manifests
    for m in manifests:
        assert list(validator.iter_errors(m.to_dict())) == [], m.connector


# ── Object form details ─────────────────────────────────────────────────────


class TestToolSpec:
    def test_acme_kyb_example_parses_every_field(self) -> None:
        m = ToolManifest.from_file(str(_acme_kyb_path()))
        assert m.tools == {
            "resolve_business": "read",
            "verify_business": "read",
            "screen_person": "read",
            "monitor_enroll": "write",
            "monitor_delete": "delete",
            "case_decision": "write",
        }
        assert m.get_tool_spec("verify_business") == ToolSpec(
            permission="read",
            allowed_purposes=("aml.cdd.*",),
            caps=ToolCaps(per_hour=50, per_case=3),
            cost_units={"base": 5, "ownership": 10, "web_insights": 3},
        )
        assert m.get_tool_spec("case_decision") == ToolSpec(
            permission="write", requires_decision=True, four_eyes_on=("decline",)
        )
        assert m.get_tool_spec("monitor_delete") == ToolSpec(
            permission="delete", requires_decision=True
        )
        assert m.get_tool_spec("missing") is None

    def test_cap_of_zero_is_accepted(self) -> None:
        m = ToolManifest(
            connector="acme_kyb",
            tools={"verify_business": {"permission": "read", "caps": {"per_hour": 0}}},
        )
        spec = m.get_tool_spec("verify_business")
        assert spec is not None and spec.caps == ToolCaps(per_hour=0)

    def test_integral_float_cap_is_accepted_as_integer(self) -> None:
        m = ToolManifest.from_dict(
            {"connector": "acme_kyb", "tools": {"verify_business": {"permission": "read", "caps": {"per_case": 3.0}}}}
        )
        spec = m.get_tool_spec("verify_business")
        assert spec is not None and spec.caps is not None
        assert spec.caps.per_case == 3 and isinstance(spec.caps.per_case, int)

    def test_requires_decision_false_on_read_tool_is_accepted(self) -> None:
        m = ToolManifest(
            connector="acme_kyb",
            tools={"get_case": {"permission": "read", "requires_decision": False}},
        )
        assert m.get_tool_spec("get_case") == ToolSpec(permission="read")

    def test_validation_error_is_a_value_error(self) -> None:
        assert issubclass(ManifestValidationError, ValueError)

    def test_add_tool_accepts_object_form(self) -> None:
        m = ToolManifest(connector="acme_kyb", tools={"get_case": Permission.READ})
        m.add_tool("case_decision", {"permission": "write", "requires_decision": True})
        assert m.get_permission("case_decision") == "write"
        spec = m.get_tool_spec("case_decision")
        assert spec is not None and spec.requires_decision is True

    def test_add_tool_rejects_invalid_object(self) -> None:
        m = ToolManifest(connector="acme_kyb", tools={"get_case": Permission.READ})
        with pytest.raises(ManifestValidationError, match='unknown key "cap"'):
            m.add_tool("verify_business", {"permission": "read", "cap": 1})

    def test_add_tool_with_string_replaces_the_whole_declaration(self) -> None:
        m = ToolManifest(
            connector="acme_kyb",
            tools={"verify_business": {"permission": "read", "caps": {"per_hour": 5}}},
        )
        m.add_tool("verify_business", Permission.WRITE)
        assert m.get_tool_spec("verify_business") == ToolSpec(permission="write")

    def test_editing_tools_directly_keeps_constraints(self) -> None:
        m = ToolManifest(
            connector="acme_kyb",
            tools={"verify_business": {"permission": "read", "allowed_purposes": ["aml.cdd.*"]}},
        )
        m.tools["verify_business"] = Permission.WRITE
        spec = m.get_tool_spec("verify_business")
        assert spec is not None
        assert spec.permission == "write"
        assert spec.allowed_purposes == ("aml.cdd.*",)

    def test_editing_tools_into_a_forbidden_combination_raises(self) -> None:
        m = ToolManifest(
            connector="acme_kyb",
            tools={"case_decision": {"permission": "write", "requires_decision": True}},
        )
        m.tools["case_decision"] = Permission.READ
        with pytest.raises(ManifestValidationError):
            m.get_tool_spec("case_decision")

    def test_tool_spec_instances_are_accepted(self) -> None:
        spec = ToolSpec(permission="write", caps=ToolCaps(per_case=2))
        m = ToolManifest(connector="acme_kyb", tools={"monitor_enroll": spec})
        assert m.get_tool_spec("monitor_enroll") == spec

    def test_invalid_tool_spec_instance_is_rejected(self) -> None:
        with pytest.raises(ManifestValidationError, match="requires_decision is not allowed"):
            ToolManifest(
                connector="acme_kyb",
                tools={"get_case": ToolSpec(permission="read", requires_decision=True)},
            )

    def test_non_object_json_file_is_rejected(self, tmp_path: Path) -> None:
        p = tmp_path / "list.json"
        p.write_text("[]", encoding="utf-8")
        with pytest.raises(ManifestValidationError, match="a manifest must be a JSON object"):
            ToolManifest.from_file(str(p))

    def test_schema_key_of_the_wrong_type_is_rejected(self) -> None:
        with pytest.raises(ManifestValidationError, match=r"\$schema: must be a string"):
            ToolManifest.from_dict({"$schema": 1, "connector": "acme_kyb", "tools": {"get_case": "read"}})

    def test_schema_key_opts_a_strings_only_manifest_into_strict_loading(self) -> None:
        with pytest.raises(ManifestValidationError, match='unknown top-level key "owner"'):
            ToolManifest.from_dict(
                {
                    "$schema": "https://grantex.dev/spec/manifest-0.6.schema.json",
                    "connector": "acme_kyb",
                    "owner": "team",
                    "tools": {"get_case": "read"},
                }
            )


# ── Existing callers ─────────────────────────────────────────────────────────


class TestStringsOnlyManifestsKeepPre06Behaviour:
    def test_unknown_top_level_key_warns_instead_of_failing(self) -> None:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            m = ToolManifest.from_dict(
                {"connector": "acme_kyb", "owner": "team", "tools": {"get_case": "read"}}
            )
        assert m.get_permission("get_case") == "read"
        assert any(
            issubclass(w.category, DeprecationWarning) and 'unknown top-level key "owner"' in str(w.message)
            for w in caught
        )

    def test_unusual_names_still_load_without_object_form(self) -> None:
        m = ToolManifest(connector="acme kyb", tools={"screen:person": Permission.READ})
        assert m.get_permission("screen:person") == "read"

    def test_string_tools_have_unconstrained_specs(self) -> None:
        m = ToolManifest(connector="acme_kyb", tools={"get_case": Permission.READ})
        assert m.get_tool_spec("get_case") == ToolSpec(permission="read")


DUPLICATE_FILES = sorted((EXAMPLES_DIR / "duplicate-keys").glob("*.json"))
EXPECTED_DUPLICATES = {
    "duplicate-tool.json": "case_decision",
    "duplicate-nested-key.json": "per_hour",
    "duplicate-escaped-key.json": "connector",
}


@pytest.mark.parametrize("path", DUPLICATE_FILES, ids=[p.name for p in DUPLICATE_FILES])
def test_duplicate_keys_in_a_manifest_file_are_rejected(path: Path) -> None:
    with pytest.raises(ManifestValidationError) as exc:
        ToolManifest.from_file(str(path))
    assert str(exc.value) == f'ToolManifest: duplicate key "{EXPECTED_DUPLICATES[path.name]}" in manifest file'


def test_duplicate_fixture_set_is_complete() -> None:
    assert sorted(p.name for p in DUPLICATE_FILES) == sorted(EXPECTED_DUPLICATES)


def test_duplicate_keys_in_a_yaml_manifest_are_rejected(tmp_path: Path) -> None:
    pytest.importorskip("yaml")
    p = tmp_path / "acme_kyb.yaml"
    p.write_text("connector: acme_kyb\ntools:\n  get_case: read\n  get_case: admin\n", encoding="utf-8")
    with pytest.raises(ManifestValidationError, match='duplicate key "get_case"'):
        ToolManifest.from_file(str(p))
    ok = tmp_path / "ok.yaml"
    ok.write_text("connector: acme_kyb\ntools:\n  get_case: read\n", encoding="utf-8")
    assert ToolManifest.from_file(str(ok)).get_permission("get_case") == "read"


def test_load_manifests_from_dir_rejects_duplicate_keys(tmp_path: Path) -> None:
    from grantex import Grantex

    (tmp_path / "dup.json").write_text((EXAMPLES_DIR / "duplicate-keys" / "duplicate-tool.json").read_text(encoding="utf-8"), encoding="utf-8")
    with pytest.raises(ManifestValidationError, match="duplicate key"):
        Grantex(api_key="test-key").load_manifests_from_dir(str(tmp_path))


def test_a_tool_named_proto_round_trips() -> None:
    m = ToolManifest.from_dict({"connector": "acme_kyb", "tools": {"__proto__": {"permission": "read", "caps": {"per_hour": 1}}}})
    again = ToolManifest.from_dict(json.loads(json.dumps(m.to_dict())))
    assert again.get_tool_spec("__proto__") == m.get_tool_spec("__proto__")

