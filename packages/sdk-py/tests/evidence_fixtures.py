"""Shared evidence package fixtures (spec/examples/evidence/).

``python -m tests.evidence_fixtures`` (from packages/sdk-py) regenerates every
fixture except ``evidence-package-signed.json`` and ``jwks.json`` unless
``--signed`` is passed, because a signed package needs a fresh key whose
private half is discarded. ``test_fixtures_are_current`` fails when the
committed fixtures differ from what this module produces.

All data is synthetic: invented identifiers, reserved-range company numbers,
``example.com`` hosts and the ``mock`` provider.
"""

from __future__ import annotations

import copy
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional

from grantex.evidence import (
    IDENTIFIER_CLASSES,
    PrivacySettings,
    action_reference,
    anchor_audit_entry,
    attach_anchor,
    attach_signature,
    audit_entry_hash,
    build_package,
    case_key,
    chain_root,
    decision_action_hash,
    entry_hash,
    header_hash,
    keyed_content_digest,
    pseudonymise,
    serialize_package,
    sign_root,
    verify_package,
)

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "spec" / "examples" / "evidence"

KEY_SEED = "grantex evidence example pseudonymisation key"
KEY_ID = "example-key-1"
CASE_ID = "case_demo_0001"
TENANT_ID = "dev_demo_0001"


def example_key() -> bytes:
    return hashlib.sha256(KEY_SEED.encode("utf-8")).digest()


def _digest(label: str) -> str:
    return "sha256:" + hashlib.sha256(label.encode("utf-8")).hexdigest()


def _later(ts: str, ms: int) -> str:
    """``ts`` plus ``ms`` milliseconds (fixture times stay within one minute)."""
    seconds = int(ts[17:19]) * 1000 + int(ts[20:23]) + ms
    minute = int(ts[14:16]) + seconds // 60000
    seconds %= 60000
    return f"{ts[:14]}{minute:02d}:{seconds // 1000:02d}.{seconds % 1000:03d}Z"


def _tenant(at: str, delay_ms: int = 200, late: bool = False) -> Dict[str, Any]:
    source: Dict[str, Any] = {"authority": "tenant", "recorded_at": _later(at, delay_ms)}
    if late:
        source["late"] = True
    return source


def _platform(at: str) -> Dict[str, Any]:
    return {"authority": "platform", "recorded_at": at}


