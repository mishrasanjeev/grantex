"""Decision-grant semantic action and action_hash (PRD G-3, canonicalisation
stability). Cases in spec/examples/decision-grant/action-hash.json are shared
with the TypeScript SDK and the auth service."""

from __future__ import annotations

import json
import random
from pathlib import Path
from typing import Any, Dict

import pytest

from grantex.decisions import (
    ACTION_HASH_PREFIX,
    ActionValidationError,
    DecisionAction,
    compute_action_hash,
    is_action_hash,
)

FIXTURES = json.loads(
    (
        Path(__file__).resolve().parents[3]
        / "spec" / "examples" / "decision-grant" / "action-hash.json"
    ).read_text(encoding="utf-8")
)

BASE = {
    "case_id": "case_8841",
    "action": "case_decision",
    "decision": "approve",
    "subject": "gb:00000001",
}


@pytest.mark.parametrize("case", FIXTURES["valid"], ids=lambda c: c["name"])
def test_shared_action_hashes(case: Dict[str, Any]) -> None:
    action = DecisionAction.from_dict(case["action"])
    assert action.canonical_json() == case["canonical"]
    assert action.action_hash() == case["action_hash"]
    assert compute_action_hash(case["action"]) == case["action_hash"]
    assert is_action_hash(case["action_hash"])
    assert action.to_dict() == case["action"]


def test_shared_hashes_are_distinct() -> None:
    hashes = [c["action_hash"] for c in FIXTURES["valid"]]
    assert len(set(hashes)) == len(hashes)


@pytest.mark.parametrize(
    "group", FIXTURES["equivalent_tool_calls"], ids=lambda g: g["tool"]
)
def test_equivalent_tool_calls_share_one_hash(group: Dict[str, Any]) -> None:
    for text in group["arguments"]:
        action = DecisionAction.from_tool_call(group["tool"], json.loads(text))
        assert action.action_hash() == group["action_hash"], text


@pytest.mark.parametrize("case", FIXTURES["invalid"], ids=lambda c: c["name"])
def test_shared_invalid_actions(case: Dict[str, Any]) -> None:
    raw = case["action"] if "action" in case else json.loads(case["action_json"])
    with pytest.raises(ActionValidationError) as info:
        DecisionAction.from_dict(raw)
    assert (info.value.code, info.value.field) == (case["code"], case["field"])
    with pytest.raises(ActionValidationError):
        compute_action_hash(raw)


def test_hash_format() -> None:
    value = compute_action_hash(BASE)
    assert value.startswith(ACTION_HASH_PREFIX)
    assert len(value) == len(ACTION_HASH_PREFIX) + 43
    assert "=" not in value
    assert not is_action_hash("sha256:" + "A" * 42)
    assert not is_action_hash("sha512:" + "A" * 43)
    assert not is_action_hash(None)


def test_tool_call_requires_semantic_fields() -> None:
    with pytest.raises(ActionValidationError) as info:
        DecisionAction.from_tool_call("case_decision", {"case_id": "case_8841", "decision": "approve"})
    assert (info.value.code, info.value.field) == ("missing_field", "subject")
    with pytest.raises(ActionValidationError) as info:
        DecisionAction.from_tool_call("case_decision", '{"case_id": "case_8841"}')
    assert info.value.code == "not_an_object"
    with pytest.raises(ActionValidationError) as info:
        DecisionAction.from_tool_call("case decision", {"case_id": "c", "decision": "approve", "subject": "s"})
    assert (info.value.code, info.value.field) == ("invalid_value", "action")


def test_integer_amount_must_be_exact() -> None:
    DecisionAction(**BASE, amount=2**53 - 1)
    with pytest.raises(ActionValidationError) as info:
        DecisionAction(**BASE, amount=2**53 + 1)
    assert (info.value.code, info.value.field) == ("invalid_value", "amount")
    with pytest.raises(ActionValidationError):
        DecisionAction(**BASE, amount=float("nan"))


# ── Properties ────────────────────────────────────────────────────────────


def _random_text(rng: random.Random, length: int) -> str:
    return "".join(
        chr(rng.choice([rng.randint(0x20, 0x7E), rng.randint(0xA0, 0x24F), rng.randint(0x1F600, 0x1F64F)]))
        for _ in range(length)
    )


