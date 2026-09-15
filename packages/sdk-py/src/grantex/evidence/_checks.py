"""Privacy, hash-chain and cross-entry checks on a parsed evidence package.

Each check raises :class:`VerificationFailure` at the first problem it finds.
The order of checks, and the order within each, is part of the specification
(spec/evidence-package.md, "Verification") so every implementation reports the
same failure. The TypeScript SDK mirrors this module in ``checks.ts``.
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional, Set, Tuple

from ._hashing import (
    IDENTIFIER_CLASSES,
    chain_root,
    decision_action_hash,
    entry_hash,
    header_hash,
    is_action_reference,
    is_pseudonym,
)
from ._result import VerificationCode as Code
from ._result import VerificationFailure
from ._schema import timestamp_ms

__all__ = ["check_privacy", "check_chain", "check_semantics", "SemanticSummary", "MAX_CLOCK_SKEW_MS"]

MAX_CLOCK_SKEW_MS = 300_000
"""Tolerated difference between producer clocks and the recording service (5 minutes)."""

PLATFORM_TYPES = frozenset({"grant", "decision", "decision_consumption", "revocation"})
_ID_FIELDS = {
    "run_context": "run_id",
    "tool_call": "call_id",
    "policy_evaluation": "evaluation_id",
    "recommendation": "recommendation_id",
    "disposition": "disposition_id",
}


def _entry_path(index: int, rest: str = "") -> str:
    return f"entries[{index}]" + (f".{rest}" if rest else "")


def _fail(code: str, message: str, index: Optional[int], path: str, expected: Optional[str] = None, actual: Optional[str] = None) -> VerificationFailure:
    return VerificationFailure(code, message, entry_index=index, field_path=path, expected=expected, actual=actual)


# ── Privacy ───────────────────────────────────────────────────────────────


def _evidence_refs(data: Mapping[str, Any], kind: str) -> List[Tuple[str, Mapping[str, Any]]]:
    """Evidence references of an entry, in the order the checks visit them."""
    refs: List[Tuple[str, Mapping[str, Any]]] = []
    if kind == "policy_evaluation":
        for i, item in enumerate(data["inputs"]):
            refs.extend((f"data.inputs[{i}].evidence[{j}]", ref) for j, ref in enumerate(item["evidence"]))
    elif kind == "recommendation":
        for i, section in enumerate(data["sections"]):
            refs.extend((f"data.sections[{i}].evidence[{j}]", ref) for j, ref in enumerate(section["evidence"]))
    elif kind == "disposition":
        for i, comparison in enumerate(data["comparisons"]):
            refs.extend((f"data.comparisons[{i}].evidence[{j}]", ref) for j, ref in enumerate(comparison["evidence"]))
        refs.append(("data.hit", data["hit"]))
    return refs


def check_privacy(package: Mapping[str, Any]) -> None:
    privacy = package["privacy"]
    disclosed: List[str] = privacy["disclosed"]
    if disclosed != sorted(disclosed):
        raise _fail(Code.PRIVACY_VIOLATION, "privacy.disclosed must be sorted", None, "privacy.disclosed")
    everything = list(IDENTIFIER_CLASSES)
    if privacy["scheme"] == "none":
        if disclosed != everything:
            raise _fail(Code.PRIVACY_VIOLATION, "scheme none requires every class to be disclosed", None, "privacy.disclosed")
        if "key_id" in privacy:
            raise _fail(Code.PRIVACY_VIOLATION, "scheme none has no key_id", None, "privacy.key_id")
    else:
        if "key_id" not in privacy:
            raise _fail(Code.PRIVACY_VIOLATION, "a pseudonymisation scheme requires key_id", None, "privacy.key_id")
        if disclosed == everything:
            raise _fail(Code.PRIVACY_VIOLATION, "every class is disclosed; the scheme must be none", None, "privacy.scheme")

    def identifier(cls: str, value: Any, index: Optional[int], path: str) -> None:
        if cls not in disclosed and not is_pseudonym(value):
            raise _fail(Code.PRIVACY_VIOLATION, f"{cls} value is not pseudonymised and {cls} is not disclosed", index, path)

    def content(value: Any, index: int, path: str) -> None:
        if value is None:
            return
        wanted = "sha256:" if "content" in disclosed else "hmac-sha256:"
        if not str(value).startswith(wanted):
            raise _fail(Code.PRIVACY_VIOLATION, f"content digest must be {wanted} while content is {'disclosed' if wanted == 'sha256:' else 'not disclosed'}", index, path)

    def action_key(data: Mapping[str, Any], index: int) -> None:
        if "subject" in disclosed:
            if "action_hash" not in data:
                raise _fail(Code.PRIVACY_VIOLATION, "action_hash is required when the subject is disclosed", index, _entry_path(index, "data.action_hash"))
            if "action_ref" in data:
                raise _fail(Code.PRIVACY_VIOLATION, "action_ref is used only while the subject is pseudonymised", index, _entry_path(index, "data.action_ref"))
        else:
            if "action_hash" in data:
                raise _fail(Code.PRIVACY_VIOLATION, "an unkeyed action_hash would reveal the pseudonymised subject", index, _entry_path(index, "data.action_hash"))
            if not is_action_reference(data.get("action_ref")):
                raise _fail(Code.PRIVACY_VIOLATION, "action_ref is required while the subject is pseudonymised", index, _entry_path(index, "data.action_ref"))

    case = package["case"]
    if "subject" in case:
        identifier("subject", case["subject"], None, "case.subject")
    for index, entry in enumerate(package["entries"]):
        kind = entry["type"]
        data = entry["data"]
        if kind == "grant":
            identifier("principal", data["principal"], index, _entry_path(index, "data.principal"))
        elif kind == "tool_call":
            content(data["input_hash"], index, _entry_path(index, "data.input_hash"))
            content(data["output_hash"], index, _entry_path(index, "data.output_hash"))
            for k, record in enumerate(data["upstream_records"]):
                identifier("record", record["record_id"], index, _entry_path(index, f"data.upstream_records[{k}].record_id"))
        elif kind == "decision":
            identifier("subject", data["action"]["subject"], index, _entry_path(index, "data.action.subject"))
            action_key(data, index)
            identifier("approver", data["approver"], index, _entry_path(index, "data.approver"))
        elif kind == "decision_consumption":
            action_key(data, index)
        for path, ref in _evidence_refs(data, kind):
            if "excerpt_ref" in ref:
                identifier("record", ref["excerpt_ref"], index, _entry_path(index, f"{path}.excerpt_ref"))
            identifier("record", ref["record_id"], index, _entry_path(index, f"{path}.record_id"))


# ── Chain ─────────────────────────────────────────────────────────────────


def check_chain(package: Mapping[str, Any]) -> None:
    chain = package["chain"]
    entries: List[Mapping[str, Any]] = package["entries"]
    genesis = header_hash(package)
    if chain["genesis"] != genesis:
        raise _fail(Code.GENESIS_MISMATCH, "chain.genesis is not the hash of the package header", None, "chain.genesis", genesis, chain["genesis"])
    previous = genesis
    for index, entry in enumerate(entries):
        if entry["seq"] != index:
            raise _fail(Code.SEQUENCE_MISMATCH, f"entry {index} has seq {entry['seq']}", index, _entry_path(index, "seq"), str(index), str(entry["seq"]))
        if entry["prev"] != previous:
            raise _fail(Code.LINK_MISMATCH, f"entry {index} does not link to the hash before it", index, _entry_path(index, "prev"), previous, entry["prev"])
        computed = entry_hash(entry)
        if entry["hash"] != computed:
            raise _fail(Code.ENTRY_HASH_MISMATCH, f"entry {index} content does not match its hash", index, _entry_path(index, "hash"), computed, entry["hash"])
        previous = computed
    if chain["head"] != previous:
        raise _fail(Code.HEAD_MISMATCH, "chain.head is not the hash of the last entry", None, "chain.head", previous, chain["head"])
    if chain["length"] != len(entries):
        raise _fail(Code.LENGTH_MISMATCH, "chain.length is not the number of entries", None, "chain.length", str(len(entries)), str(chain["length"]))
    root = chain_root(chain)
    if chain["root"] != root:
        raise _fail(Code.ROOT_MISMATCH, "chain.root is not the hash of the chain summary", None, "chain.root", root, chain["root"])


# ── Cross-entry rules ────────────────────────────────────────────────────


class SemanticSummary:
    """Counts reported alongside a successful verification."""

    def __init__(self) -> None:
        self.unsourced_inputs = 0
        self.late_entries = 0
        self.tenant_asserted_entries = 0


class _State:
    def __init__(self) -> None:
        self.grants: Dict[str, Tuple[int, int]] = {}  # grant_id -> (issued_ms, end_ms)
        self.grant_revoked_at: Dict[str, Optional[str]] = {}
        self.records: Dict[Tuple[str, str], Mapping[str, Any]] = {}  # (type, id) -> data
        self.voided: Set[Tuple[str, str]] = set()
        self.decisions: Dict[str, Mapping[str, Any]] = {}
        self.consumed: Set[str] = set()
        self.all_call_ids: Set[str] = set()
        self.consumption_seen = False


def _action_key(data: Mapping[str, Any]) -> Any:
    return data.get("action_hash", data.get("action_ref"))


def check_semantics(package: Mapping[str, Any]) -> SemanticSummary:
    case = package["case"]
    disclosed: List[str] = package["privacy"]["disclosed"]
    entries: List[Mapping[str, Any]] = package["entries"]
    state = _State()
    summary = SemanticSummary()
    for entry in entries:
        if entry["type"] == "tool_call":
            state.all_call_ids.add(entry["data"]["call_id"])

    grant_block = True
    last_grant: Optional[str] = None
    last_recorded: Optional[int] = None
    for index, entry in enumerate(entries):
        kind = entry["type"]
        data = entry["data"]
        source = entry["source"]
        at = timestamp_ms(entry["at"])
        recorded = timestamp_ms(source["recorded_at"])

        if kind in PLATFORM_TYPES and source["authority"] != "platform":
            raise _fail(Code.AUTHORITY_VIOLATION, f"a {kind} entry must be recorded by the platform", index, _entry_path(index, "source.authority"), "platform", source["authority"])
        if source["authority"] == "tenant":
            summary.tenant_asserted_entries += 1
        if source.get("late") is True:
            summary.late_entries += 1
        if at > recorded + MAX_CLOCK_SKEW_MS:
            raise _fail(Code.VALIDITY_VIOLATION, "entry time is later than when it was recorded", index, _entry_path(index, "at"), f"<= {source['recorded_at']} + {MAX_CLOCK_SKEW_MS} ms", entry["at"])

        if kind == "grant":
            _check_grant(entry, index, grant_block, last_grant, state)
            last_grant = data["grant_id"]
            continue
        if index == 0:
            raise _fail(Code.GRANT_CHAIN_BROKEN, "the first entry must be the root grant", 0, _entry_path(0, "type"))
        grant_block = False
        if last_recorded is not None and recorded < last_recorded:
            raise _fail(Code.ENTRIES_OUT_OF_ORDER, "entries after the grant chain must be in recording order", index, _entry_path(index, "source.recorded_at"))
        last_recorded = recorded
        if state.consumption_seen and source["authority"] == "tenant" and source.get("late") is not True:
            raise _fail(Code.VALIDITY_VIOLATION, "a tenant record made after the decision was consumed must be marked late", index, _entry_path(index, "source.late"), "true", None)

        if kind in _ID_FIELDS:
            field_name = _ID_FIELDS[kind]
            key = (kind, data[field_name])
            if key in state.records:
                raise _fail(Code.DUPLICATE_IDENTIFIER, f"{data[field_name]} appears in more than one entry", index, _entry_path(index, f"data.{field_name}"))
            if "run_id" in data and kind != "run_context":
                _require_record(state, "run_context", data["run_id"], index, "data.run_id")
        if kind == "tool_call":
            _check_tool_call(data, index, at, state)
        elif kind == "policy_evaluation":
            for i, item in enumerate(data["inputs"]):
                if bool(item["evidence"]) == (item.get("unsourced") is True):
                    raise _fail(Code.SCHEMA_VIOLATION, "an input cites evidence or is marked unsourced, not both or neither", index, _entry_path(index, f"data.inputs[{i}].unsourced"))
                if item.get("unsourced") is True:
                    summary.unsourced_inputs += 1
        elif kind == "recommendation":
            for i, evaluation_id in enumerate(data["evaluation_ids"]):
                _require_record(state, "policy_evaluation", evaluation_id, index, f"data.evaluation_ids[{i}]")
            for i, section in enumerate(data["sections"]):
                if section["status"] != "not_available" and not section["evidence"]:
                    raise _fail(Code.SCHEMA_VIOLATION, "a section that is not not_available must cite evidence", index, _entry_path(index, f"data.sections[{i}].evidence"))
        elif kind == "decision":
            _check_decision(data, index, case, disclosed, state)
        elif kind == "decision_consumption":
            _check_consumption(data, index, state)
        elif kind == "revocation":
            if data["grant_id"] not in state.grants:
                raise _fail(Code.DANGLING_REFERENCE, "revoked grant is not in the grant chain", index, _entry_path(index, "data.grant_id"))
            if state.grant_revoked_at[data["grant_id"]] != data["revoked_at"]:
                raise _fail(Code.VALIDITY_VIOLATION, "revocation time differs from the grant's revoked_at", index, _entry_path(index, "data.revoked_at"), state.grant_revoked_at[data["grant_id"]], data["revoked_at"])
        elif kind == "void":
            target = (data["target_type"], data["target_id"])
            if target not in state.records:
                raise _fail(Code.DANGLING_REFERENCE, "void names no earlier record", index, _entry_path(index, "data.target_id"))
            if target in state.voided:
                raise _fail(Code.DUPLICATE_IDENTIFIER, "record is already void", index, _entry_path(index, "data.target_id"))
            state.voided.add(target)

        for path, ref in _evidence_refs(data, kind):
            _check_ref(ref, index, path, state)
        if kind in _ID_FIELDS:
            state.records[(kind, data[_ID_FIELDS[kind]])] = data
    return summary


def _require_record(state: _State, kind: str, record_id: str, index: int, path: str) -> Mapping[str, Any]:
    record = state.records.get((kind, record_id))
    if record is None:
        raise _fail(Code.DANGLING_REFERENCE, f"no earlier {kind} has this id", index, _entry_path(index, path))
    if (kind, record_id) in state.voided:
        raise _fail(Code.DANGLING_REFERENCE, f"{kind} {record_id} is void", index, _entry_path(index, path))
    return record


def _check_grant(entry: Mapping[str, Any], index: int, grant_block: bool, last_grant: Optional[str], state: _State) -> None:
    data = entry["data"]
    if not grant_block:
        raise _fail(Code.GRANT_CHAIN_BROKEN, "grant entries must come first, root to leaf", index, _entry_path(index, "type"))
    if data["grant_id"] in state.grants:
        raise _fail(Code.DUPLICATE_IDENTIFIER, f"{data['grant_id']} appears in more than one entry", index, _entry_path(index, "data.grant_id"))
    if data["depth"] != index:
        raise _fail(Code.GRANT_CHAIN_BROKEN, f"grant at position {index} has depth {data['depth']}", index, _entry_path(index, "data.depth"), str(index), str(data["depth"]))
    if data["parent_grant_id"] != last_grant:
        raise _fail(Code.GRANT_CHAIN_BROKEN, "parent_grant_id is not the previous grant in the chain", index, _entry_path(index, "data.parent_grant_id"), last_grant, data["parent_grant_id"])
    if entry["at"] != data["issued_at"]:
        raise _fail(Code.GRANT_CHAIN_BROKEN, "a grant entry's time is the grant's issue time", index, _entry_path(index, "at"), data["issued_at"], entry["at"])
    issued = timestamp_ms(data["issued_at"])
    expires = timestamp_ms(data["expires_at"])
    revoked = data["revoked_at"]
    if (data["status"] == "revoked") != (revoked is not None):
        raise _fail(Code.VALIDITY_VIOLATION, "revoked_at is set exactly when the grant is revoked", index, _entry_path(index, "data.revoked_at"))
    if expires < issued:
        raise _fail(Code.VALIDITY_VIOLATION, "grant expires before it was issued", index, _entry_path(index, "data.expires_at"))
    end = expires
    if revoked is not None:
        if timestamp_ms(revoked) < issued:
            raise _fail(Code.VALIDITY_VIOLATION, "grant revoked before it was issued", index, _entry_path(index, "data.revoked_at"))
        end = min(end, timestamp_ms(revoked))
    if last_grant is not None:
        parent_issued, parent_end = state.grants[last_grant]
        if issued < parent_issued - MAX_CLOCK_SKEW_MS or issued > parent_end + MAX_CLOCK_SKEW_MS:
            raise _fail(Code.VALIDITY_VIOLATION, "delegated grant issued outside its parent's validity", index, _entry_path(index, "data.issued_at"))
    state.grants[data["grant_id"]] = (issued, end)
    state.grant_revoked_at[data["grant_id"]] = revoked


def _check_ref(ref: Mapping[str, Any], index: int, path: str, state: _State) -> None:
    call = state.records.get(("tool_call", ref["call_id"]))
    if call is None:
        raise _fail(Code.DANGLING_REFERENCE, "evidence cites no earlier tool call", index, _entry_path(index, f"{path}.call_id"))
    if ("tool_call", ref["call_id"]) in state.voided:
        raise _fail(Code.DANGLING_REFERENCE, "evidence cites a void tool call", index, _entry_path(index, f"{path}.call_id"))
    if call["provider"] != ref["provider"]:
        raise _fail(Code.DANGLING_REFERENCE, "evidence provider differs from the tool call", index, _entry_path(index, f"{path}.provider"))
    records: List[Mapping[str, Any]] = call["upstream_records"]
    if not any(r["record_id"] == ref["record_id"] for r in records):
        raise _fail(Code.DANGLING_REFERENCE, "the tool call returned no such upstream record", index, _entry_path(index, f"{path}.record_id"))
    if not any(r["record_id"] == ref["record_id"] and r["retrieved_at"] == ref["retrieved_at"] for r in records):
        raise _fail(Code.DANGLING_REFERENCE, "evidence retrieval time differs from the upstream record", index, _entry_path(index, f"{path}.retrieved_at"))


def _check_tool_call(data: Mapping[str, Any], index: int, at: int, state: _State) -> None:
    if data["grant_id"] not in state.grants:
        raise _fail(Code.DANGLING_REFERENCE, "tool call grant is not in the grant chain", index, _entry_path(index, "data.grant_id"))

    def inconsistent(path: str, message: str) -> VerificationFailure:
        return _fail(Code.TOOL_CALL_INCONSISTENT, message, index, _entry_path(index, path))

    outcome = data["outcome"]
    if outcome == "allowed":
        if "denial" in data:
            raise inconsistent("data.denial", "an allowed call has no denial")
        if data["output_hash"] is None:
            raise inconsistent("data.output_hash", "an allowed call has an output hash")
    else:
        if outcome == "denied" and "denial" not in data:
            raise inconsistent("data.denial", "a denied call names its denial reason")
        if outcome == "error" and "denial" in data:
            raise inconsistent("data.denial", "a failed call has no denial")
        if data["output_hash"] is not None:
            raise inconsistent("data.output_hash", "a call that did not run has no output")
        if data["upstream_records"]:
            raise inconsistent("data.upstream_records", "a call that did not run has no upstream records")
    if "completed_at" in data and timestamp_ms(data["completed_at"]) < timestamp_ms(data["started_at"]):
        raise inconsistent("data.completed_at", "completed before it started")
    if outcome == "allowed":
        issued, end = state.grants[data["grant_id"]]
        if at < issued - MAX_CLOCK_SKEW_MS or at > end + MAX_CLOCK_SKEW_MS:
            raise _fail(Code.VALIDITY_VIOLATION, "an allowed call falls outside its grant's validity", index, _entry_path(index, "at"))


def _check_decision(data: Mapping[str, Any], index: int, case: Mapping[str, Any], disclosed: List[str], state: _State) -> None:
    if data["jti"] in state.decisions:
        raise _fail(Code.DUPLICATE_IDENTIFIER, f"{data['jti']} appears in more than one entry", index, _entry_path(index, "data.jti"))
    action = data["action"]
    if action["case_id"] != case["case_id"]:
        raise _fail(Code.CASE_MISMATCH, "decision approves an action on another case", index, _entry_path(index, "data.action.case_id"), case["case_id"], action["case_id"])
    if "subject" in case and action["subject"] != case["subject"]:
        raise _fail(Code.CASE_MISMATCH, "decision subject differs from the case subject", index, _entry_path(index, "data.action.subject"), case["subject"], action["subject"])
    if "subject" in disclosed:
        computed = decision_action_hash(action)
        if computed != data["action_hash"]:
            raise _fail(Code.ACTION_HASH_MISMATCH, "action_hash is not the hash of the semantic action", index, _entry_path(index, "data.action_hash"), computed, data["action_hash"])

    def inconsistent(path: str, message: str) -> VerificationFailure:
        return _fail(Code.DECISION_INCONSISTENT, message, index, _entry_path(index, path))

    position = data["approval_position"]
    if position > data["approvals_required"]:
        raise inconsistent("data.approval_position", "more approvals than required")
    if timestamp_ms(data["expires_at"]) < timestamp_ms(data["issued_at"]):
        raise _fail(Code.VALIDITY_VIOLATION, "decision expires before it was issued", index, _entry_path(index, "data.expires_at"))
    if position == 1:
        if "first_jti" in data:
            raise inconsistent("data.first_jti", "a first approval has no first_jti")
    else:
        if "first_jti" not in data:
            raise inconsistent("data.first_jti", "a second approval names the first")
        first = state.decisions.get(data["first_jti"])
        if first is None:
            raise _fail(Code.DANGLING_REFERENCE, "no earlier decision has this jti", index, _entry_path(index, "data.first_jti"))
        checks = (
            ("data.first_jti", first["approval_position"] == 1),
            ("data.first_jti", data["first_jti"] not in state.consumed),
            (_action_path(data), _action_key(first) == _action_key(data)),
            ("data.approvals_required", first["approvals_required"] == 2),
            ("data.approver", first["approver"] != data["approver"]),
        )
        for path, ok in checks:
            if not ok:
                raise inconsistent(path, "second approval does not pair with an unconsumed first approval")
    state.decisions[data["jti"]] = data


def _action_path(data: Mapping[str, Any]) -> str:
    return "data.action_hash" if "action_hash" in data else "data.action_ref"


def _check_consumption(data: Mapping[str, Any], index: int, state: _State) -> None:
    consumed_at = timestamp_ms(data["consumed_at"])
    decisions: List[Mapping[str, Any]] = []
    for position, jti in enumerate(data["jtis"]):
        path = f"data.jtis[{position}]"
        decision = state.decisions.get(jti)
        if decision is None:
            raise _fail(Code.DANGLING_REFERENCE, "no earlier decision has this jti", index, _entry_path(index, path))
        if jti in state.consumed:
            raise _fail(Code.DECISION_INCONSISTENT, "decision grant consumed more than once", index, _entry_path(index, path))
        if _action_key(decision) != _action_key(data):
            raise _fail(Code.DECISION_INCONSISTENT, "consumed decision approved a different action", index, _entry_path(index, _action_path(data)), str(_action_key(decision)), str(_action_key(data)))
        if consumed_at > timestamp_ms(decision["expires_at"]) or consumed_at < timestamp_ms(decision["issued_at"]) - MAX_CLOCK_SKEW_MS:
            raise _fail(Code.VALIDITY_VIOLATION, "consumed outside the decision grant's validity", index, _entry_path(index, "data.consumed_at"), f"{decision['issued_at']}..{decision['expires_at']}", data["consumed_at"])
        decisions.append(decision)
    required = decisions[0]["approvals_required"]
    positions = sorted(d["approval_position"] for d in decisions)
    if any(d["approvals_required"] != required for d in decisions) or positions != list(range(1, required + 1)):
        raise _fail(Code.DECISION_INCONSISTENT, "a consumption presents every required approval exactly once", index, _entry_path(index, "data.jtis"), str(required), str(len(decisions)))
    if "call_id" in data and data["call_id"] not in state.all_call_ids:
        raise _fail(Code.DANGLING_REFERENCE, "no tool call has this call_id", index, _entry_path(index, "data.call_id"))
    state.consumed.update(data["jtis"])
    state.consumption_seen = True