def case_input() -> Dict[str, Any]:
    grant_tools = {
        "type": "urn:grantex:tools:v1",
        "connector": "acme_kyb",
        "purpose": "aml.cdd.onboarding",
        "data_region": "eu",
        "tools": ["resolve_business", "verify_business", "ownership", "screen_*", "web_presence", "case_decision"],
        "caps": {"verify_business": {"per_hour": 50, "per_case": 3}, "cost_units": {"per_day": 5000}},
    }
    leaf_tools = dict(grant_tools)
    leaf_tools["tools"] = ["resolve_business", "verify_business", "ownership", "screen_person", "web_presence", "case_decision"]
    leaf_tools["caps"] = {"verify_business": {"per_case": 3}, "screen_person": {"per_case": 25}}

    def call(at: str, call_id: str, tool: str, records: List[Dict[str, Any]], *, outcome: str = "allowed", cost: Optional[int] = None, late: bool = False) -> Dict[str, Any]:
        data: Dict[str, Any] = {
            "call_id": call_id,
            "connector": "acme_kyb",
            "grant_id": "grnt_demo_leaf",
            "input_hash": _digest(f"input:{call_id}"),
            "outcome": outcome,
            "output_hash": _digest(f"output:{call_id}") if outcome == "allowed" else None,
            "provider": "mock",
            "purpose": "aml.cdd.onboarding",
            "run_id": "run_demo_0001",
            "started_at": at,
            "tool": tool,
            "upstream_records": records,
        }
        if outcome == "allowed":
            data["completed_at"] = _later(at, 150)
        if outcome == "denied":
            data["denial"] = {"reason": "decision_required"}
        if cost is not None:
            data["cost_units"] = cost
        return {"type": "tool_call", "at": at, "source": _tenant(at, late=late), "data": data}

    def record(record_id: str, record_type: str, at: str) -> Dict[str, Any]:
        return {"record_id": record_id, "record_type": record_type, "retrieved_at": at}

    def ref(call_id: str, record_id: str, at: str, field: str, excerpt: Optional[str] = None) -> Dict[str, Any]:
        out = {"call_id": call_id, "field": field, "provider": "mock", "record_id": record_id, "retrieved_at": at}
        if excerpt:
            out["excerpt_ref"] = excerpt
        return out

    t_resolve = "2026-09-14T09:05:01.000Z"
    t_verify = "2026-09-14T09:05:03.000Z"
    t_owner = "2026-09-14T09:05:07.000Z"
    t_screen = "2026-09-14T09:05:09.000Z"
    action = {"action": "case_decision", "case_id": CASE_ID, "decision": "decline", "subject": "gb:00000001"}
    action_hash = decision_action_hash(action)

    entries: List[Dict[str, Any]] = [
        {
            "type": "grant",
            "at": "2026-09-14T09:00:00.000Z",
            "source": _platform("2026-09-14T09:00:00.000Z"),
            "data": {
                "agent_id": "ag_demo_orchestrator", "authorization_details": [grant_tools], "depth": 0,
                "expires_at": "2026-09-15T09:00:00.000Z", "grant_id": "grnt_demo_root", "issued_at": "2026-09-14T09:00:00.000Z",
                "parent_grant_id": None, "principal": "user:underwriting-team", "purpose": "aml.cdd.onboarding",
                "revoked_at": None, "scopes": ["tool:acme_kyb:read", "tool:acme_kyb:write"], "status": "active",
            },
        },
        {
            "type": "grant",
            "at": "2026-09-14T09:01:00.000Z",
            "source": _platform("2026-09-14T09:01:00.000Z"),
            "data": {
                "agent_id": "ag_demo_underwriter", "authorization_details": [leaf_tools], "depth": 1,
                "expires_at": "2026-09-15T09:00:00.000Z", "grant_id": "grnt_demo_leaf", "issued_at": "2026-09-14T09:01:00.000Z",
                "parent_grant_id": "grnt_demo_root", "principal": "user:underwriting-team", "purpose": "aml.cdd.onboarding",
                "revoked_at": "2026-09-14T10:00:00.000Z", "scopes": ["tool:acme_kyb:read", "tool:acme_kyb:write"], "status": "revoked",
            },
        },
        {
            "type": "run_context",
            "at": "2026-09-14T09:05:00.000Z",
            "source": _tenant("2026-09-14T09:05:00.000Z"),
            "data": {
                "agent_id": "ag_demo_underwriter",
                "model": {"name": "stub-model", "provider": "model-stub", "version": "2026-09-01"},
                "policies": [{"digest": _digest("policy:business_onboarding_uk:1.2.0"), "id": "business_onboarding_uk", "version": "1.2.0"}],
                "prompts": [{"digest": _digest("prompt:business_underwriter:1.0.0"), "id": "business_underwriter", "version": "1.0.0"}],
                "run_id": "run_demo_0001",
                "schemas": [{"id": "policy_result", "version": "1.0.0"}, {"id": "underwriting_memo", "version": "1.0.0"}],
            },
        },
        call(t_resolve, "call_0001", "resolve_business", [record("mock:registry:00000001", "registry_entry", t_resolve)], cost=1),
        call(t_verify, "call_0002", "verify_business", [record("mock:verification:v-0001", "business_verification", t_verify), record("mock:officers:00000001", "officer_list", t_verify)], cost=5),
        call(t_owner, "call_0003", "ownership", [record("mock:ownership:g-0001", "ownership_graph", t_owner)], cost=10),
        call(t_screen, "call_0004", "screen_person", [record("mock:screening:hit-0001", "screening_hit", t_screen)], cost=2),
        call("2026-09-14T09:05:09.500Z", "call_0009", "web_presence", [], outcome="error"),
        {
            "type": "void",
            "at": "2026-09-14T09:05:09.800Z",
            "source": _tenant("2026-09-14T09:05:09.800Z"),
            "data": {"reason_code": "recorded_in_error", "target_id": "call_0009", "target_type": "tool_call", "voided_at": "2026-09-14T09:05:09.800Z"},
        },
        {
            "type": "disposition",
            "at": "2026-09-14T09:05:09.900Z",
            "source": _tenant("2026-09-14T09:05:09.900Z"),
            "data": {
                "comparisons": [
                    {"evidence": [ref("call_0004", "mock:screening:hit-0001", t_screen, "name")], "identifier": "name", "result": "partial"},
                    {"evidence": [ref("call_0004", "mock:screening:hit-0001", t_screen, "date_of_birth")], "identifier": "date_of_birth", "result": "mismatch"},
                    {"evidence": [], "identifier": "nationality", "result": "not_available"},
                ],
                "confidence_band": "high",
                "disposition_id": "disp_0001",
                "hit": ref("call_0004", "mock:screening:hit-0001", t_screen, "hit"),
                "outcome": "false_positive",
                "rationale_digest": _digest("rationale:disp_0001"),
                "run_id": "run_demo_0001",
            },
        },
        {
            "type": "policy_evaluation",
            "at": "2026-09-14T09:05:10.000Z",
            "source": _tenant("2026-09-14T09:05:10.000Z"),
            "data": {
                "evaluation_id": "eval_0001",
                "fired_rules": [{"reason_code": "ownership_not_reconciled", "reason_digest": _digest("reason:ownership_reconciled"), "rule_id": "ownership_reconciled", "tier": "medium"}],
                "inputs": [
                    {"evidence": [ref("call_0002", "mock:verification:v-0001", t_verify, "status")], "path": "verification.status", "value": "active"},
                    {"evidence": [ref("call_0003", "mock:ownership:g-0001", t_owner, "owners")], "path": "ownership.missing_owners", "value": 1},
                    {"evidence": [ref("call_0004", "mock:screening:hit-0001", t_screen, "disposition")], "path": "screening.unresolved_true_matches", "value": 0},
                    {"evidence": [], "path": "application.declared_owner_count", "unsourced": True, "value": 2},
                ],
                "policy": {"digest": _digest("policy:business_onboarding_uk:1.2.0"), "id": "business_onboarding_uk", "version": "1.2.0"},
                "run_id": "run_demo_0001",
                "score": 40.5,
                "tier": "medium",
            },
        },
        {
            "type": "recommendation",
            "at": "2026-09-14T09:05:11.000Z",
            "source": _tenant("2026-09-14T09:05:11.000Z"),
            "data": {
                "evaluation_ids": ["eval_0001"],
                "memo_digest": _digest("memo:case_demo_0001:1"),
                "missing_items": ["declared_owner_evidence"],
                "outcome": "refer",
                "recommendation_id": "rec_0001",
                "run_id": "run_demo_0001",
                "sections": [
                    {"evidence": [ref("call_0001", "mock:registry:00000001", t_resolve, "status")], "section": "registry", "status": "complete"},
                    {"evidence": [ref("call_0002", "mock:officers:00000001", t_verify, "officers")], "section": "verification", "status": "complete"},
                    {"evidence": [ref("call_0003", "mock:ownership:g-0001", t_owner, "owners")], "section": "ownership", "status": "issues_found"},
                    {"evidence": [ref("call_0004", "mock:screening:hit-0001", t_screen, "aliases", "excerpt_0001")], "section": "screening", "status": "complete"},
                    {"evidence": [], "section": "web_presence", "status": "not_available"},
                ],
            },
        },
        call("2026-09-14T09:06:00.000Z", "call_0005", "case_decision", [], outcome="denied"),
        {
            "type": "decision",
            "at": "2026-09-14T09:20:00.000Z",
            "source": _platform("2026-09-14T09:20:00.000Z"),
            "data": {
                "action": copy.deepcopy(action), "action_hash": action_hash, "approval_position": 1, "approvals_required": 2,
                "approver": "user:approver-a", "approver_auth": "sso+webauthn", "dwell_ms": 61250,
                "expires_at": "2026-09-15T09:20:00.000Z", "issued_at": "2026-09-14T09:20:00.000Z",
                "issuer": "https://auth.example.com", "jti": "dgnt_demo_0001", "request_id": "dreq_demo_0001",
            },
        },
        {
            "type": "decision",
            "at": "2026-09-14T09:31:00.000Z",
            "source": _platform("2026-09-14T09:31:00.000Z"),
            "data": {
                "action": copy.deepcopy(action), "action_hash": action_hash, "approval_position": 2, "approvals_required": 2,
                "approver": "user:approver-b", "approver_auth": "sso+webauthn", "dwell_ms": 48020,
                "expires_at": "2026-09-15T09:31:00.000Z", "first_jti": "dgnt_demo_0001", "issued_at": "2026-09-14T09:31:00.000Z",
                "issuer": "https://auth.example.com", "jti": "dgnt_demo_0002", "request_id": "dreq_demo_0001",
            },
        },
        {
            "type": "decision_consumption",
            "at": "2026-09-14T09:31:05.000Z",
            "source": _platform("2026-09-14T09:31:05.000Z"),
            "data": {"action_hash": action_hash, "call_id": "call_0006", "consumed_at": "2026-09-14T09:31:05.000Z", "jtis": ["dgnt_demo_0001", "dgnt_demo_0002"]},
        },
        call("2026-09-14T09:31:05.000Z", "call_0006", "case_decision", [], late=True),
        {
            "type": "revocation",
            "at": "2026-09-14T10:00:00.000Z",
            "source": _platform("2026-09-14T10:00:00.000Z"),
            "data": {"cascade": False, "event_id": "evt_demo_0001", "grant_id": "grnt_demo_leaf", "reason": "provider_event", "revoked_at": "2026-09-14T10:00:00.000Z", "trigger": "event"},
        },
    ]
    return {
        "case": {
            "case_id": CASE_ID,
            "exported_at": "2026-09-14T10:30:00.000Z",
            "issuer": "https://auth.example.com",
            "state": "decided",
            "subject": "gb:00000001",
            "tenant_id": TENANT_ID,
        },
        "privacy": {"disclosed": [], "key_id": KEY_ID, "key_seed": KEY_SEED},
        "entries": entries,
    }