def _random_action(rng: random.Random) -> Dict[str, Any]:
    action: Dict[str, Any] = {
        "case_id": "case_" + _random_text(rng, rng.randint(1, 20)),
        "decision": rng.choice(["approve", "decline", "close", "file", "request_info"]),
        "subject": rng.choice(["gb:", "us:", "person:"]) + _random_text(rng, rng.randint(1, 30)),
    }
    if rng.random() < 0.5:
        action["amount"] = rng.choice([
            rng.randint(0, 10**9),
            round(rng.uniform(0, 1e6), 2),
            str(rng.randint(1, 10**6)) + rng.choice(["", ".5", ".25", ".01"]),
        ])
    return action


def _noise(rng: random.Random) -> Dict[str, Any]:
    return {
        rng.choice(["requested_at", "timestamp", "plan_step", "trace_id", "note", "retry"]) + str(i): rng.choice([
            f"2026-09-{rng.randint(10, 28)}T{rng.randint(0, 23):02d}:{rng.randint(0, 59):02d}:00Z",
            rng.randint(0, 1000),
            _random_text(rng, 8),
            None,
            {"nested": [1, 2, rng.random()]},
        ])
        for i in range(rng.randint(0, 5))
    }


def _serialise_randomly(rng: random.Random, payload: Dict[str, Any]) -> str:
    items = list(payload.items())
    rng.shuffle(items)
    return json.dumps(
        dict(items),
        indent=rng.choice([None, 0, 2, 7]),
        separators=rng.choice([None, (",", ":"), (" , ", " : ")]),
        ensure_ascii=rng.random() < 0.5,
    )


def test_property_reordering_whitespace_and_new_fields_keep_the_hash() -> None:
    rng = random.Random(3)
    for _ in range(400):
        tool = rng.choice(["case_decision", "monitor_delete", "payout_release"])
        semantic = _random_action(rng)
        expected = DecisionAction.from_tool_call(tool, semantic).action_hash()
        for _ in range(5):
            payload = {**_noise(rng), **semantic}
            if "amount" in semantic and isinstance(semantic["amount"], float) and rng.random() < 0.5:
                # Another spelling of the same double.
                text = _serialise_randomly(rng, {**payload, "amount": "@@AMOUNT@@"})
                text = text.replace('"@@AMOUNT@@"', f"{semantic['amount']:.6e}" if rng.random() < 0.5 else repr(semantic["amount"]) + "0")
                parsed = json.loads(text)
                if parsed["amount"] != semantic["amount"]:
                    continue
            else:
                parsed = json.loads(_serialise_randomly(rng, payload))
            assert DecisionAction.from_tool_call(tool, parsed).action_hash() == expected


def test_property_any_semantic_change_changes_the_hash() -> None:
    rng = random.Random(4)
    seen: Dict[str, str] = {}
    for _ in range(400):
        tool = rng.choice(["case_decision", "monitor_delete"])
        semantic = _random_action(rng)
        original = DecisionAction.from_tool_call(tool, semantic)
        base_hash = original.action_hash()
        field = rng.choice(["case_id", "action", "decision", "subject", "amount"])
        changed = original.to_dict()
        if field == "action":
            changed["action"] = tool + "_v2"
        elif field == "decision":
            changed["decision"] = changed["decision"] + "_x"
        elif field == "amount":
            if "amount" in changed and rng.random() < 0.3:
                del changed["amount"]
            else:
                current = changed.get("amount")
                changed["amount"] = (
                    str(current) + "1" if isinstance(current, str) and "." in current
                    else (current + 1 if isinstance(current, (int, float)) and not isinstance(current, bool) else 7)
                )
        else:
            # One code point more, or one code point different.
            value = changed[field]
            flipped = chr(ord(value[-1]) ^ 1)
            if flipped == "\x7f":
                flipped = "y"
            changed[field] = value + "x" if rng.random() < 0.5 else value[:-1] + flipped
        mutated = DecisionAction.from_dict(changed)
        assert mutated.action_hash() != base_hash, (field, semantic, changed)
        seen.setdefault(base_hash, original.canonical_json())
        assert seen[base_hash] == original.canonical_json()


def test_amount_number_and_string_are_different_actions() -> None:
    assert compute_action_hash({**BASE, "amount": 5}) != compute_action_hash({**BASE, "amount": "5"})
    assert compute_action_hash({**BASE, "amount": 5}) == compute_action_hash({**BASE, "amount": 5.0})
    assert compute_action_hash({**BASE, "amount": 5}) != compute_action_hash(BASE)
