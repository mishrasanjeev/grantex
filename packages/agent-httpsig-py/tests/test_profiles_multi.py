# SPDX-License-Identifier: Apache-2.0
"""The profile-driven signer and verifier.

The grantex profile unchanged (the shared vectors through sign_with_profile
and verify_with_profile), Visa TAP and Web Bot Auth end to end with both key
types, their refusals, and the RFC 9421 component parameters they need.
Mirrors packages/agent-httpsig/tests/profiles.test.ts.
"""

from __future__ import annotations

from typing import Any, Dict, List

import pytest
from cryptography.hazmat.primitives.asymmetric import ec, ed25519

from grantex_agent_httpsig import (
    COVERED_COMPONENTS,
    SIGNATURE_PROFILES,
    TAP_BROWSER_TAG,
    AgentHttpSigError,
    HttpRequest,
    HttpResponse,
    InMemoryNonceStore,
    KeyReference,
    SignatureAgent,
    jwk_thumbprint,
    parse_signature_agent,
    private_jwk_from_key,
    public_jwk,
    serialize_signature_agent,
    sign,
    sign_with_profile,
    signature_base_for,
    verify_with_profile,
)

from .conftest import VECTORS, vector_private_key

NOW = 1_790_000_000
KEYS = {
    "ed25519": private_jwk_from_key(ed25519.Ed25519PrivateKey.generate()),
    "ecdsa-p256-sha256": private_jwk_from_key(ec.generate_private_key(ec.SECP256R1())),
}


def _request(**headers: str) -> HttpRequest:
    h = {"content-type": "application/json"}
    h.update(headers)
    return HttpRequest(
        "POST", "https://merchant.example/v1/checkout?cart=c-1001", h, '{"cart_id":"c-1001"}'
    )


def _with(req: HttpRequest, headers: Dict[str, str]) -> HttpRequest:
    merged = dict(req.headers)  # type: ignore[arg-type]
    merged.update(headers)
    return HttpRequest(req.method, req.url, merged, req.body)


# ── grantex (unchanged default) ──────────────────────────────────────────────


def test_grantex_profile_definition_matches_the_vectors() -> None:
    grantex = SIGNATURE_PROFILES["grantex"]
    assert grantex.tags == (VECTORS["profile"]["tag"],)
    assert grantex.default_components == COVERED_COMPONENTS
    assert grantex.max_window_seconds == VECTORS["profile"]["max_window_seconds"]


@pytest.mark.parametrize("v", VECTORS["sign"], ids=lambda v: v["name"])
def test_sign_with_profile_default_reproduces_sign_vectors(v: Dict[str, Any]) -> None:
    pres = v["presentations"]
    options: Dict[str, Any] = dict(
        key=vector_private_key(v["key"]),
        agent_passport=pres["agent_passport"],
        agent_grant=pres["agent_grant"],
        created=v["params"]["created"],
        expires=v["params"]["expires"],
        nonce=v["params"]["nonce"],
        label=v["params"]["label"],
    )
    if pres.get("agent_trust"):
        options["agent_trust"] = pres["agent_trust"]
    req = HttpRequest(v["request"]["method"], v["request"]["url"], [], v["request"]["body"])
    implicit = sign_with_profile(req, **options)
    explicit = sign_with_profile(req, profile="grantex", **options)
    direct = sign(req, **options)
    assert implicit.headers == direct.headers == explicit.headers
    assert [list(x) for x in implicit.headers.items()] == v["headers"]
    assert implicit.signature_base == v["signature_base"]


@pytest.mark.parametrize("v", VECTORS["verify"], ids=lambda v: v["name"])
def test_verify_with_profile_default_answers_verify_vectors(v: Dict[str, Any]) -> None:
    store = InMemoryNonceStore(lambda: v["now"])
    for k, n in v["seen_nonces"]:
        store.check_and_store(k, n, v["now"] + 3600)
    pub = VECTORS["keys"][v["key"]]["public_jwk"]
    r = v["request"]
    out = verify_with_profile(
        HttpRequest(r["method"], r["url"], r["headers"], r["body"]),
        resolve_key=lambda _kid: pub if v["key_known"] else None,
        expected_authority=v["expected_authority"],
        nonce_store=store,
        now=v["now"],
    )
    assert out.profile == "grantex"
    if v["expected"]["ok"]:
        assert out.ok and out.tag == "agent-payer-auth" and out.grantex is not None
    else:
        assert (out.ok, out.code, out.reason) == (False, v["expected"]["code"], v["expected"]["reason"])


# ── RFC 9421 component parameters ────────────────────────────────────────────