def privacy_settings(spec: Mapping[str, Any]) -> PrivacySettings:
    seed = spec.get("key_seed")
    return PrivacySettings(
        key=hashlib.sha256(seed.encode("utf-8")).digest() if isinstance(seed, str) else None,
        key_id=spec.get("key_id"),
        disclosed=frozenset(spec.get("disclosed", [])),
    )


ANCHOR = {
    "audit_entry_id": "alog_demo_0099",
    "timestamp": "2026-09-14T10:30:00.123Z",
    "prev_hash": hashlib.sha256(b"alog_demo_0098").hexdigest(),
}

# Entry positions in the fixture packages, used by the invalid cases.
I_RUN, I_CALL1, I_CALL2, I_CALL3, I_CALL4, I_ERROR, I_VOID, I_DISP, I_EVAL, I_REC, I_DENIED, I_DEC1, I_DEC2, I_CONS, I_LATE, I_REVOKE = range(2, 18)


def packages() -> Dict[str, Dict[str, Any]]:
    source = case_input()
    built = build_package(case=source["case"], entries=source["entries"], privacy=privacy_settings(source["privacy"]))
    anchored = attach_anchor(
        built.document,
        anchor_audit_entry(built.document, audit_entry_id=ANCHOR["audit_entry_id"], timestamp=ANCHOR["timestamp"], prev_hash=ANCHOR["prev_hash"]),
    )
    disclosed = build_package(case=source["case"], entries=source["entries"], privacy=PrivacySettings(disclosed=frozenset(IDENTIFIER_CLASSES)))
    return {"evidence-package.json": anchored, "evidence-package-disclosed.json": disclosed.document}


