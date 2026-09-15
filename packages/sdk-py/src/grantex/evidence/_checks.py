"""Privacy, hash-chain and cross-entry checks on a parsed evidence package.

Each check raises :class:`VerificationFailure` at the first problem it finds.
The order of checks, and the order within each, is part of the specification
so that every implementation reports the same failure.
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional, Set, Tuple

from ._hashing import (
    IDENTIFIER_CLASSES,
    chain_root,
    decision_action_hash,
    entry_hash,
    header_hash,
    is_pseudonym,
)
from ._result import VerificationCode as Code
from ._result import VerificationFailure

__all__ = ["check_privacy", "check_chain", "check_semantics"]


def _entry_path(index: int, rest: str = "") -> str:
    return f"entries[{index}]" + (f".{rest}" if rest else "")


def check_privacy(package: Mapping[str, Any]) -> None:
    privacy = package["privacy"]
    disclosed: List[str] = privacy["disclosed"]
    if disclosed != sorted(disclosed):
        raise VerificationFailure(
            Code.PRIVACY_VIOLATION,
            "privacy.disclosed must be sorted",
            field_path="privacy.disclosed",
        )
    everything = list(IDENTIFIER_CLASSES)
    if privacy["scheme"] == "none":
        if disclosed != everything:
            raise VerificationFailure(
                Code.PRIVACY_VIOLATION,
                "scheme none requires every identifier class to be disclosed",
                field_path="privacy.disclosed",
            )
        if "key_id" in privacy:
            raise VerificationFailure(
                Code.PRIVACY_VIOLATION,
                "scheme none has no key_id",
                field_path="privacy.key_id",
            )
    else:
        if "key_id" not in privacy:
            raise VerificationFailure(
                Code.PRIVACY_VIOLATION,
                "a pseudonymisation scheme requires key_id",
                field_path="privacy.key_id",
            )
        if disclosed == everything:
            raise VerificationFailure(
                Code.PRIVACY_VIOLATION,
                "every identifier class is disclosed; the scheme must be none",
                field_path="privacy.scheme",
            )

    def require(cls: str, value: Any, path: str) -> None:
        if cls not in disclosed and not is_pseudonym(value):
            raise VerificationFailure(
                Code.PRIVACY_VIOLATION,
                f"{cls} identifier is not pseudonymised and {cls} is not disclosed",
                field_path=path,
            )

    case = package["case"]
    if "subject" in case:
        require("subject", case["subject"], "case.subject")
    for index, entry in enumerate(package["entries"]):
        data = entry["data"]
        if entry["type"] == "grant":
            require("principal", data["principal"], _entry_path(index, "data.principal"))
        elif entry["type"] == "decision":
            require(
                "subject",
                data["action"]["subject"],
                _entry_path(index, "data.action.subject"),
            )
            require("approver", data["approver"], _entry_path(index, "data.approver"))


def check_chain(package: Mapping[str, Any]) -> None:
    chain = package["chain"]
    entries: List[Mapping[str, Any]] = package["entries"]

    genesis = header_hash(package)
    if chain["genesis"] != genesis:
        raise VerificationFailure(
            Code.GENESIS_MISMATCH,
            "chain.genesis is not the hash of the package header",
            field_path="chain.genesis",
            expected=genesis,
            actual=chain["genesis"],
        )
    previous = genesis
    for index, entry in enumerate(entries):
        if entry["seq"] != index:
            raise VerificationFailure(
                Code.SEQUENCE_MISMATCH,
                f"entry {index} has seq {entry['seq']}",
                entry_index=index,
                field_path=_entry_path(index, "seq"),
                expected=str(index),
                actual=str(entry["seq"]),
            )
        if entry["prev"] != previous:
            raise VerificationFailure(
                Code.LINK_MISMATCH,
                f"entry {index} does not link to the hash before it",
                entry_index=index,
                field_path=_entry_path(index, "prev"),
                expected=previous,
                actual=entry["prev"],
            )
        computed = entry_hash(entry)
        if entry["hash"] != computed:
            raise VerificationFailure(
                Code.ENTRY_HASH_MISMATCH,
                f"entry {index} content does not match its hash",
                entry_index=index,
                field_path=_entry_path(index, "hash"),
                expected=computed,
                actual=entry["hash"],
            )
        previous = computed
    if chain["head"] != previous:
        raise VerificationFailure(
            Code.HEAD_MISMATCH,
            "chain.head is not the hash of the last entry",
            field_path="chain.head",
            expected=previous,
            actual=chain["head"],
        )
    if chain["length"] != len(entries):
        raise VerificationFailure(
            Code.LENGTH_MISMATCH,
            "chain.length is not the number of entries",
            field_path="chain.length",
            expected=str(len(entries)),
            actual=str(chain["length"]),
        )
    root = chain_root(chain)
    if chain["root"] != root:
        raise VerificationFailure(
            Code.ROOT_MISMATCH,
            "chain.root is not the hash of the chain summary",
            field_path="chain.root",
            expected=root,
            actual=chain["root"],
        )


class _Index:
    def __init__(self) -> None:
        self.grants: Set[str] = set()
        self.runs: Set[str] = set()
        self.calls: Dict[str, Mapping[str, Any]] = {}
        self.evaluations: Set[str] = set()
        self.recommendations: Set[str] = set()
        self.decisions: Dict[str, Mapping[str, Any]] = {}
        self.all_call_ids: Set[str] = set()


def _unique(seen: Any, value: str, index: int, path: str) -> None:
    if value in seen:
        raise VerificationFailure(
            Code.DUPLICATE_IDENTIFIER,
            f"{value} appears in more than one entry",
            entry_index=index,
            field_path=_entry_path(index, path),
        )


def _dangling(index: int, path: str, message: str) -> VerificationFailure:
    return VerificationFailure(
        Code.DANGLING_REFERENCE, message, entry_index=index, field_path=_entry_path(index, path)
    )


def _check_evidence(
    refs: List[Mapping[str, Any]], index: int, base: str, known: _Index
) -> None:
    for position, ref in enumerate(refs):
        path = f"{base}[{position}]"
        call = known.calls.get(ref["call_id"])
        if call is None:
            raise _dangling(index, f"{path}.call_id", "evidence cites no earlier tool call")
        if call["provider"] != ref["provider"]:
            raise _dangling(
                index, f"{path}.provider", "evidence provider differs from the tool call"
            )
        records: List[Mapping[str, Any]] = call["upstream_records"]
        if not any(r["record_id"] == ref["record_id"] for r in records):
            raise _dangling(
                index, f"{path}.record_id", "the tool call returned no such upstream record"
            )
        if not any(
            r["record_id"] == ref["record_id"] and r["retrieved_at"] == ref["retrieved_at"]
            for r in records
        ):
            raise _dangling(
                index,
                f"{path}.retrieved_at",
                "evidence retrieval time differs from the upstream record",
            )


def check_semantics(package: Mapping[str, Any]) -> None:
    case = package["case"]
    disclosed: List[str] = package["privacy"]["disclosed"]
    entries: List[Mapping[str, Any]] = package["entries"]
    known = _Index()
    for entry in entries:
        if entry["type"] == "tool_call":
            known.all_call_ids.add(entry["data"]["call_id"])

    grant_block = True
    last_grant: Optional[str] = None
    last_at: Optional[str] = None
    for index, entry in enumerate(entries):
        kind = entry["type"]
        data = entry["data"]
        if kind == "grant":
            if not grant_block:
                raise VerificationFailure(
                    Code.GRANT_CHAIN_BROKEN,
                    "grant entries must come first, root to leaf",
                    entry_index=index,
                    field_path=_entry_path(index, "type"),
                )
            _unique(known.grants, data["grant_id"], index, "data.grant_id")
            if data["depth"] != index:
                raise VerificationFailure(
                    Code.GRANT_CHAIN_BROKEN,
                    f"grant at position {index} has depth {data['depth']}",
                    entry_index=index,
                    field_path=_entry_path(index, "data.depth"),
                    expected=str(index),
                    actual=str(data["depth"]),
                )
            if data["parent_grant_id"] != last_grant:
                raise VerificationFailure(
                    Code.GRANT_CHAIN_BROKEN,
                    "parent_grant_id is not the previous grant in the chain",
                    entry_index=index,
                    field_path=_entry_path(index, "data.parent_grant_id"),
                    expected=last_grant,
                    actual=data["parent_grant_id"],
                )
            if entry["at"] != data["issued_at"]:
                raise VerificationFailure(
                    Code.GRANT_CHAIN_BROKEN,
                    "a grant entry's time is the grant's issue time",
                    entry_index=index,
                    field_path=_entry_path(index, "at"),
                    expected=data["issued_at"],
                    actual=entry["at"],
                )
            known.grants.add(data["grant_id"])
            last_grant = data["grant_id"]
            continue

        if index == 0:
            raise VerificationFailure(
                Code.GRANT_CHAIN_BROKEN,
                "the first entry must be the root grant",
                entry_index=0,
                field_path=_entry_path(0, "type"),
            )
        grant_block = False
        if last_at is not None and entry["at"] < last_at:
            raise VerificationFailure(
                Code.ENTRIES_OUT_OF_ORDER,
                "entries after the grant chain must be in time order",
                entry_index=index,
                field_path=_entry_path(index, "at"),
                expected=last_at,
                actual=entry["at"],
            )
        last_at = entry["at"]

        if kind == "run_context":
            _unique(known.runs, data["run_id"], index, "data.run_id")
            known.runs.add(data["run_id"])
        elif kind == "tool_call":
            _check_tool_call(data, index, known)
        elif kind == "policy_evaluation":
            _unique(known.evaluations, data["evaluation_id"], index, "data.evaluation_id")
            if "run_id" in data and data["run_id"] not in known.runs:
                raise _dangling(index, "data.run_id", "no earlier run_context has this run_id")
            for position, item in enumerate(data["inputs"]):
                _check_evidence(
                    item["evidence"], index, f"data.inputs[{position}].evidence", known
                )
            known.evaluations.add(data["evaluation_id"])
        elif kind == "recommendation":
            _unique(
                known.recommendations, data["recommendation_id"], index, "data.recommendation_id"
            )
            if data["evaluation_id"] not in known.evaluations:
                raise _dangling(
                    index, "data.evaluation_id", "no earlier policy_evaluation has this id"
                )
            for position, section in enumerate(data["sections"]):
                base = f"data.sections[{position}].evidence"
                if section["status"] != "not_available" and not section["evidence"]:
                    raise VerificationFailure(
                        Code.SCHEMA_VIOLATION,
                        "a section that is not not_available must cite evidence",
                        entry_index=index,
                        field_path=_entry_path(index, base),
                    )
                _check_evidence(section["evidence"], index, base, known)
            known.recommendations.add(data["recommendation_id"])
        elif kind == "decision":
            _check_decision(data, index, case, disclosed, known)
        elif kind == "decision_consumption":
            for position, jti in enumerate(data["jtis"]):
                decision = known.decisions.get(jti)
                path = f"data.jtis[{position}]"
                if decision is None:
                    raise _dangling(index, path, "no earlier decision has this jti")
                if decision["action_hash"] != data["action_hash"]:
                    raise VerificationFailure(
                        Code.DECISION_INCONSISTENT,
                        "consumed decision approved a different action",
                        entry_index=index,
                        field_path=_entry_path(index, "data.action_hash"),
                        expected=decision["action_hash"],
                        actual=data["action_hash"],
                    )
            if "call_id" in data and data["call_id"] not in known.all_call_ids:
                raise _dangling(index, "data.call_id", "no tool call has this call_id")
        elif kind == "revocation":
            if data["grant_id"] not in known.grants:
                raise _dangling(index, "data.grant_id", "revoked grant is not in the grant chain")


def _check_tool_call(data: Mapping[str, Any], index: int, known: _Index) -> None:
    _unique(known.calls, data["call_id"], index, "data.call_id")
    if data["grant_id"] not in known.grants:
        raise _dangling(index, "data.grant_id", "tool call grant is not in the grant chain")
    if "run_id" in data and data["run_id"] not in known.runs:
        raise _dangling(index, "data.run_id", "no earlier run_context has this run_id")

    def inconsistent(path: str, message: str) -> VerificationFailure:
        return VerificationFailure(
            Code.TOOL_CALL_INCONSISTENT,
            message,
            entry_index=index,
            field_path=_entry_path(index, path),
        )

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
            raise inconsistent(
                "data.upstream_records", "a call that did not run has no upstream records"
            )
    if "completed_at" in data and data["completed_at"] < data["started_at"]:
        raise inconsistent("data.completed_at", "completed before it started")
    known.calls[data["call_id"]] = data


def _check_decision(
    data: Mapping[str, Any],
    index: int,
    case: Mapping[str, Any],
    disclosed: List[str],
    known: _Index,
) -> None:
    _unique(known.decisions, data["jti"], index, "data.jti")
    action = data["action"]
    if action["case_id"] != case["case_id"]:
        raise VerificationFailure(
            Code.CASE_MISMATCH,
            "decision approves an action on another case",
            entry_index=index,
            field_path=_entry_path(index, "data.action.case_id"),
            expected=case["case_id"],
            actual=action["case_id"],
        )
    if "subject" in disclosed:
        computed = decision_action_hash(action)
        if computed != data["action_hash"]:
            raise VerificationFailure(
                Code.ACTION_HASH_MISMATCH,
                "action_hash is not the hash of the semantic action",
                entry_index=index,
                field_path=_entry_path(index, "data.action_hash"),
                expected=computed,
                actual=data["action_hash"],
            )

    def inconsistent(path: str, message: str) -> VerificationFailure:
        return VerificationFailure(
            Code.DECISION_INCONSISTENT,
            message,
            entry_index=index,
            field_path=_entry_path(index, path),
        )

    position = data["approval_position"]
    if position > data["approvals_required"]:
        raise inconsistent("data.approval_position", "more approvals than required")
    if data["expires_at"] < data["issued_at"]:
        raise inconsistent("data.expires_at", "expires before it was issued")
    if position == 1:
        if "first_jti" in data:
            raise inconsistent("data.first_jti", "a first approval has no first_jti")
    else:
        if "first_jti" not in data:
            raise inconsistent("data.first_jti", "a second approval names the first")
        first = known.decisions.get(data["first_jti"])
        if first is None:
            raise _dangling(index, "data.first_jti", "no earlier decision has this jti")
        pairs: Tuple[Tuple[str, bool], ...] = (
            ("data.action_hash", first["action_hash"] == data["action_hash"]),
            ("data.approvals_required", first["approvals_required"] == 2),
            ("data.approver", first["approver"] != data["approver"]),
        )
        for path, ok in pairs:
            if not ok:
                raise inconsistent(
                    path, "second approval does not pair with the first approval"
                )
    known.decisions[data["jti"]] = data