def test_rfc9421_2_1_2_dictionary_members() -> None:
    message = HttpRequest(
        "GET",
        "https://example.com/",
        [
            ("Example-Dict", " a=1,    b=2;x=1;y=2,   c=(a   b   c), d"),
            (
                "Signature-Input",
                'sig1=("example-dict";key="a" "example-dict";key="d" '
                '"example-dict";key="b" "example-dict";key="c");created=1',
            ),
        ],
    )
    assert signature_base_for(message, "sig1").split("\n")[:4] == [
        '"example-dict";key="a": 1',
        '"example-dict";key="d": ?1',
        '"example-dict";key="b": 2;x=1;y=2',
        '"example-dict";key="c": (a b c)',
    ]
    missing = HttpRequest(
        "GET", "https://example.com/",
        [("Example-Dict", "a=1"), ("Signature-Input", 'sig1=("example-dict";key="z");created=1')],
    )
    with pytest.raises(AgentHttpSigError):
        signature_base_for(missing, "sig1")


def test_rfc9421_2_2_2_target_uri() -> None:
    message = HttpRequest(
        "POST", "https://www.example.com/path?param=value",
        [("Signature-Input", 'sig1=("@target-uri");created=1')],
    )
    assert signature_base_for(message, "sig1").split("\n")[0] == (
        '"@target-uri": https://www.example.com/path?param=value'
    )


def test_rfc9421_2_4_req_reads_the_related_request() -> None:
    related = HttpRequest("POST", "https://example.com/foo?param=Value&Pet=dog")
    response = HttpResponse(
        503,
        [
            ("Content-Type", "application/json"),
            (
                "Signature-Input",
                'reqres=("@status" "content-type" "@authority";req "@method";req "@path";req)'
                ";created=1618884479",
            ),
        ],
    )
    assert signature_base_for(response, "reqres", related) == "\n".join(
        [
            '"@status": 503',
            '"content-type": application/json',
            '"@authority";req: example.com',
            '"@method";req: POST',
            '"@path";req: /foo',
            '"@signature-params": ("@status" "content-type" "@authority";req "@method";req '
            '"@path";req);created=1618884479',
        ]
    )
    with pytest.raises(AgentHttpSigError, match="related request"):
        signature_base_for(response, "reqres")


def test_web_bot_auth_draft_example_base() -> None:
    message = HttpRequest(
        "GET",
        "https://origin.example.com/path/to/resource",
        [
            (
                "Signature-Input",
                'sig=("@authority" "signature-agent";key="sig");created=1700000000;'
                'expires=1700011111;keyid="ba3e64==";tag="web-bot-auth"',
            ),
            ("Signature-Agent", 'sig="https://signer.example.com"'),
        ],
    )
    assert signature_base_for(message, "sig") == "\n".join(
        [
            '"@authority": origin.example.com',
            '"signature-agent";key="sig": "https://signer.example.com"',
            '"@signature-params": ("@authority" "signature-agent";key="sig");'
            'created=1700000000;expires=1700011111;keyid="ba3e64==";tag="web-bot-auth"',
        ]
    )


# ── TAP ──────────────────────────────────────────────────────────────────────


def _tap_kwargs(key: Dict[str, str], keyid: str, seen: List[KeyReference], **extra: Any) -> Dict[str, Any]:
    pub = public_jwk(key)

    def resolve(ref: KeyReference) -> Any:
        seen.append(ref)
        return pub if ref.keyid == keyid else None

    kwargs: Dict[str, Any] = dict(
        profile="tap",
        resolve_key=resolve,
        expected_authority="merchant.example",
        nonce_store=InMemoryNonceStore(lambda: NOW),
        now=NOW + 5,
    )
    kwargs.update(extra)
    return kwargs


@pytest.mark.parametrize("alg", sorted(KEYS))
def test_tap_sign_and_verify(alg: str) -> None:
    key = KEYS[alg]
    req = _request()
    signed = sign_with_profile(req, profile="tap", key=key, keyid="primary-key-01", created=NOW)
    assert signed.tag == "agent-payer-auth"
    assert signed.expires - signed.created == 480
    assert signed.headers["Signature-Input"] == (
        'sig1=("@authority" "@path");created=%d;expires=%d;keyid="primary-key-01";'
        'alg="%s";nonce="%s";tag="agent-payer-auth"' % (NOW, NOW + 480, alg, signed.nonce)
    )
    seen: List[KeyReference] = []
    out = verify_with_profile(_with(req, signed.headers), **_tap_kwargs(key, "primary-key-01", seen))
    assert out.ok and out.profile == "tap" and out.alg == alg and out.nonce == signed.nonce
    assert seen == [KeyReference("tap", "agent-payer-auth", "primary-key-01", None)]


