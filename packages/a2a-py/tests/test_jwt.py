"""Tests for JWT decode utilities."""

import base64
import json
import time

from grantex_a2a._jwt import decode_jwt_payload, is_token_expired


def _make_token(payload: dict) -> str:
    header = base64.urlsafe_b64encode(
        json.dumps({"alg": "RS256", "typ": "JWT"}).encode()
    ).decode().rstrip("=")
    body = base64.urlsafe_b64encode(
        json.dumps(payload).encode()
    ).decode().rstrip("=")
    sig = base64.urlsafe_b64encode(b"test-signature").decode().rstrip("=")
    return f"{header}.{body}.{sig}"


def test_decode_valid_token():
    payload = {"iss": "https://grantex.dev", "sub": "user_123", "scp": ["read"]}
    token = _make_token(payload)
    decoded = decode_jwt_payload(token)
    assert decoded["iss"] == "https://grantex.dev"
    assert decoded["sub"] == "user_123"
    assert decoded["scp"] == ["read"]


def test_decode_all_claims():
    payload = {
        "iss": "https://grantex.dev",
        "sub": "user_123",
        "agt": "did:grantex:ag_TEST",
        "dev": "dev_TEST",
        "scp": ["read", "write"],
        "jti": "tok_TEST",
        "grnt": "grnt_TEST",
        "bdg": 42.5,
        "parentAgt": "did:grantex:ag_PARENT",
        "delegationDepth": 1,
    }
    token = _make_token(payload)
    decoded = decode_jwt_payload(token)
    assert decoded["agt"] == "did:grantex:ag_TEST"
    assert decoded["bdg"] == 42.5
    assert decoded["delegationDepth"] == 1


def test_decode_invalid_format():
    try:
        decode_jwt_payload("not-a-jwt")
        assert False, "Should have raised"
    except ValueError as e:
        assert "expected 3 parts" in str(e)


def test_decode_too_few_parts():
    try:
        decode_jwt_payload("header.payload")
        assert False, "Should have raised"
    except ValueError:
        pass


def test_token_not_expired():
    payload = {"exp": int(time.time()) + 3600}
    assert is_token_expired(payload) is False


def test_token_expired():
    payload = {"exp": int(time.time()) - 3600}
    assert is_token_expired(payload) is True


def test_token_no_exp():
    assert is_token_expired({}) is False


def test_token_expired_exactly_now():
    payload = {"exp": int(time.time())}
    assert is_token_expired(payload) is True
