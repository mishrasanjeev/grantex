# SPDX-License-Identifier: Apache-2.0
"""The signing profile of spec/verification.md with keys generated for the run.

Both algorithms end to end, the adversarial cases, and the refusals that are
programming errors rather than denials. Mirrors
packages/agent-httpsig/tests/profile.test.ts.
"""

from __future__ import annotations

import base64
import json
import re
import threading
import time
from typing import Any, Callable, Optional

import pytest
from cryptography.hazmat.primitives.asymmetric import ec, ed25519

from grantex_agent_httpsig import (
    AgentHttpSigError,
    HttpRequest,
    InMemoryNonceStore,
    Item,
    NonceStore,
    SignResult,
    VerifyResult,
    jwk_thumbprint,
    parse_dictionary,
    private_jwk_from_key,
    public_jwk,
    sign,
    verify,
)

PASSPORT = "passport-placeholder.shopper-01.issuer.example~disclosure~kb"
GRANT = "grant-placeholder.shopper-01.nimbus-shopper-2.4"
NOW = 1_790_000_000
BODY = b'{"cart_id":"c-1001"}'

KEYS: dict[str, dict[str, str]] = {
    "ed25519": private_jwk_from_key(ed25519.Ed25519PrivateKey.generate()),
    "ecdsa-p256-sha256": private_jwk_from_key(ec.generate_private_key(ec.SECP256R1())),
}
ED = KEYS["ed25519"]


def signed(
    key: dict[str, str],
    url: str = "https://merchant.example/v1/checkout",
    body: Any = BODY,
    **overrides: Any,
) -> tuple[HttpRequest, SignResult]:
    options: dict[str, Any] = {
        "agent_passport": PASSPORT,
        "agent_grant": GRANT,
        "created": NOW,
        **overrides,
    }
    result = sign(HttpRequest("POST", url, {}, body), key=key, **options)
    return HttpRequest("POST", url, dict(result.headers), body), result


def run_verify(
    request: HttpRequest,
    key: dict[str, str],
    *,
    nonce_store: Optional[NonceStore] = None,
    resolve_key: Optional[Callable[[str], Optional[dict[str, Any]]]] = None,
    **overrides: Any,
) -> VerifyResult:
    pub = public_jwk(key)
    kid = jwk_thumbprint(pub)

    def default_resolver(keyid: str) -> Optional[dict[str, Any]]:
        return pub if keyid == kid else None

    options: dict[str, Any] = {
        "expected_authority": "merchant.example",
        "now": NOW + 5,
        **overrides,
    }
    return verify(
        request,
        nonce_store=nonce_store if nonce_store is not None else InMemoryNonceStore(clock=lambda: NOW),
        resolve_key=resolve_key or default_resolver,
        **options,
    )


def denial(result: VerifyResult) -> tuple[bool, Optional[str], Optional[str]]:
    return (result.ok, result.code, result.reason)


@pytest.mark.parametrize("alg", sorted(KEYS))
class TestEndToEnd:
    def test_verifies_and_returns_the_presentations(self, alg: str) -> None:
        request, result = signed(KEYS[alg], agent_trust="trust-mark-placeholder.shopper-01")
        assert result.alg == alg
        assert result.expires - result.created == 60
        assert re.fullmatch(r"[A-Za-z0-9_-]{43}", result.nonce)
        out = run_verify(request, KEYS[alg])
        assert out.ok, out.reason
        assert out.alg == alg
        assert out.keyid == jwk_thumbprint(KEYS[alg])
        assert (out.created, out.expires) == (NOW, NOW + 60)
        assert (out.agent_passport, out.agent_grant) == (PASSPORT, GRANT)
        assert out.agent_trust == "trust-mark-placeholder.shopper-01"

    def test_signature_is_64_octets_not_der(self, alg: str) -> None:
        _, result = signed(KEYS[alg])
        member = parse_dictionary(result.headers["Signature"])["sig1"]
        assert isinstance(member, Item) and isinstance(member.value, bytes)
        assert len(member.value) == 64

    def test_swapped_passport_and_grant_under_a_valid_signature(self, alg: str) -> None:
        request, _ = signed(KEYS[alg])
        headers = dict(request.headers)  # type: ignore[arg-type]
        headers["Agent-Passport"], headers["Agent-Grant"] = (
            headers["Agent-Grant"],
            headers["Agent-Passport"],
        )
        swapped = HttpRequest(request.method, request.url, headers, request.body)
        assert denial(run_verify(swapped, KEYS[alg])) == (
            False,
            "request_signature_invalid",
            "signature_mismatch",
        )

    def test_replayed_nonce(self, alg: str) -> None:
        request, _ = signed(KEYS[alg])
        store = InMemoryNonceStore(clock=lambda: NOW)
        assert run_verify(request, KEYS[alg], nonce_store=store).ok
        assert denial(run_verify(request, KEYS[alg], nonce_store=store)) == (
            False,
            "request_signature_invalid",
            "nonce_replayed",
        )

    def test_authority_mismatch(self, alg: str) -> None:
        request, _ = signed(KEYS[alg])
        other = "other-merchant.example"
        assert denial(run_verify(request, KEYS[alg], expected_authority=other)) == (
            False,
            "request_signature_invalid",
            "authority_mismatch",
        )
        relayed = HttpRequest(request.method, "/v1/checkout", request.headers, request.body)
        assert denial(run_verify(relayed, KEYS[alg], expected_authority=other)) == (
            False,
            "request_signature_invalid",
            "signature_mismatch",
        )

    def test_stale(self, alg: str) -> None:
        request, _ = signed(KEYS[alg], expires=NOW + 300)
        assert run_verify(request, KEYS[alg], now=NOW + 300 + 9).ok
        again, _ = signed(KEYS[alg], expires=NOW + 300, nonce="another-nonce-0000000000000")
        assert denial(run_verify(again, KEYS[alg], now=NOW + 300 + 10)) == (
            False,
            "request_signature_stale",
            "expired",
        )