def _get_parent(document: Any, path: List[Any]) -> Any:
    node = document
    for key in path[:-1]:
        node = node[key]
    return node


def rehash_entry(document: Dict[str, Any], index: int) -> None:
    entry = document["entries"][index]
    entry["hash"] = entry_hash(entry)


def rehash_chain(document: Dict[str, Any]) -> None:
    previous = header_hash(document)
    document["chain"]["genesis"] = previous
    for seq, entry in enumerate(document["entries"]):
        entry["seq"] = seq
        entry["prev"] = previous
        entry["hash"] = entry_hash(entry)
        previous = entry["hash"]
    chain = document["chain"]
    chain["head"] = previous
    chain["length"] = len(document["entries"])
    chain["root"] = chain_root(chain)


def rehash_anchor(document: Dict[str, Any]) -> None:
    audit = document["anchor"]["audit_entry"]
    audit["hash"] = audit_entry_hash(audit)


def apply_case(case: Mapping[str, Any], fixtures: Mapping[str, bytes]) -> bytes:
    """Apply a mutation case to its base package; the TS tests implement the same operations."""
    data = fixtures[case["package"]]
    document = json.loads(data)
    raw: Optional[bytes] = None
    for mutation in case.get("mutations", []):
        op = mutation["op"]
        if op == "set":
            _get_parent(document, mutation["path"])[mutation["path"][-1]] = copy.deepcopy(mutation["value"])
        elif op == "delete":
            del _get_parent(document, mutation["path"])[mutation["path"][-1]]
        elif op == "insert":
            _get_parent(document, mutation["path"]).insert(mutation["path"][-1], copy.deepcopy(mutation["value"]))
        elif op == "copy_entry":
            document["entries"].insert(mutation["to"], copy.deepcopy(document["entries"][mutation["from"]]))
        elif op == "rehash_entry":
            rehash_entry(document, mutation["index"])
        elif op == "rehash_chain":
            rehash_chain(document)
        elif op == "rehash_anchor":
            rehash_anchor(document)
        elif op in ("raw_replace", "raw_prefix", "raw_truncate"):
            text = raw if raw is not None else serialize_package(document)
            if op == "raw_replace":
                find = mutation["find"].encode("utf-8")
                if find not in text:
                    raise AssertionError(f"{case['name']}: {mutation['find']!r} not found")
                raw = text.replace(find, mutation["replace"].encode("utf-8"), 1)
            elif op == "raw_prefix":
                raw = bytes.fromhex(mutation["hex"]) + text
            else:
                raw = text[: mutation["length"]]
        else:
            raise AssertionError(f"unknown op {op}")
    return raw if raw is not None else serialize_package(document)


