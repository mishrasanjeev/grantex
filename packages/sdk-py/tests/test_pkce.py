"""Tests for PKCE utilities."""
from __future__ import annotations

import base64
import hashlib
import re

from grantex._pkce import generate_pkce, PkceChallenge


def test_generate_pkce_returns_challenge() -> None:
    result = generate_pkce()
    assert isinstance(result, PkceChallenge)
    assert result.code_verifier
    assert result.code_challenge
    assert result.code_challenge_method == "S256"


def test_verifier_is_url_safe_base64() -> None:
    result = generate_pkce()
    # Should only contain URL-safe characters (no +, /, =)
    assert re.match(r"^[A-Za-z0-9_-]+$", result.code_verifier)


def test_verifier_length_43_to_128() -> None:
    result = generate_pkce()
    assert 43 <= len(result.code_verifier) <= 128


def test_challenge_is_s256_of_verifier() -> None:
    result = generate_pkce()
    # Recompute the challenge from the verifier
    digest = hashlib.sha256(result.code_verifier.encode("ascii")).digest()
    expected = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    assert result.code_challenge == expected


def test_multiple_calls_produce_different_values() -> None:
    a = generate_pkce()
    b = generate_pkce()
    assert a.code_verifier != b.code_verifier
    assert a.code_challenge != b.code_challenge


def test_pkce_challenge_is_frozen() -> None:
    result = generate_pkce()
    import pytest

    with pytest.raises(AttributeError):
        result.code_verifier = "mutated"  # type: ignore[misc]


def test_challenge_is_url_safe_base64() -> None:
    result = generate_pkce()
    # Should only contain URL-safe characters
    assert re.match(r"^[A-Za-z0-9_-]+$", result.code_challenge)