class TestLargePresentations:
    big = "passport-placeholder.shopper-01" + "~disclosure" * 620

    def test_carried_in_the_body_and_checked(self) -> None:
        body = json.dumps(
            {"cart_id": "c-1", "agent_credentials": {"agent_passport": self.big}}
        )
        request, result = signed(ED, body=body, agent_passport=self.big)
        assert re.fullmatch(
            r"body;sha-256=:[A-Za-z0-9+/]{43}=:", result.headers["Agent-Passport"]
        )
        out = run_verify(request, ED)
        assert out.ok and out.agent_passport == self.big

    def test_cannot_be_signed_unless_the_body_carries_them(self) -> None:
        with pytest.raises(AgentHttpSigError):
            signed(ED, agent_passport=self.big)
        other = json.dumps({"agent_credentials": {"agent_passport": self.big + "x"}})
        with pytest.raises(AgentHttpSigError):
            signed(ED, body=other, agent_passport=self.big)

    def _with_note(self, note: str) -> str:
        return (
            '{"cart_id":"c-1","agent_credentials":{"agent_passport":"%s"},"note":%s}'
            % (self.big, note)
        )

    def test_read_only_from_content_nested_at_most_64_deep(self) -> None:
        deep = self._with_note("[" * 64 + "]" * 64)
        with pytest.raises(AgentHttpSigError, match="nested more than 64 deep"):
            signed(ED, body=deep, agent_passport=self.big)
        request, _ = signed(ED, body=self._with_note("[" * 63 + "]" * 63), agent_passport=self.big)
        assert run_verify(request, ED).ok

    def test_numbers_of_any_length_are_read(self) -> None:
        request, _ = signed(ED, body=self._with_note("9" * 5000), agent_passport=self.big)
        out = run_verify(request, ED)
        assert out.ok and out.agent_passport == self.big


class TestSignRefusals:
    def test_window(self) -> None:
        with pytest.raises(AgentHttpSigError, match="300"):
            signed(ED, expires=NOW + 301)
        with pytest.raises(AgentHttpSigError):
            signed(ED, expires=NOW)

    def test_tag(self) -> None:
        with pytest.raises(AgentHttpSigError):
            signed(ED, tag="web-bot-auth")
        signed(ED, tag="agent-payer-auth")

    def test_keyid(self) -> None:
        with pytest.raises(AgentHttpSigError):
            signed(ED, keyid=jwk_thumbprint(KEYS["ecdsa-p256-sha256"]))
        signed(ED, keyid=jwk_thumbprint(ED))

    def test_public_or_mismatched_key(self) -> None:
        with pytest.raises(AgentHttpSigError):
            signed(public_jwk(ED))  # type: ignore[arg-type]
        other = private_jwk_from_key(ed25519.Ed25519PrivateKey.generate())
        with pytest.raises(AgentHttpSigError):
            signed({**ED, "x": other["x"]})

    def test_unsupported_key_or_conflicting_alg(self) -> None:
        numbers = ec.generate_private_key(ec.SECP384R1()).private_numbers()

        def b64u(n: int) -> str:
            return base64.urlsafe_b64encode(n.to_bytes(48, "big")).rstrip(b"=").decode()

        p384 = {
            "kty": "EC",
            "crv": "P-384",
            "x": b64u(numbers.public_numbers.x),
            "y": b64u(numbers.public_numbers.y),
            "d": b64u(numbers.private_value),
        }
        with pytest.raises(AgentHttpSigError):
            signed(p384)
        with pytest.raises(AgentHttpSigError):
            private_jwk_from_key(ec.generate_private_key(ec.SECP384R1()))
        with pytest.raises(AgentHttpSigError):
            signed({**ED, "alg": "ES256"})
        signed({**ED, "alg": "EdDSA"})

    def test_nonce(self) -> None:
        with pytest.raises(AgentHttpSigError):
            signed(ED, nonce="short")
        with pytest.raises(AgentHttpSigError):
            signed(ED, nonce="has space in it 0000000000")

    def test_url(self) -> None:
        for url in ("/v1/checkout", "ftp://merchant.example/x", "https://user@merchant.example/x"):
            with pytest.raises(AgentHttpSigError):
                signed(ED, url=url)

    def test_presentations(self) -> None:
        with pytest.raises(AgentHttpSigError):
            signed(ED, agent_passport="")
        with pytest.raises(AgentHttpSigError):
            signed(ED, agent_grant="has space")
        with pytest.raises(AgentHttpSigError):
            signed(ED, agent_grant="café")