def verify_options(case: Mapping[str, Any], expected: Mapping[str, Any], fixtures: Mapping[str, bytes]) -> Dict[str, Any]:
    options = dict(case.get("options", {}))
    base = expected[case["package"]]
    out: Dict[str, Any] = {"expected_root": base["root"]}
    if "expected_root" in options:
        out["expected_root"] = options.pop("expected_root")
    jwks = options.pop("jwks", None)
    if isinstance(jwks, str):
        out["jwks"] = json.loads(fixtures[jwks])
    elif jwks is not None:
        out["jwks"] = jwks
    out.update(options)
    return out


def invalid_cases() -> List[Dict[str, Any]]:
    e = ["entries"]
    P = "evidence-package.json"
    D = "evidence-package-disclosed.json"
    S = "evidence-package-signed.json"
    rehash = {"op": "rehash_chain"}
    return [
        {"name": "missing trusted root", "package": P, "options": {"expected_root": None}, "code": "missing_root"},
        {"name": "wrong trusted root", "package": P, "options": {"expected_root": "sha256:" + "0" * 64}, "code": "root_not_trusted"},
        {"name": "package larger than the limit", "package": P, "options": {"max_bytes": 1024}, "code": "too_large"},
        {"name": "byte-order mark", "package": P, "mutations": [{"op": "raw_prefix", "hex": "efbbbf"}], "code": "malformed_json"},
        {"name": "truncated", "package": P, "mutations": [{"op": "raw_truncate", "length": 200}], "code": "malformed_json"},
        {"name": "duplicate member", "package": P, "mutations": [{"op": "raw_replace", "find": "\"format\":\"grantex-evidence-package\"", "replace": "\"format\":\"grantex-evidence-package\",\"format\":\"grantex-evidence-package\""}], "code": "duplicate_key"},
        {"name": "whitespace", "package": P, "mutations": [{"op": "raw_replace", "find": "{\"anchor\"", "replace": "{ \"anchor\""}], "code": "non_canonical_document"},
        {"name": "number spelled 61250.0", "package": P, "mutations": [{"op": "raw_replace", "find": "\"dwell_ms\":61250", "replace": "\"dwell_ms\":61250.0"}], "code": "non_canonical_number"},
        {"name": "number spelled 6.125e4", "package": P, "mutations": [{"op": "raw_replace", "find": "\"dwell_ms\":61250", "replace": "\"dwell_ms\":6.125e4"}], "code": "non_canonical_number"},
        {"name": "integer beyond 2^53", "package": P, "mutations": [{"op": "raw_replace", "find": "\"dwell_ms\":61250", "replace": "\"dwell_ms\":9007199254740993"}], "code": "non_canonical_number"},
        {"name": "unknown format", "package": P, "mutations": [{"op": "set", "path": ["format"], "value": "other-package"}], "code": "unsupported_format"},
        {"name": "unknown version", "package": P, "mutations": [{"op": "set", "path": ["version"], "value": "1.1"}], "code": "unsupported_version"},
        {"name": "unknown top-level member", "package": P, "mutations": [{"op": "set", "path": ["extra"], "value": True}], "code": "schema_violation"},
        {"name": "missing chain root", "package": P, "mutations": [{"op": "delete", "path": ["chain", "root"]}], "code": "schema_violation"},
        {"name": "unknown tool call outcome", "package": P, "mutations": [{"op": "set", "path": e + [I_CALL1, "data", "outcome"], "value": "maybe"}], "code": "schema_violation"},
        {"name": "impossible calendar date", "package": P, "mutations": [{"op": "set", "path": e + [I_RUN, "at"], "value": "2026-02-30T09:05:00.000Z"}], "code": "schema_violation"},
        {"name": "entry without a source", "package": P, "mutations": [{"op": "delete", "path": e + [I_RUN, "source"]}], "code": "schema_violation"},
        {"name": "anchor not authored by the platform", "package": P, "mutations": [{"op": "set", "path": ["anchor", "audit_entry", "principalId"], "value": "user_01"}, {"op": "rehash_anchor"}], "code": "schema_violation"},
        {"name": "anchor without the platform marker", "package": P, "mutations": [{"op": "delete", "path": ["anchor", "audit_entry", "metadata", "grantex:platform"]}, {"op": "rehash_anchor"}], "code": "schema_violation"},
        {"name": "raw approver identifier while pseudonymised", "package": P, "mutations": [{"op": "set", "path": e + [I_DEC1, "data", "approver"], "value": "user:approver-a"}], "code": "privacy_violation"},
        {"name": "raw record identifier while pseudonymised", "package": P, "mutations": [{"op": "set", "path": e + [I_CALL1, "data", "upstream_records", 0, "record_id"], "value": "mock:registry:00000001"}], "code": "privacy_violation"},
        {"name": "unkeyed content digest while pseudonymised", "package": P, "mutations": [{"op": "set", "path": e + [I_CALL1, "data", "input_hash"], "value": "sha256:" + "0" * 64}], "code": "privacy_violation"},
        {"name": "unkeyed action hash beside a pseudonymised subject", "package": P, "mutations": [{"op": "set", "path": e + [I_DEC1, "data", "action_hash"], "value": "sha256:" + "A" * 43}], "code": "privacy_violation"},
        {"name": "header field edited", "package": P, "mutations": [{"op": "set", "path": ["case", "state"], "value": "open"}], "code": "genesis_mismatch"},
        {"name": "entry field edited", "package": P, "mutations": [{"op": "set", "path": e + [I_DEC1, "data", "dwell_ms"], "value": 61251}], "code": "entry_hash_mismatch"},
        {"name": "entry field edited and its hash recomputed", "package": P, "mutations": [{"op": "set", "path": e + [I_DEC1, "data", "dwell_ms"], "value": 61251}, {"op": "rehash_entry", "index": I_DEC1}], "code": "link_mismatch"},
        {"name": "sequence number edited", "package": P, "mutations": [{"op": "set", "path": e + [I_CALL2, "seq"], "value": 5}], "code": "sequence_mismatch"},
        {"name": "last entry edited and rehashed", "package": P, "mutations": [{"op": "set", "path": e + [I_REVOKE, "data", "reason"], "value": "manual"}, {"op": "rehash_entry", "index": I_REVOKE}], "code": "head_mismatch"},
        {"name": "chain length edited", "package": P, "mutations": [{"op": "set", "path": ["chain", "length"], "value": 17}], "code": "length_mismatch"},
        {"name": "chain root edited", "package": P, "mutations": [{"op": "set", "path": ["chain", "root"], "value": "sha256:" + "a" * 64}], "code": "root_mismatch"},
        {"name": "cost edited and whole chain rehashed", "package": P, "mutations": [{"op": "set", "path": e + [I_CALL2, "data", "cost_units"], "value": 0}, rehash], "code": "root_not_trusted"},
        {"name": "cited upstream record removed and chain rehashed", "package": P, "mutations": [{"op": "set", "path": e + [I_CALL3, "data", "upstream_records"], "value": []}, rehash], "code": "dangling_reference"},
        {"name": "citing a void tool call", "package": D, "mutations": [{"op": "set", "path": e + [I_DISP, "data", "hit", "call_id"], "value": "call_0009"}, rehash], "code": "dangling_reference"},
        {"name": "grant chain parent edited and rehashed", "package": P, "mutations": [{"op": "set", "path": e + [1, "data", "parent_grant_id"], "value": "grnt_other"}, rehash], "code": "grant_chain_broken"},
        {"name": "entries out of recording order", "package": P, "mutations": [{"op": "set", "path": e + [I_DENIED, "source", "recorded_at"], "value": "2026-09-14T09:05:10.500Z"}, rehash], "code": "entries_out_of_order"},
        {"name": "entry dated after it was recorded", "package": P, "mutations": [{"op": "set", "path": e + [I_CALL2, "at"], "value": "2026-09-14T09:20:00.000Z"}, rehash], "code": "validity_violation"},
        {"name": "allowed call after the grant expired", "package": P, "mutations": [{"op": "set", "path": e + [1, "data", "expires_at"], "value": "2026-09-14T09:25:00.000Z"}, rehash], "code": "validity_violation"},
        {"name": "tenant record after consumption not marked late", "package": P, "mutations": [{"op": "delete", "path": e + [I_LATE, "source", "late"]}, rehash], "code": "validity_violation"},
        {"name": "decision asserted by the tenant", "package": P, "mutations": [{"op": "set", "path": e + [I_DEC1, "source", "authority"], "value": "tenant"}, rehash], "code": "authority_violation"},
        {"name": "input cites evidence and is marked unsourced", "package": P, "mutations": [{"op": "set", "path": e + [I_EVAL, "data", "inputs", 0, "unsourced"], "value": True}, rehash], "code": "schema_violation"},
        {"name": "second approver made the first and rehashed", "package": D, "mutations": [{"op": "set", "path": e + [I_DEC2, "data", "approver"], "value": "user:approver-a"}, rehash], "code": "decision_inconsistent"},
        {"name": "decision action edited and rehashed", "package": D, "mutations": [{"op": "set", "path": e + [I_DEC1, "data", "action", "decision"], "value": "approve"}, rehash], "code": "action_hash_mismatch"},
        {"name": "decision for another case", "package": P, "mutations": [{"op": "set", "path": e + [I_DEC1, "data", "action", "case_id"], "value": "case_other"}, rehash], "code": "case_mismatch"},
        {"name": "decision subject differs from the case subject", "package": P, "mutations": [{"op": "set", "path": ["case", "subject"], "value": "pz:" + "A" * 43}, rehash], "code": "case_mismatch"},
        {"name": "consumption without every required approval", "package": P, "mutations": [{"op": "set", "path": e + [I_CONS, "data", "jtis"], "value": ["dgnt_demo_0002"]}, rehash], "code": "decision_inconsistent"},
        {"name": "decision grant consumed twice", "package": P, "mutations": [{"op": "copy_entry", "from": I_CONS, "to": I_CONS + 1}, rehash], "code": "decision_inconsistent"},
        {"name": "consumed after the decision grant expired", "package": P, "mutations": [{"op": "set", "path": e + [I_DEC1, "data", "expires_at"], "value": "2026-09-14T09:30:00.000Z"}, rehash], "code": "validity_violation"},
        {"name": "second approval paired with a second approval", "package": D, "mutations": [{"op": "copy_entry", "from": I_DEC2, "to": I_DEC2 + 1}, {"op": "set", "path": e + [I_DEC2 + 1, "data", "jti"], "value": "dgnt_demo_0003"}, {"op": "set", "path": e + [I_DEC2 + 1, "data", "approver"], "value": "user:approver-c"}, {"op": "set", "path": e + [I_DEC2 + 1, "data", "first_jti"], "value": "dgnt_demo_0002"}, rehash], "code": "decision_inconsistent"},
        {"name": "revocation time differs from the grant", "package": P, "mutations": [{"op": "set", "path": e + [I_REVOKE, "data", "revoked_at"], "value": "2026-09-14T09:59:00.000Z"}, rehash], "code": "validity_violation"},
        {"name": "denied call with output", "package": D, "mutations": [{"op": "set", "path": e + [I_DENIED, "data", "output_hash"], "value": "sha256:" + "b" * 64}, rehash], "code": "tool_call_inconsistent"},
        {"name": "duplicate call id", "package": D, "mutations": [{"op": "set", "path": e + [I_CALL2, "data", "call_id"], "value": "call_0001"}, rehash], "code": "duplicate_identifier"},
        {"name": "anchor audit entry edited", "package": P, "mutations": [{"op": "set", "path": ["anchor", "audit_entry", "timestamp"], "value": "2026-09-14T10:30:00.124Z"}], "code": "anchor_hash_mismatch"},
        {"name": "anchor records another root", "package": P, "mutations": [{"op": "set", "path": ["anchor", "audit_entry", "metadata", "package_root"], "value": "sha256:" + "c" * 64}, {"op": "rehash_anchor"}], "code": "anchor_mismatch"},
        {"name": "untrusted anchor", "package": P, "options": {"expected_anchor_hash": "d" * 64}, "code": "anchor_not_trusted"},
        {"name": "anchor required but absent", "package": D, "options": {"require_anchor": True}, "code": "anchor_missing"},
        {"name": "signature required but absent", "package": P, "options": {"require_signature": True}, "code": "signature_missing"},
        {"name": "signed package without a key set", "package": S, "code": "signature_unverified"},
        {"name": "signature from another key set", "package": S, "options": {"jwks": {"keys": []}}, "code": "signature_key_unknown"},
        {"name": "signature kid edited", "package": S, "options": {"jwks": "jwks.json"}, "mutations": [{"op": "set", "path": ["signature", "kid"], "value": "other-kid"}], "code": "signature_invalid"},
        {"name": "signature bytes edited", "package": S, "options": {"jwks": "jwks.json"}, "mutations": [{"op": "raw_replace", "find": "..", "replace": "..A"}], "code": "signature_invalid"},
        {"name": "signed anchor replaced", "package": S, "options": {"jwks": "jwks.json"}, "mutations": [{"op": "set", "path": ["anchor", "audit_entry", "timestamp"], "value": "2026-09-14T10:30:00.500Z"}, {"op": "rehash_anchor"}], "code": "signature_invalid"},
        {"name": "key with a null use", "package": S, "options": {"jwks": {"keys": [{"kid": "evidence-example-es256", "kty": "EC", "crv": "P-256", "use": None, "x": "AA", "y": "AA"}]}}, "code": "signature_invalid"},
    ]