@pytest.mark.parametrize("alg", sorted(KEYS))
def test_tap_content_digest(alg: str) -> None:
    key = KEYS[alg]
    req = _request()
    signed = sign_with_profile(
        req, profile="tap", key=key, keyid="k1", tag=TAP_BROWSER_TAG, created=NOW,
        components=["@method", "@authority", "@path", "content-type", "content-digest"],
    )
    good = _with(req, signed.headers)
    assert verify_with_profile(good, **_tap_kwargs(key, "k1", [], required_components=["content-digest"])).ok
    tampered = HttpRequest(good.method, good.url, good.headers, '{"cart_id":"c-9999"}')
    assert verify_with_profile(tampered, **_tap_kwargs(key, "k1", [])).reason == "content_digest_mismatch"


def test_tap_refusals() -> None:
    key = KEYS["ed25519"]
    with pytest.raises(AgentHttpSigError, match="1 to 480"):
        sign_with_profile(_request(), profile="tap", key=key, created=NOW, expires=NOW + 481)
    with pytest.raises(AgentHttpSigError, match="@authority and @path"):
        sign_with_profile(_request(), profile="tap", key=key, components=["@authority"])

    def signed(**kw: Any) -> HttpRequest:
        args: Dict[str, Any] = dict(profile="tap", key=key, keyid="k1", created=NOW)
        args.update(kw)
        return _with(_request(), sign_with_profile(_request(), **args).headers)

    assert verify_with_profile(signed(), **_tap_kwargs(key, "k1", [], now=NOW + 490)).reason == "expired"
    assert verify_with_profile(signed(), **_tap_kwargs(key, "k1", [], now=NOW - 60)).reason == "created_in_future"
    assert verify_with_profile(signed(), **_tap_kwargs(key, "k1", [], tags=["agent-browser-auth"])).reason == "tag_not_accepted"
    assert verify_with_profile(signed(), **_tap_kwargs(key, "other", [])).reason == "key_unknown"

    # A nonce seen in the last 8 minutes is refused even after the first signature expired.
    store = InMemoryNonceStore(lambda: NOW + 100)
    first = signed(nonce="session-123", expires=NOW + 60)
    assert verify_with_profile(first, **_tap_kwargs(key, "k1", [], nonce_store=store)).ok
    second = signed(nonce="session-123", created=NOW + 100)
    assert verify_with_profile(second, **_tap_kwargs(key, "k1", [], nonce_store=store, now=NOW + 105)).reason == "nonce_replayed"

    # The nonce is the same in every signature of the message.
    one = signed(nonce="n-1")
    other = sign_with_profile(_request(), profile="tap", key=key, keyid="k1", created=NOW, nonce="n-2", label="sig2", tag=TAP_BROWSER_TAG)
    h = dict(one.headers)  # type: ignore[arg-type]
    h["Signature-Input"] += ", " + other.headers["Signature-Input"]
    h["Signature"] += ", " + other.headers["Signature"]
    both = HttpRequest(one.method, one.url, h, one.body)
    assert verify_with_profile(both, **_tap_kwargs(key, "k1", [], label="sig1")).reason == "nonce_mismatch"

    # An alg parameter that does not name the key's algorithm.
    plain = signed(include_alg=False)
    swapped = dict(plain.headers)  # type: ignore[arg-type]
    swapped["Signature-Input"] = swapped["Signature-Input"].replace(";nonce", ';alg="ecdsa-p256-sha256";nonce')
    assert verify_with_profile(HttpRequest(plain.method, plain.url, swapped, plain.body), **_tap_kwargs(key, "k1", [])).reason == "algorithm_mismatch"


def test_tap_signature_is_not_read_as_the_grantex_profile() -> None:
    key = KEYS["ed25519"]
    req = _with(_request(), sign_with_profile(_request(), profile="tap", key=key, keyid="k1", created=NOW).headers)
    out = verify_with_profile(
        req, resolve_key=lambda _k: public_jwk(key), expected_authority="merchant.example",
        nonce_store=InMemoryNonceStore(), now=NOW + 5,
    )
    assert (out.ok, out.profile, out.reason) == (False, "grantex", "covered_components_mismatch")


# ── Web Bot Auth ─────────────────────────────────────────────────────────────