class TestVerifyFailsClosed:
    def test_key_resolver_failure_is_raised(self) -> None:
        request, _ = signed(ED)

        def failing(keyid: str) -> Optional[dict[str, Any]]:
            raise RuntimeError("registry unavailable")

        with pytest.raises(RuntimeError, match="registry unavailable"):
            run_verify(request, ED, resolve_key=failing)

    def test_nonce_store_failure_is_raised(self) -> None:
        request, _ = signed(ED)

        class Failing:
            def check_and_store(self, keyid: str, nonce: str, expires_at: int) -> bool:
                raise RuntimeError("store unavailable")

        with pytest.raises(RuntimeError, match="store unavailable"):
            run_verify(request, ED, nonce_store=Failing())

    def test_failed_request_does_not_record_its_nonce(self) -> None:
        request, _ = signed(ED)
        store = InMemoryNonceStore(clock=lambda: NOW)
        tampered = HttpRequest(request.method, request.url, request.headers, b'{"cart_id":"c-9999"}')
        assert run_verify(tampered, ED, nonce_store=store).reason == "content_digest_mismatch"
        assert run_verify(request, ED, nonce_store=store).ok

    def test_resolved_private_key_is_denied(self) -> None:
        request, _ = signed(ED)
        result = run_verify(request, ED, resolve_key=lambda keyid: dict(ED))
        assert result.reason == "key_mismatch"

    def test_configuration_errors(self) -> None:
        request, _ = signed(ED)
        with pytest.raises(AgentHttpSigError):
            run_verify(request, ED, clock_skew_seconds=61)
        with pytest.raises(AgentHttpSigError):
            run_verify(request, ED, expected_authority="https://merchant.example")
        with pytest.raises(AgentHttpSigError):
            run_verify(request, ED, expected_authority="")
        # A default port would never match @authority (spec section 4.1).
        with pytest.raises(AgentHttpSigError, match="default port"):
            run_verify(request, ED, expected_authority="merchant.example:443")
        with pytest.raises(AgentHttpSigError, match="default port"):
            run_verify(request, ED, expected_authority="merchant.example:80")
        assert run_verify(request, ED, expected_authority="merchant.example:8443").reason == (
            "authority_mismatch"
        )

    @pytest.mark.parametrize("now", [float("nan"), float("inf"), float("-inf"), -1, True, "1790000005"])
    def test_unusable_now_is_refused(self, now: Any) -> None:
        # NaN makes both time comparisons false, so a stale signature would
        # pass them; a verifier clock that is not a finite, non-negative
        # number is a configuration error and nothing is answered.
        request, _ = signed(ED)
        stale = NOW + 300 + 10
        assert denial(run_verify(request, ED, now=stale))[2] == "expired"
        with pytest.raises(AgentHttpSigError, match="now must be"):
            run_verify(request, ED, now=now)

    def test_expected_authority_is_case_insensitive(self) -> None:
        request, _ = signed(ED)
        assert run_verify(request, ED, expected_authority="Merchant.Example").ok


def test_in_memory_nonce_store_forgets_expired_nonces() -> None:
    now = [1000]
    store = InMemoryNonceStore(clock=lambda: now[0])
    assert store.check_and_store("k", "n", 1010) is True
    assert store.check_and_store("k", "n", 1010) is False
    now[0] = 1011
    assert store.check_and_store("k", "n", 1020) is True


class _SlowLookups(dict):  # type: ignore[type-arg]
    """A dict whose membership test yields to other threads, so a check and
    the store that follows it interleave unless the store is atomic."""

    def __contains__(self, key: object) -> bool:
        found = super().__contains__(key)
        time.sleep(0.05)
        return found


def test_in_memory_nonce_store_is_atomic_across_threads() -> None:
    request, _ = signed(ED)
    store = InMemoryNonceStore(clock=lambda: NOW)
    store._seen = _SlowLookups()  # type: ignore[assignment]
    threads_count = 8
    barrier = threading.Barrier(threads_count)
    results: list[VerifyResult] = []
    lock = threading.Lock()

    def worker() -> None:
        barrier.wait()
        result = run_verify(request, ED, nonce_store=store)
        with lock:
            results.append(result)

    threads = [threading.Thread(target=worker) for _ in range(threads_count)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(results) == threads_count
    assert sum(1 for r in results if r.ok) == 1
    assert sorted(r.reason for r in results if not r.ok) == ["nonce_replayed"] * (threads_count - 1)


def test_request_shapes() -> None:
    request, _ = signed(ED)
    pairs = list(request.headers.items())  # type: ignore[union-attr]
    assert run_verify(HttpRequest(request.method, request.url, pairs, request.body), ED).ok
    as_text = HttpRequest(request.method, request.url, request.headers, BODY.decode())
    assert run_verify(as_text, ED).ok
