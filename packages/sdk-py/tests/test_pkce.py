"""Tests for PKCE utilities — verifier/challenge generation and validation."""
from __future__ import annotations

import base64
import hashlib
import re

import pytest

from grantex._pkce import generate_pkce, PkceChallenge


# ── Basic Generation ──────────────────────────────────────────────────────

def test_generate_pkce_returns_challenge() -> None:
    result = generate_pkce()
    assert isinstance(result, PkceChallenge)
    assert result.code_verifier
    assert result.code_challenge
    assert result.code_challenge_method == "S256"


def test_generate_pkce_returns_non_empty_strings() -> None:
    result = generate_pkce()
    assert len(result.code_verifier) > 0
    assert len(result.code_challenge) > 0
    assert len(result.code_challenge_method) > 0


# ── Verifier Validation ──────────────────────────────────────────────────

def test_verifier_is_url_safe_base64() -> None:
    result = generate_pkce()
    # Should only contain URL-safe characters (no +, /, =)
    assert re.match(r"^[A-Za-z0-9_-]+$", result.code_verifier)


def test_verifier_length_43_to_128() -> None:
    result = generate_pkce()
    assert 43 <= len(result.code_verifier) <= 128


def test_verifier_length_consistent_across_calls() -> None:
    """All verifiers should be the same length since we use 32 random bytes."""
    lengths = {len(generate_pkce().code_verifier) for _ in range(20)}
    assert len(lengths) == 1, f"Expected uniform verifier length, got {lengths}"


def test_verifier_contains_only_ascii() -> None:
    result = generate_pkce()
    assert result.code_verifier.isascii()


def test_verifier_no_padding_chars() -> None:
    """URL-safe base64 should not contain padding '=' characters."""
    for _ in range(10):
        result = generate_pkce()
        assert "=" not in result.code_verifier


# ── Challenge Validation ─────────────────────────────────────────────────

def test_challenge_is_s256_of_verifier() -> None:
    result = generate_pkce()
    # Recompute the challenge from the verifier
    digest = hashlib.sha256(result.code_verifier.encode("ascii")).digest()
    expected = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    assert result.code_challenge == expected


def test_challenge_is_url_safe_base64() -> None:
    result = generate_pkce()
    # Should only contain URL-safe characters
    assert re.match(r"^[A-Za-z0-9_-]+$", result.code_challenge)


def test_challenge_no_padding_chars() -> None:
    for _ in range(10):
        result = generate_pkce()
        assert "=" not in result.code_challenge


def test_challenge_has_expected_length() -> None:
    """SHA-256 digest = 32 bytes, base64url without padding = 43 chars."""
    result = generate_pkce()
    assert len(result.code_challenge) == 43


def test_challenge_method_is_always_s256() -> None:
    for _ in range(10):
        result = generate_pkce()
        assert result.code_challenge_method == "S256"


# ── Uniqueness ────────────────────────────────────────────────────────────

def test_multiple_calls_produce_different_verifiers() -> None:
    a = generate_pkce()
    b = generate_pkce()
    assert a.code_verifier != b.code_verifier


def test_multiple_calls_produce_different_challenges() -> None:
    a = generate_pkce()
    b = generate_pkce()
    assert a.code_challenge != b.code_challenge


def test_100_unique_verifiers() -> None:
    verifiers = {generate_pkce().code_verifier for _ in range(100)}
    assert len(verifiers) == 100, "Expected 100 unique verifiers"


def test_100_unique_challenges() -> None:
    challenges = {generate_pkce().code_challenge for _ in range(100)}
    assert len(challenges) == 100, "Expected 100 unique challenges"


# ── Immutability ─────────────────────────────────────────────────────────

def test_pkce_challenge_is_frozen() -> None:
    result = generate_pkce()
    with pytest.raises(AttributeError):
        result.code_verifier = "mutated"  # type: ignore[misc]


def test_pkce_challenge_challenge_is_frozen() -> None:
    result = generate_pkce()
    with pytest.raises(AttributeError):
        result.code_challenge = "mutated"  # type: ignore[misc]


def test_pkce_challenge_method_is_frozen() -> None:
    result = generate_pkce()
    with pytest.raises(AttributeError):
        result.code_challenge_method = "S384"  # type: ignore[misc]


# ── Cross-verification ───────────────────────────────────────────────────

def test_verifier_challenge_pair_validates_cross_check() -> None:
    """Simulate what a server would do: verify the challenge matches."""
    pkce = generate_pkce()

    # Server receives code_verifier and code_challenge
    server_digest = hashlib.sha256(pkce.code_verifier.encode("ascii")).digest()
    server_challenge = base64.urlsafe_b64encode(server_digest).rstrip(b"=").decode("ascii")

    assert server_challenge == pkce.code_challenge


def test_wrong_verifier_does_not_match_challenge() -> None:
    """A different verifier should produce a different challenge."""
    pkce = generate_pkce()

    wrong_digest = hashlib.sha256(b"wrong-verifier").digest()
    wrong_challenge = base64.urlsafe_b64encode(wrong_digest).rstrip(b"=").decode("ascii")

    assert wrong_challenge != pkce.code_challenge


def test_deterministic_challenge_for_same_verifier() -> None:
    """Same verifier should always produce the same challenge."""
    pkce = generate_pkce()
    verifier = pkce.code_verifier

    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge_1 = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    challenge_2 = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")

    assert challenge_1 == challenge_2 == pkce.code_challenge
