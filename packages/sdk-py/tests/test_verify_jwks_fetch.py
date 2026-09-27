"""With ``bounded_jwks_fetch=True`` the JWKS fetch is bounded, and
``issuer_did`` must be a usable did:web. Without it (the default), both behave
as they did before the option existed.

Whoever operates a JWKS endpoint controls the response, so the bounded
verifier reads at most 64 KiB of it, only as ``application/json`` or
``application/jwk-set+json``, takes at most 128 keys from it, and gives the
whole fetch one deadline. Those checks run against a real HTTP server on the
loopback interface, so the streaming read is exercised rather than a mock of
it. A ``did:web`` issuer is checked against the did:web method specification
before anything is fetched; those cases use respx, since they resolve to
HTTPS URLs on example domains.
"""
from __future__ import annotations

import gzip
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

import httpx
import jwt
import pytest
import respx
from cryptography.hazmat.primitives.asymmetric import ec
from jwt.algorithms import ECAlgorithm

import grantex._verify as verify_module
from grantex import GrantexTokenError, verify_grant_token
from grantex._types import VerifyGrantTokenOptions
from grantex.decisions import DecisionGrantError, verify_decision_grant

ISSUER = "https://issuer.example"

EC_KEY = ec.generate_private_key(ec.SECP256R1())
EC_JWK: Dict[str, Any] = {
    **json.loads(ECAlgorithm.to_jwk(EC_KEY.public_key())),
    "kid": "ec-1",
    "alg": "ES256",
    "use": "sig",
}
JWKS_BODY = json.dumps({"keys": [EC_JWK]}).encode()


def _token(issuer: str = ISSUER) -> str:
    now = int(time.time())
    claims = {
        "iss": issuer,
        "sub": "shopper-01",
        "jti": "tok_jwks_fetch",
        "iat": now,
        "exp": now + 600,
        "scope": "catalog:read",
        "urn:grantex:grant": {
            "agent_did": "did:grantex:ag_jwks_fetch",
            "developer_id": "dev_jwks_fetch",
            "grant_id": "grnt_jwks_fetch",
        },
    }
    return jwt.encode(claims, EC_KEY, algorithm="ES256", headers={"kid": "ec-1", "typ": "at+jwt"})


# ─── A JWKS endpoint on the loopback interface ───────────────────────────────

Route = Callable[[BaseHTTPRequestHandler], None]


class _JwksServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self) -> None:
        super().__init__(("127.0.0.1", 0), _Handler)
        self.routes: Dict[str, Route] = {}
        self.request_headers: List[Dict[str, str]] = []

    def url(self, path: str) -> str:
        return f"http://127.0.0.1:{self.server_address[1]}{path}"


class _Handler(BaseHTTPRequestHandler):
    server: _JwksServer

    def do_GET(self) -> None:  # noqa: N802 - the http.server hook name
        self.server.request_headers.append({k.lower(): v for k, v in self.headers.items()})
        route = self.server.routes[self.path]
        try:
            route(self)
        except OSError:
            # The client hung up part way through, which is what the size cap
            # and the deadline are meant to make it do.
            pass

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        pass


def _respond(
    body: bytes,
    content_type: Optional[str] = "application/json",
    *,
    status: int = 200,
    length: bool = True,
    headers: Tuple[Tuple[str, str], ...] = (),
) -> Route:
    def route(handler: BaseHTTPRequestHandler) -> None:
        handler.send_response(status)
        if content_type is not None:
            handler.send_header("Content-Type", content_type)
        if length:
            handler.send_header("Content-Length", str(len(body)))
        for name, value in headers:
            handler.send_header(name, value)
        handler.end_headers()
        # Without a Content-Length the body ends when the connection closes
        # (HTTP/1.0), so the client can only find its size by reading it.
        for start in range(0, len(body), 8192):
            handler.wfile.write(body[start:start + 8192])
            handler.wfile.flush()

    return route


