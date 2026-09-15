"""RFC 8785 canonicalisation: the RFC test vectors, the ES6 number test and
the cases shared with the TypeScript SDK (spec/examples/canonicalization/)."""

from __future__ import annotations

import hashlib
import json
import math
import random
import struct
from pathlib import Path
from typing import Any, Iterator

import pytest

from grantex.canonical import (
    MAX_DEPTH,
    CanonicalizationError,
    canonicalize,
    canonicalize_bytes,
    serialize_number,
)

EXAMPLES = Path(__file__).resolve().parents[3] / "spec" / "examples" / "canonicalization"
VECTORS = EXAMPLES / "rfc8785"
VECTOR_NAMES = sorted(p.stem for p in (VECTORS / "input").glob("*.json"))


def test_rfc8785_vector_set_is_complete() -> None:
    assert VECTOR_NAMES == ["arrays", "french", "structures", "unicode", "values", "weird"]


@pytest.mark.parametrize("name", VECTOR_NAMES)
def test_rfc8785_test_vectors(name: str) -> None:
    value = json.loads((VECTORS / "input" / f"{name}.json").read_text(encoding="utf-8"))
    expected = (VECTORS / "output" / f"{name}.json").read_bytes()
    expected_hex = bytes.fromhex((VECTORS / "outhex" / f"{name}.txt").read_text(encoding="ascii"))
    assert expected == expected_hex
    assert canonicalize_bytes(value) == expected


def _es6_number_lines() -> Iterator[bytes]:
    fixture = json.loads((EXAMPLES / "es6-numbers.json").read_text(encoding="utf-8"))

    def patterns() -> Iterator[int]:
        for text in fixture["static_u64"]:
            yield int(text, 16)
        for i in range(fixture["serial_count"]):
            yield 0x0010000000000000 + i
        block = bytes(32)
        while True:
            block = hashlib.sha256(block).digest()
            for offset in range(0, 32, 8):
                (pattern,) = struct.unpack("<Q", block[offset:offset + 8])
                (value,) = struct.unpack("<d", block[offset:offset + 8])
                if value == 0.0 or not math.isfinite(value):
                    continue
                yield pattern

    for pattern in patterns():
        (value,) = struct.unpack("<d", struct.pack("<Q", pattern))
        yield f"{pattern:x},{serialize_number(value)}\n".encode("ascii")


def test_es6_number_serialisation_matches_rfc8785_checksums() -> None:
    fixture = json.loads((EXAMPLES / "es6-numbers.json").read_text(encoding="utf-8"))
    targets = {c["lines"]: c for c in fixture["checksums"]}
    assert max(targets) >= 100000
    digest = hashlib.sha256()
    size = 0
    checked = 0
    for count, line in enumerate(_es6_number_lines(), start=1):
        digest.update(line)
        size += len(line)
        if count in targets:
            assert size == targets[count]["bytes"], count
            assert digest.hexdigest() == targets[count]["sha256"], count
            checked += 1
            if count == max(targets):
                break
    assert checked == len(targets)


PARITY = json.loads((EXAMPLES / "parity.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", PARITY["valid"], ids=lambda c: c["name"])
def test_shared_canonicalisation_cases(case: dict[str, Any]) -> None:
    assert canonicalize(json.loads(case["input"])) == case["canonical"]


@pytest.mark.parametrize("case", PARITY["invalid"], ids=lambda c: c["name"])
def test_shared_refused_inputs(case: dict[str, Any]) -> None:
    with pytest.raises(CanonicalizationError):
        canonicalize(json.loads(case["input"]))


def test_negative_zero_and_integer_valued_floats() -> None:
    assert canonicalize([-0.0, 0, 1.0, 1e3, -5.0]) == "[0,0,1,1000,-5]"


def test_integers_must_be_exactly_representable_as_doubles() -> None:
    assert canonicalize(2**53 - 1) == "9007199254740991"
    assert canonicalize(1152921504606847000) == "1152921504606847000"
    assert canonicalize(float(2**60)) == "1152921504606847000"
    for inexact in (2**53 + 1, 2**60):
        with pytest.raises(CanonicalizationError):
            canonicalize(inexact)
    with pytest.raises(CanonicalizationError):
        canonicalize(10**400)


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_non_finite_numbers_refused(value: float) -> None:
    with pytest.raises(CanonicalizationError):
        canonicalize({"n": value})


@pytest.mark.parametrize(
    "value", [{1: "a"}, {("a",): 1}, b"bytes", {1.5}, object(), {"a": {"b": object()}}]
)
def test_values_without_a_json_form_refused(value: Any) -> None:
    with pytest.raises(CanonicalizationError):
        canonicalize(value)


def test_nesting_limit() -> None:
    ok: Any = 1
    for _ in range(MAX_DEPTH):
        ok = [ok]
    canonicalize(ok)
    with pytest.raises(CanonicalizationError):
        canonicalize([ok])
    deep: Any = 1
    for _ in range(MAX_DEPTH + 1):
        deep = {"a": deep}
    with pytest.raises(CanonicalizationError):
        canonicalize(deep)


def test_tuples_are_arrays() -> None:
    assert canonicalize({"a": (1, "x")}) == '{"a":[1,"x"]}'


def test_canonicalisation_is_stable_under_reordering_and_reserialisation() -> None:
    rng = random.Random(8785)

    def random_value(depth: int) -> Any:
        kind = rng.randrange(8 if depth < 4 else 5)
        if kind == 0:
            return None
        if kind == 1:
            return rng.random() < 0.5
        if kind == 2:
            return rng.choice([rng.randint(-10**9, 10**9), rng.uniform(-1e6, 1e6), rng.random() * 10 ** rng.randint(-30, 30)])
        if kind in (3, 4):
            return "".join(chr(rng.choice([rng.randint(0x20, 0x7E), rng.randint(0, 0x1F), rng.randint(0xA0, 0xD7FF), rng.randint(0x10000, 0x10FFFF)])) for _ in range(rng.randint(0, 6)))
        if kind in (5, 6):
            return {random_key(): random_value(depth + 1) for _ in range(rng.randint(0, 5))}
        return [random_value(depth + 1) for _ in range(rng.randint(0, 5))]

    def random_key() -> str:
        return "".join(chr(rng.choice([rng.randint(0x41, 0x7A), rng.randint(0xE0, 0xFF), rng.randint(0x1F600, 0x1F64F), rng.randint(0xFB00, 0xFB4F)])) for _ in range(rng.randint(0, 4)))

    def shuffled(value: Any) -> Any:
        if isinstance(value, dict):
            items = list(value.items())
            rng.shuffle(items)
            return {k: shuffled(v) for k, v in items}
        if isinstance(value, list):
            return [shuffled(v) for v in value]
        return value

    for _ in range(500):
        value = random_value(0)
        canonical = canonicalize(value)
        # Re-parse the canonical form: canonicalisation is idempotent.
        assert canonicalize(json.loads(canonical)) == canonical
        text = json.dumps(shuffled(value), indent=rng.choice([None, 1, 4]), ensure_ascii=rng.random() < 0.5)
        assert canonicalize(json.loads(text)) == canonical