def expected_roots(documents: Mapping[str, Dict[str, Any]]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for name, document in sorted(documents.items()):
        item: Dict[str, Any] = {"root": document["chain"]["root"], "entry_count": document["chain"]["length"]}
        if "anchor" in document:
            item["anchor_hash"] = document["anchor"]["audit_entry"]["hash"]
        out[name] = item
    return out


def pseudonym_vectors() -> Dict[str, Any]:
    key = example_key()
    unicode_subject = "Soci" + chr(0xE9) + "t" + chr(0xE9) + " Exemple " + chr(0x4F8B)
    identifiers = []
    for tenant, case, cls, value in (
        (TENANT_ID, CASE_ID, "approver", "user:approver-a"),
        (TENANT_ID, CASE_ID, "principal", "user:approver-a"),
        (TENANT_ID, "case_demo_0002", "approver", "user:approver-a"),
        ("dev_demo_0002", CASE_ID, "approver", "user:approver-a"),
        (TENANT_ID, CASE_ID, "subject", "gb:00000001"),
        (TENANT_ID, CASE_ID, "subject", unicode_subject),
        (TENANT_ID, CASE_ID, "record", "mock:registry:00000001"),
        ("dev_demo_0001:case", "demo_0001", "record", "mock:registry:00000001"),
    ):
        identifiers.append({"case_id": case, "class": cls, "pseudonym": pseudonymise(key, tenant, case, cls, value), "tenant_id": tenant, "value": value})
    ck = case_key(key, TENANT_ID, CASE_ID)
    content = {"case_id": CASE_ID, "digest": _digest("input:call_0001"), "keyed": keyed_content_digest(ck, _digest("input:call_0001")), "tenant_id": TENANT_ID}
    action = {"action": "case_decision", "case_id": CASE_ID, "decision": "decline", "subject": "gb:00000001"}
    action_hash = decision_action_hash(action)
    actions = {"action_hash": action_hash, "action_ref": action_reference(ck, action_hash), "case_id": CASE_ID, "tenant_id": TENANT_ID}
    return {
        "key_seed": KEY_SEED,
        "key_derivation": "tenant key = SHA-256 of the UTF-8 key_seed; case key = HMAC-SHA256(tenant key, JCS([\"grantex-evidence-case-v1\", tenant_id, case_id]))",
        "identifiers": identifiers,
        "content": content,
        "action": actions,
    }


def _json_file(value: Any) -> bytes:
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def render(signed: Optional[Mapping[str, bytes]] = None) -> Dict[str, bytes]:
    """Every fixture file's bytes. ``signed`` supplies the signed package and JWKS."""
    documents = packages()
    files: Dict[str, bytes] = {name: serialize_package(doc) for name, doc in documents.items()}
    if signed is None:
        signed = {name: (FIXTURES / name).read_bytes() for name in ("evidence-package-signed.json", "jwks.json")}
    files.update(signed)
    documents["evidence-package-signed.json"] = json.loads(files["evidence-package-signed.json"])
    files["case-input.json"] = _json_file(case_input())
    files["pseudonyms.json"] = _json_file(pseudonym_vectors())
    expected = expected_roots(documents)
    files["expected.json"] = _json_file(expected)

    results = []
    for case in invalid_cases():
        data = apply_case(case, files)
        result = verify_package(data, **verify_options(case, expected, files))
        if result.code != case["code"]:
            raise AssertionError(f"{case['name']}: expected {case['code']}, got {result.code}: {result.message} at {result.field_path}")
        item = {key: value for key, value in case.items() if key != "code"}
        item["expect"] = {"code": result.code, "entry_index": result.entry_index, "field_path": result.field_path, "expected": result.expected, "actual": result.actual}
        results.append(item)
    files["invalid-cases.json"] = _json_file(
        {
            "description": "Mutations of the fixture packages and the failure every verifier must report. Apply 'mutations' in order to the parsed base package (raw_* operate on its canonical bytes; insert and copy_entry insert into a list), verify with the base package's root from expected.json unless 'options' overrides it, and compare 'expect'.",
            "cases": results,
        }
    )
    return files


def make_signed() -> Dict[str, bytes]:
    import base64

    from cryptography.hazmat.primitives.asymmetric import ec

    document = packages()["evidence-package.json"]
    key = ec.generate_private_key(ec.SECP256R1())
    kid = "evidence-example-es256"
    anchor_hash = document["anchor"]["audit_entry"]["hash"]
    signed = attach_signature(document, sign_root(document["chain"]["root"], key, kid, anchor_hash))
    numbers = key.public_key().public_numbers()

    def b64(n: int) -> str:
        return base64.urlsafe_b64encode(n.to_bytes(32, "big")).rstrip(b"=").decode("ascii")

    jwks = {"keys": [{"alg": "ES256", "crv": "P-256", "kid": kid, "kty": "EC", "use": "sig", "x": b64(numbers.x), "y": b64(numbers.y)}]}
    return {"evidence-package-signed.json": serialize_package(signed), "jwks.json": _json_file(jwks)}


def main(argv: List[str]) -> None:
    signed = make_signed() if "--signed" in argv else None
    FIXTURES.mkdir(parents=True, exist_ok=True)
    for name, data in render(signed).items():
        (FIXTURES / name).write_bytes(data)
        print(f"wrote {name}")


if __name__ == "__main__":
    main(sys.argv[1:])