def _wba_kwargs(key: Dict[str, str], seen: List[KeyReference], **extra: Any) -> Dict[str, Any]:
    pub = public_jwk(key)
    kid = jwk_thumbprint(pub)

    def resolve(ref: KeyReference) -> Any:
        seen.append(ref)
        ok = ref.signature_agent is not None and ref.signature_agent.url == "https://agents.example"
        return pub if ok and ref.keyid == kid else None

    kwargs: Dict[str, Any] = dict(
        profile="web-bot-auth",
        resolve_key=resolve,
        expected_authority="merchant.example",
        nonce_store=InMemoryNonceStore(lambda: NOW),
        now=NOW + 5,
    )
    kwargs.update(extra)
    return kwargs


@pytest.mark.parametrize("alg", sorted(KEYS))
def test_web_bot_auth_sign_and_verify(alg: str) -> None:
    key = KEYS[alg]
    req = _request()
    signed = sign_with_profile(
        req, profile="web-bot-auth", key=key, created=NOW, signature_agent_url="https://agents.example"
    )
    kid = jwk_thumbprint(key)
    assert signed.headers["Signature-Agent"] == 'sig1="https://agents.example"'
    assert signed.headers["Signature-Input"] == (
        'sig1=("@authority" "signature-agent";key="sig1");created=%d;expires=%d;keyid="%s";'
        'nonce="%s";tag="web-bot-auth"' % (NOW, NOW + 300, kid, signed.nonce)
    )
    seen: List[KeyReference] = []
    out = verify_with_profile(_with(req, signed.headers), **_wba_kwargs(key, seen))
    assert out.ok and out.keyid == kid and out.alg == alg
    assert out.signature_agent == SignatureAgent("sig1", "https://agents.example", "directory")
    assert seen[0].signature_agent is not None

    narrow = sign_with_profile(
        req, profile="web-bot-auth", key=key, created=NOW, nonce=None,
        components=["@method", "@target-uri", "content-digest", "signature-agent"],
        signature_agent_url="https://agents.example", signature_agent_type="jwks_uri",
    )
    assert narrow.headers["Signature-Agent"] == 'sig1="https://agents.example";type=jwks_uri'
    origin_form = _with(req, narrow.headers)
    origin_form = HttpRequest(origin_form.method, "/v1/checkout?cart=c-1001", origin_form.headers, origin_form.body)
    out = verify_with_profile(origin_form, **_wba_kwargs(key, []))
    assert out.ok and out.nonce is None


def test_web_bot_auth_refusals() -> None:
    key = KEYS["ed25519"]

    def signed(**kw: Any) -> HttpRequest:
        args: Dict[str, Any] = dict(profile="web-bot-auth", key=key, created=NOW, signature_agent_url="https://agents.example")
        args.update(kw)
        return _with(_request(), sign_with_profile(_request(), **args).headers)

    with pytest.raises(AgentHttpSigError, match="1 to 86400"):
        signed(expires=NOW + 86_401)
    with pytest.raises(AgentHttpSigError, match="https URL"):
        signed(signature_agent_url="http://agents.example")

    base = signed()
    headers = dict(base.headers)  # type: ignore[arg-type]
    del headers["Signature-Agent"]
    assert verify_with_profile(HttpRequest(base.method, base.url, headers, base.body), **_wba_kwargs(key, [])).reason == "signature_agent_missing"
    headers = dict(base.headers)  # type: ignore[arg-type]
    headers["Signature-Agent"] = 'sig1="https://agents.example";type=other'
    assert verify_with_profile(HttpRequest(base.method, base.url, headers, base.body), **_wba_kwargs(key, [])).reason == "signature_agent_unsupported"
    headers["Signature-Agent"] = 'sig1="https://elsewhere.example"'
    assert verify_with_profile(HttpRequest(base.method, base.url, headers, base.body), **_wba_kwargs(key, [])).reason == "key_unknown"
    other = public_jwk(private_jwk_from_key(ed25519.Ed25519PrivateKey.generate()))
    kw = _wba_kwargs(key, [])
    kw["resolve_key"] = lambda _ref: other
    assert verify_with_profile(base, **kw).reason == "key_mismatch"
    assert verify_with_profile(signed(expires=NOW + 7200), **_wba_kwargs(key, [], max_window_seconds=3600)).reason == "window_too_long"
    kw = _wba_kwargs(key, [])
    assert verify_with_profile(base, **kw).ok
    assert verify_with_profile(base, **kw).reason == "nonce_replayed"


def test_signature_agent_dictionary_form() -> None:
    agents = parse_signature_agent(
        'a="https://one.example", b="https://two.example";type=cimd, '
        'c="http://insecure.example", d=?1, e="https://e.example";type=x'
    )
    assert list(agents) == ["a", "b"]
    assert agents["b"] == SignatureAgent("b", "https://two.example", "cimd")
    assert serialize_signature_agent(list(agents.values())) == (
        'a="https://one.example", b="https://two.example";type=cimd'
    )