def _drip(body: bytes, pieces: int, interval: float) -> Route:
    """Send the headers at once, then the body a little at a time: each read
    completes quickly, so only a deadline on the whole fetch stops it."""

    def route(handler: BaseHTTPRequestHandler) -> None:
        handler.send_response(200)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.flush()
        step = max(1, -(-len(body) // pieces))
        for start in range(0, len(body), step):
            time.sleep(interval)
            handler.wfile.write(body[start:start + step])
            handler.wfile.flush()

    return route


def _stall(body: bytes, pause: float) -> Route:
    def route(handler: BaseHTTPRequestHandler) -> None:
        handler.send_response(200)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.flush()
        time.sleep(pause)
        handler.wfile.write(body)

    return route


@pytest.fixture
def server() -> Iterator[_JwksServer]:
    srv = _JwksServer()
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    try:
        yield srv
    finally:
        srv.shutdown()
        srv.server_close()


def _verify(jwks_uri: str, **options: Any) -> Any:
    return verify_grant_token(
        _token(), VerifyGrantTokenOptions(jwks_uri=jwks_uri, issuer=ISSUER, **options)
    )


def _oversized_key_set() -> bytes:
    """A valid key set padded past the 64 KiB cap."""
    return json.dumps({"keys": [EC_JWK], "padding": "x" * (70 * 1024)}).encode()


def _decision_fixture() -> Dict[str, Any]:
    fixture: Dict[str, Any] = json.loads(
        (Path(__file__).resolve().parents[3] / "spec" / "examples" / "decision-grant" / "verification.json")
        .read_text(encoding="utf-8")
    )
    return fixture


def _decision_grant(decisions: Dict[str, Any]) -> str:
    return jwt.encode(
        {**decisions["base_claims"], "iss": ISSUER},
        EC_KEY,
        algorithm="ES256",
        headers={"typ": "decision+jwt", "kid": "ec-1"},
    )


# ─── Bounded fetch ───────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "content_type",
    [
        "application/json",
        "application/json; charset=utf-8",
        "application/jwk-set+json",
        'Application/JWK-Set+JSON; charset="UTF-8"',
    ],
)
def test_a_json_key_set_is_read_and_the_token_verifies(server: _JwksServer, content_type: str) -> None:
    server.routes["/jwks"] = _respond(JWKS_BODY, content_type)
    assert _verify(server.url("/jwks"), bounded_jwks_fetch=True).principal_id == "shopper-01"


def test_the_fetch_asks_for_a_json_key_set_and_an_unencoded_body(server: _JwksServer) -> None:
    server.routes["/jwks"] = _respond(JWKS_BODY)
    _verify(server.url("/jwks"), bounded_jwks_fetch=True)
    sent = server.request_headers[-1]
    assert sent["accept"] == "application/json, application/jwk-set+json"
    assert sent["accept-encoding"] == "identity"


def test_a_response_declaring_more_than_64_kib_is_refused(server: _JwksServer) -> None:
    padded = json.dumps({"keys": [EC_JWK], "padding": "x" * (64 * 1024)}).encode()
    server.routes["/big"] = _respond(padded)
    with pytest.raises(GrantexTokenError, match=r"Failed to fetch JWKS .*larger than 65536 bytes"):
        _verify(server.url("/big"), bounded_jwks_fetch=True)


def test_a_response_without_a_length_is_cut_off_at_64_kib(server: _JwksServer) -> None:
    # One MiB of valid JSON with no Content-Length: the size is only known by
    # reading, and the read has to stop at the cap.
    padded = json.dumps({"keys": [EC_JWK], "padding": "x" * (1024 * 1024)}).encode()
    server.routes["/unbounded"] = _respond(padded, length=False)
    with pytest.raises(GrantexTokenError, match=r"Failed to fetch JWKS .*larger than 65536 bytes"):
        _verify(server.url("/unbounded"), bounded_jwks_fetch=True)


def test_a_response_of_exactly_64_kib_is_read(server: _JwksServer) -> None:
    body = json.dumps({"keys": [EC_JWK], "padding": ""}).encode()
    body = json.dumps({"keys": [EC_JWK], "padding": "x" * (64 * 1024 - len(body))}).encode()
    assert len(body) == 64 * 1024
    server.routes["/edge"] = _respond(body)
    assert _verify(server.url("/edge"), bounded_jwks_fetch=True).token_id == "tok_jwks_fetch"


@pytest.mark.parametrize(
    "content_type",
    [
        "text/html",
        "text/plain",
        "application/octet-stream",
        "application/jwk+json",
        "application/json-seq",
        "application/jsonx",
        "application/json; charset=iso-8859-1",
        "application/json; profile=x",
        None,
    ],
)
def test_a_response_that_is_not_a_json_key_set_is_refused(
    server: _JwksServer, content_type: Optional[str]
) -> None:
    server.routes["/typed"] = _respond(JWKS_BODY, content_type)
    with pytest.raises(GrantexTokenError, match=r"Failed to fetch JWKS .*Content-Type"):
        _verify(server.url("/typed"), bounded_jwks_fetch=True)


def test_a_content_encoded_response_is_refused(server: _JwksServer) -> None:
    # The verifier asks for an unencoded body; a compressed one would let a
    # small download expand past the size cap when it is decoded.
    server.routes["/gzip"] = _respond(gzip.compress(JWKS_BODY), headers=(("Content-Encoding", "gzip"),))
    with pytest.raises(GrantexTokenError, match=r"Failed to fetch JWKS .*Content-Encoding"):
        _verify(server.url("/gzip"), bounded_jwks_fetch=True)


def _key_set(count: int) -> bytes:
    decoys = [{**EC_JWK, "kid": f"decoy-{n}"} for n in range(count - 1)]
    return json.dumps({"keys": [*decoys, EC_JWK]}).encode()


def test_more_than_128_keys_are_refused(server: _JwksServer) -> None:
    server.routes["/many"] = _respond(_key_set(129))
    with pytest.raises(GrantexTokenError, match=r"Failed to fetch JWKS .*129 keys; the limit is 128"):
        _verify(server.url("/many"), bounded_jwks_fetch=True)


def test_128_keys_are_read(server: _JwksServer) -> None:
    server.routes["/max"] = _respond(_key_set(128))
    assert _verify(server.url("/max"), bounded_jwks_fetch=True).token_id == "tok_jwks_fetch"


def test_a_response_trickling_past_the_deadline_is_abandoned(
    server: _JwksServer, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Every piece arrives well inside any per-read timeout; only a deadline
    # on the whole fetch ends it.
    monkeypatch.setattr(verify_module, "_JWKS_FETCH_DEADLINE_SECONDS", 0.5, raising=False)
    server.routes["/drip"] = _drip(JWKS_BODY, pieces=20, interval=0.15)
    started = time.monotonic()
    with pytest.raises(GrantexTokenError, match=r"Failed to fetch JWKS .*within 0.5 seconds"):
        _verify(server.url("/drip"), bounded_jwks_fetch=True)
    assert time.monotonic() - started < 1.5


def test_a_response_that_stalls_past_the_deadline_is_abandoned(
    server: _JwksServer, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(verify_module, "_JWKS_FETCH_DEADLINE_SECONDS", 0.5, raising=False)
    server.routes["/stall"] = _stall(JWKS_BODY, pause=3.0)
    started = time.monotonic()
    with pytest.raises(GrantexTokenError, match=r"Failed to fetch JWKS .*within 0.5 seconds"):
        _verify(server.url("/stall"), bounded_jwks_fetch=True)
    assert time.monotonic() - started < 1.5


def test_a_failed_fetch_is_not_cached(server: _JwksServer) -> None:
    server.routes["/flaky"] = _respond(JWKS_BODY, "text/html")
    with pytest.raises(GrantexTokenError, match="Content-Type"):
        _verify(server.url("/flaky"), bounded_jwks_fetch=True)
    server.routes["/flaky"] = _respond(JWKS_BODY)
    assert _verify(server.url("/flaky"), bounded_jwks_fetch=True).token_id == "tok_jwks_fetch"


@pytest.mark.parametrize("status", [203, 302, 404, 503])
def test_anything_but_200_is_refused(server: _JwksServer, status: int) -> None:
    server.routes["/status"] = _respond(JWKS_BODY, status=status, headers=(("Location", "/jwks"),))
    server.routes["/jwks"] = _respond(JWKS_BODY)
    with pytest.raises(GrantexTokenError, match=rf"Failed to fetch JWKS .*HTTP {status}"):
        _verify(server.url("/status"), bounded_jwks_fetch=True)


def test_a_body_that_is_not_a_key_set_is_refused(server: _JwksServer) -> None:
    server.routes["/list"] = _respond(b"[1, 2, 3]")
    with pytest.raises(GrantexTokenError, match="JWKS"):
        _verify(server.url("/list"), bounded_jwks_fetch=True)


def test_decision_grant_keys_are_fetched_with_the_same_bounds(server: _JwksServer) -> None:
    decisions = json.loads(
        (Path(__file__).resolve().parents[3] / "spec" / "examples" / "decision-grant" / "verification.json")
        .read_text(encoding="utf-8")
    )
    grant = jwt.encode(
        {**decisions["base_claims"], "iss": ISSUER},
        EC_KEY,
        algorithm="ES256",
        headers={"typ": "decision+jwt", "kid": "ec-1"},
    )
    padded = json.dumps({"keys": [EC_JWK], "padding": "x" * (64 * 1024)}).encode()
    server.routes["/decision-keys"] = _respond(padded)
    with pytest.raises(DecisionGrantError, match="larger than 65536 bytes"):
        verify_decision_grant(
            grant,
            decisions["action"],
            "v7",
            issuer=ISSUER,
            jwks_uri=server.url("/decision-keys"),
            now=decisions["now"],
            bounded_jwks_fetch=True,
        )


# ─── did:web issuer ──────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("issuer_did", "jwks_uri", "issuer"),
    [
        ("did:web:issuer.example", "https://issuer.example/.well-known/jwks.json", "https://issuer.example"),
        (
            "did:web:issuer.example%3A8443",
            "https://issuer.example:8443/.well-known/jwks.json",
            "https://issuer.example:8443",
        ),
        (
            "did:web:issuer.example:tenants:acme",
            "https://issuer.example/tenants/acme/.well-known/jwks.json",
            "https://issuer.example/tenants/acme",
        ),
        (
            "did:web:auth.issuer.example%3a8443:t-01:acme_kyb",
            "https://auth.issuer.example:8443/t-01/acme_kyb/.well-known/jwks.json",
            "https://auth.issuer.example:8443/t-01/acme_kyb",
        ),
        # An internationalized domain in its IDNA A-label form (did:web §3.5).
        (
            "did:web:xn--bcher-kva.example",
            "https://xn--bcher-kva.example/.well-known/jwks.json",
            "https://xn--bcher-kva.example",
        ),
    ],
)
def test_a_did_web_issuer_resolves_to_its_jwks(issuer_did: str, jwks_uri: str, issuer: str) -> None:
    with respx.mock(assert_all_called=False) as router:
        keys = router.get(jwks_uri).mock(
            return_value=httpx.Response(200, content=JWKS_BODY, headers={"Content-Type": "application/json"})
        )
        grant = verify_grant_token(
            _token(issuer),
            VerifyGrantTokenOptions(
                jwks_uri="https://unused.example/jwks.json",
                issuer_did=issuer_did,
                bounded_jwks_fetch=True,
            ),
        )
    assert grant.principal_id == "shopper-01"
    assert keys.call_count == 1


@pytest.mark.parametrize(
    ("issuer_did", "reason"),
    [
        # did:web §2.3: the identifier MUST NOT include IP addresses.
        ("did:web:127.0.0.1", "IP address"),
        ("did:web:10.0.0.8", "IP address"),
        ("did:web:169.254.169.254", "IP address"),
        ("did:web:0x7f.0.0.1", "IP address"),
        ("did:web:2130706433", "IP address"),
        ("did:web:[::1]", "IP address"),
        ("did:web:%5B%3A%3A1%5D", "IP address"),
        # Names that only mean something on this host or this network.
        ("did:web:localhost", "local"),
        ("did:web:LOCALHOST%3A3000", "local"),
        ("did:web:api.localhost", "local"),
        ("did:web:printer.local", "local"),
        ("did:web:nas.home.arpa", "local"),
        ("did:web:vault.internal", "local"),
        # A fully qualified domain name, not a single label.
        ("did:web:intranet", "fully qualified"),
        # No user information.
        ("did:web:user@issuer.example", "user information"),
        ("did:web:user%40issuer.example", "user information"),
        ("did:web:shopper-01:secret@issuer.example", "user information"),
        # A percent-encoded colon introduces a port, and only a port.
        ("did:web:issuer.example%3A0", "port"),
        ("did:web:issuer.example%3A65536", "port"),
        ("did:web:issuer.example%3A0443", "port"),
        ("did:web:issuer.example%3Ahttps", "port"),
        ("did:web:issuer.example%3A", "port"),
        # Path segments are plain DID characters, never traversal.
        ("did:web:issuer.example:..:admin", "path"),
        ("did:web:issuer.example:.", "path"),
        ("did:web:issuer.example::acme", "path"),
        ("did:web:issuer.example:", "path"),
        ("did:web:issuer.example:%2e%2e", "path"),
        ("did:web:issuer.example:a%2Fb", "path"),
        # Host names are letters, digits and hyphens.
        ("did:web:", "domain name"),
        ("did:web:-issuer.example", "domain name"),
        ("did:web:issuer_.example", "domain name"),
        ("did:web:issuer.example.", "domain name"),
        ("did:web:iss%75er.example", "domain name"),
        ("did:web:issuer.example/jwks", "domain name"),
        ("did:web:issuer.example?x=1", "domain name"),
        ("did:web:issuer.example#frag", "domain name"),
        ("did:web:" + "a" * 64 + ".example", "domain name"),
        ("did:web:b%C3%BCcher.example", "domain name"),
        # did:web §3.5: no Unicode in the identifier. IDNA would map each of
        # these to another ASCII host, or fail, so none is mapped: the Kelvin
        # sign, dotless i, dotted capital I, long s, a U-label, an ideographic
        # full stop, and non-ASCII in a path segment and in a port.
        ("did:web:Keys.example", "ASCII"),
        ("did:web:ıssuer.example", "ASCII"),
        ("did:web:İssuer.example", "ASCII"),
        ("did:web:ſecure.example", "ASCII"),
        ("did:web:bücher.example", "ASCII"),
        ("did:web:issuer。example", "ASCII"),
        ("did:web:issuer.example:tenänt", "ASCII"),
        ("did:web:issuer.example%3A８４４３", "ASCII"),
        # Only did:web can be resolved; another method is not quietly ignored.
        ("did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp", "did:web"),
        ("DID:WEB:issuer.example", "did:web"),
        ("https://issuer.example", "did:web"),
        ("", "did:web"),
    ],
)
def test_an_unusable_did_web_issuer_is_refused_before_any_fetch(issuer_did: str, reason: str) -> None:
    with respx.mock(assert_all_called=False, assert_all_mocked=False) as router:
        anything = router.route().mock(
            return_value=httpx.Response(200, content=JWKS_BODY, headers={"Content-Type": "application/json"})
        )
        with pytest.raises(GrantexTokenError, match="issuer_did") as info:
            verify_grant_token(
                _token(),
                VerifyGrantTokenOptions(
                    jwks_uri="https://issuer.example/.well-known/jwks.json",
                    issuer_did=issuer_did,
                    bounded_jwks_fetch=True,
                ),
            )
    assert reason in str(info.value)
    assert anything.call_count == 0


@pytest.mark.parametrize("label", ["Keys", "ıssuer", "İssuer", "ſecure"])
def test_a_host_label_matches_only_ascii_letters_digits_and_hyphens(label: str) -> None:
    # Under re.IGNORECASE, "[a-z]" matches these four; the TypeScript SDK's
    # label pattern never has. The ASCII check refuses them first, and the
    # label pattern refuses them on its own as well.
    assert verify_module._DNS_LABEL.fullmatch(label) is None


def test_issuer_did_none_means_no_did() -> None:
    # The TypeScript SDK treats issuerDid: null the same way.
    with respx.mock(assert_all_called=False) as router:
        keys = router.get("https://issuer.example/.well-known/jwks.json").mock(
            return_value=httpx.Response(200, content=JWKS_BODY, headers={"Content-Type": "application/json"})
        )
        grant = verify_grant_token(
            _token(),
            VerifyGrantTokenOptions(
                jwks_uri="https://issuer.example/.well-known/jwks.json",
                issuer_did=None,
                bounded_jwks_fetch=True,
            ),
        )
    assert grant.principal_id == "shopper-01"
    assert keys.call_count == 1


# ─── Without bounded_jwks_fetch (the default) ────────────────────────────────
#
# Until a major release turns the option on by default, leaving it out, or
# setting it to False, keeps the fetch and the issuer_did handling of earlier
# releases: each case here is refused by the bounded verifier above.


@pytest.mark.parametrize("options", [{}, {"bounded_jwks_fetch": False}], ids=["left-out", "false"])
def test_without_the_option_a_key_set_larger_than_64_kib_is_read(
    server: _JwksServer, options: Dict[str, Any]
) -> None:
    server.routes["/big"] = _respond(_oversized_key_set())
    assert _verify(server.url("/big"), **options).token_id == "tok_jwks_fetch"


def test_without_the_option_a_key_set_larger_than_64_kib_without_a_length_is_read(
    server: _JwksServer,
) -> None:
    server.routes["/unbounded"] = _respond(_oversized_key_set(), length=False)
    assert _verify(server.url("/unbounded")).token_id == "tok_jwks_fetch"


@pytest.mark.parametrize("content_type", ["text/plain", "text/html", None])
def test_without_the_option_any_media_type_is_read(
    server: _JwksServer, content_type: Optional[str]
) -> None:
    server.routes["/typed"] = _respond(JWKS_BODY, content_type)
    assert _verify(server.url("/typed")).principal_id == "shopper-01"


def test_without_the_option_a_content_encoded_response_is_read(server: _JwksServer) -> None:
    server.routes["/gzip"] = _respond(gzip.compress(JWKS_BODY), headers=(("Content-Encoding", "gzip"),))
    assert _verify(server.url("/gzip")).token_id == "tok_jwks_fetch"
    # Nor does the earlier fetch ask for an unencoded body.
    assert server.request_headers[-1].get("accept-encoding") != "identity"


def test_without_the_option_more_than_128_keys_are_read(server: _JwksServer) -> None:
    server.routes["/many"] = _respond(_key_set(129))
    assert _verify(server.url("/many")).token_id == "tok_jwks_fetch"


def test_without_the_option_decision_grant_keys_larger_than_64_kib_are_read(
    server: _JwksServer,
) -> None:
    decisions = _decision_fixture()
    server.routes["/decision-keys-default"] = _respond(_oversized_key_set())
    grant = verify_decision_grant(
        _decision_grant(decisions),
        decisions["action"],
        "v7",
        issuer=ISSUER,
        jwks_uri=server.url("/decision-keys-default"),
        now=decisions["now"],
    )
    assert grant.iss == ISSUER


@pytest.mark.parametrize(
    ("issuer_did", "host", "path", "issuer"),
    [
        # Hosts the did:web checks refuse are fetched as written.
        ("did:web:127.0.0.1", "127.0.0.1", "/.well-known/jwks.json", "https://127.0.0.1"),
        ("did:web:localhost", "localhost", "/.well-known/jwks.json", "https://localhost"),
        ("did:web:vault.internal", "vault.internal", "/.well-known/jwks.json", "https://vault.internal"),
        ("did:web:intranet", "intranet", "/.well-known/jwks.json", "https://intranet"),
        # A percent-encoded port is not decoded: it stays part of the host.
        (
            "did:web:issuer.example%3A8443",
            "issuer.example%3a8443",
            "/.well-known/jwks.json",
            "https://issuer.example%3A8443",
        ),
        (
            "did:web:issuer.example:tenants:acme",
            "issuer.example",
            "/tenants/acme/.well-known/jwks.json",
            "https://issuer.example/tenants/acme",
        ),
    ],
)
def test_without_the_option_a_did_web_issuer_is_fetched_as_written(
    issuer_did: str, host: str, path: str, issuer: str
) -> None:
    with respx.mock(assert_all_called=False, assert_all_mocked=False) as router:
        # text/plain: the bounded fetch would refuse it, the earlier one does not.
        anything = router.route().mock(
            return_value=httpx.Response(200, content=JWKS_BODY, headers={"Content-Type": "text/plain"})
        )
        grant = verify_grant_token(
            _token(issuer),
            VerifyGrantTokenOptions(jwks_uri="https://unused.example/jwks.json", issuer_did=issuer_did),
        )
    assert grant.principal_id == "shopper-01"
    assert anything.call_count == 1
    requested = anything.calls.last.request.url
    assert (requested.scheme, requested.host.lower(), requested.port, requested.path) == (
        "https",
        host,
        None,
        path,
    )


@pytest.mark.parametrize(
    "issuer_did",
    ["https://elsewhere.example", "DID:WEB:elsewhere.example", "did:example:elsewhere", ""],
)
def test_without_the_option_a_value_that_is_not_did_web_is_ignored(
    server: _JwksServer, issuer_did: str
) -> None:
    server.routes["/jwks"] = _respond(JWKS_BODY)
    before = len(server.request_headers)
    grant = verify_grant_token(
        _token(), VerifyGrantTokenOptions(jwks_uri=server.url("/jwks"), issuer=ISSUER, issuer_did=issuer_did)
    )
    assert grant.principal_id == "shopper-01"
    # The key set came from jwks_uri, on the loopback server.
    assert len(server.request_headers) == before + 1


def test_without_the_option_issuer_did_none_means_no_did(server: _JwksServer) -> None:
    server.routes["/jwks"] = _respond(JWKS_BODY)
    grant = verify_grant_token(
        _token(), VerifyGrantTokenOptions(jwks_uri=server.url("/jwks"), issuer=ISSUER, issuer_did=None)
    )
    assert grant.principal_id == "shopper-01"


# ─── Bounded and unbounded key sets for one URL are cached apart ─────────────


def test_a_grant_token_gets_each_modes_own_fetch_in_either_order(server: _JwksServer) -> None:
    server.routes["/shared"] = _respond(_oversized_key_set())
    assert _verify(server.url("/shared")).token_id == "tok_jwks_fetch"
    with pytest.raises(GrantexTokenError, match="larger than 65536 bytes"):
        _verify(server.url("/shared"), bounded_jwks_fetch=True)
    assert _verify(server.url("/shared")).token_id == "tok_jwks_fetch"

    server.routes["/shared-bounded-first"] = _respond(_oversized_key_set())
    with pytest.raises(GrantexTokenError, match="larger than 65536 bytes"):
        _verify(server.url("/shared-bounded-first"), bounded_jwks_fetch=True)
    assert _verify(server.url("/shared-bounded-first")).token_id == "tok_jwks_fetch"
    with pytest.raises(GrantexTokenError, match="larger than 65536 bytes"):
        _verify(server.url("/shared-bounded-first"), bounded_jwks_fetch=True)


def test_a_decision_grant_gets_each_modes_own_fetch_in_either_order(server: _JwksServer) -> None:
    decisions = _decision_fixture()
    grant = _decision_grant(decisions)

    def check(path: str, bounded: bool) -> Any:
        return verify_decision_grant(
            grant,
            decisions["action"],
            "v7",
            issuer=ISSUER,
            jwks_uri=server.url(path),
            now=decisions["now"],
            bounded_jwks_fetch=bounded,
        )

    server.routes["/decision-shared"] = _respond(_oversized_key_set())
    assert check("/decision-shared", False).iss == ISSUER
    with pytest.raises(DecisionGrantError, match="larger than 65536 bytes"):
        check("/decision-shared", True)

    server.routes["/decision-shared-bounded-first"] = _respond(_oversized_key_set())
    with pytest.raises(DecisionGrantError, match="larger than 65536 bytes"):
        check("/decision-shared-bounded-first", True)
    assert check("/decision-shared-bounded-first", False).iss == ISSUER
