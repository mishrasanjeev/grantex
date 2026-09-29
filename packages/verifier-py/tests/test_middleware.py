# SPDX-License-Identifier: Apache-2.0
"""The WSGI and ASGI middleware."""

from __future__ import annotations

import asyncio
import io
import json
import threading
from typing import Any, Callable, Dict, List, Optional, Tuple

import pytest
from conftest import ISSUER_LIST_URI, World, tx

from grantex_agent_httpsig import HttpRequest, sign
from grantex_verifier import (
    AsgiVerifierMiddleware,
    Transaction,
    VerifierDecision,
    WsgiVerifierMiddleware,
    presentations_from_request,
)

SEEN: List[Optional[VerifierDecision]] = []


def wsgi_app(environ: Dict[str, Any], start_response: Callable[..., Any]) -> List[bytes]:
    SEEN.append(environ.get("grantex.verification"))
    body = environ["wsgi.input"].read(int(environ.get("CONTENT_LENGTH") or 0))
    start_response("200 OK", [("Content-Type", "text/plain")])
    return [b"ok:" + body]


def environ_for(req: HttpRequest) -> Dict[str, Any]:
    body = req.body if isinstance(req.body, bytes) else (req.body or "").encode()
    path, _, query = req.url.partition("?")
    environ: Dict[str, Any] = {
        "REQUEST_METHOD": req.method,
        "PATH_INFO": path,
        "QUERY_STRING": query,
        "SERVER_NAME": "merchant.example",
        "SERVER_PORT": "443",
        "wsgi.url_scheme": "https",
        "wsgi.input": io.BytesIO(body),
        "CONTENT_LENGTH": str(len(body)),
    }
    assert isinstance(req.headers, dict)
    for name, value in req.headers.items():
        key = name.upper().replace("-", "_")
        if key in ("CONTENT_TYPE", "CONTENT_LENGTH"):
            environ[key] = value
        else:
            environ["HTTP_" + key] = value
    return environ


def call_wsgi(app: Any, environ: Dict[str, Any]) -> Tuple[str, bytes]:
    status: List[str] = []

    def start_response(s: str, headers: Any, exc_info: Any = None) -> None:
        status.append(s)

    body = b"".join(app(environ, start_response))
    return status[0], body


def test_wsgi_passes_a_good_request_and_attaches_the_result(world: World) -> None:
    SEEN.clear()
    req, _, _ = world.signed_request()
    app = WsgiVerifierMiddleware(wsgi_app, config=world.config(), transaction=lambda r: tx())
    status, body = call_wsgi(app, environ_for(req))
    assert status.startswith("200")
    assert body.endswith(req.body if isinstance(req.body, bytes) else b"")
    assert SEEN[-1] is not None and SEEN[-1].ok


def test_wsgi_refuses_with_403_and_the_denial_code(world: World) -> None:
    world.issuer_state = "suspended"
    world.publish()
    req, _, _ = world.signed_request()
    app = WsgiVerifierMiddleware(wsgi_app, config=world.config(), transaction=lambda r: tx())
    status, body = call_wsgi(app, environ_for(req))
    assert status.startswith("403")
    assert json.loads(body)["denial_code"] == "issuer_suspended"


def test_wsgi_refuses_a_bad_signature_with_401(world: World) -> None:
    req, _, _ = world.signed_request()
    environ = environ_for(req)
    environ["wsgi.input"] = io.BytesIO(b'{"cart_id":"c-9999","amount_minor":12500,"currency":"EUR"}')
    status, body = call_wsgi(
        WsgiVerifierMiddleware(wsgi_app, config=world.config(), transaction=lambda r: tx()), environ
    )
    assert status.startswith("401")
    assert json.loads(body)["denial_code"] == "request_signature_invalid"


def test_wsgi_refuses_a_request_without_presentations_with_401(world: World) -> None:
    environ = environ_for(HttpRequest("POST", "/v1/checkout", {"content-type": "application/json"}, b"{}"))
    status, body = call_wsgi(WsgiVerifierMiddleware(wsgi_app, config=world.config()), environ)
    assert status.startswith("401")
    assert json.loads(body)["denial_code"] == "request_signature_invalid"


def test_wsgi_answers_stale_status_with_503(world: World) -> None:
    world.fetcher.down.add(ISSUER_LIST_URI)
    req, _, _ = world.signed_request()
    app = WsgiVerifierMiddleware(wsgi_app, config=world.config(), transaction=lambda r: tx())
    status, body = call_wsgi(app, environ_for(req))
    assert status.startswith("503")
    assert json.loads(body)["denial_code"] == "status_stale"


def test_wsgi_report_only_mode_passes_the_request_with_the_result(world: World) -> None:
    SEEN.clear()
    world.issuer_state = "suspended"
    world.publish()
    req, _, _ = world.signed_request()
    app = WsgiVerifierMiddleware(wsgi_app, config=world.config(), transaction=lambda r: tx(), reject=False)
    status, _ = call_wsgi(app, environ_for(req))
    assert status.startswith("200")
    assert SEEN[-1] is not None and SEEN[-1].denial_code == "issuer_suspended"


def test_wsgi_refuses_an_oversized_body(world: World) -> None:
    req, _, _ = world.signed_request()
    app = WsgiVerifierMiddleware(wsgi_app, config=world.config(), max_body_bytes=8)
    status, _ = call_wsgi(app, environ_for(req))
    assert status.startswith("413")


def test_a_passport_over_six_kilobytes_is_read_from_the_content(world: World) -> None:
    # Only the extraction is exercised here: the value need not verify.
    big, padding = world.passport, "x" * 7000
    body = json.dumps({"agent_credentials": {"agent_passport": big + padding}}).encode()
    signed = sign(
        HttpRequest("POST", "https://merchant.example/v1/checkout", {}, body),
        key=world.agent.private_jwk,
        agent_passport=big + padding,
        agent_grant=world.grant(),
        created=int(world.now),
    )
    req = HttpRequest("POST", "/v1/checkout", dict(signed.headers), body)
    passport, grant = presentations_from_request(req)
    assert passport == big + padding
    assert grant is not None


def test_the_default_transaction_is_the_merchant_origin_now(world: World) -> None:
    SEEN.clear()
    req, _, _ = world.signed_request()
    app = WsgiVerifierMiddleware(wsgi_app, config=world.config(), reject=False)
    call_wsgi(app, environ_for(req))
    result = SEEN[-1]
    assert result is not None
    # The grant constrains the amount, and the default transaction has none: refused.
    assert result.checks["constraints"].code == "cap_exceeded"


# ── ASGI ─────────────────────────────────────────────────────────────────────


async def asgi_app(scope: Dict[str, Any], receive: Any, send: Any) -> None:
    SEEN.append(scope.get("grantex.verification"))
    body = b""
    while True:
        message = await receive()
        body += message.get("body", b"")
        if not message.get("more_body"):
            break
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": b"ok:" + body})


def call_asgi(app: Any, req: HttpRequest, chunks: int = 2) -> Tuple[int, bytes]:
    body = req.body if isinstance(req.body, bytes) else b""
    assert isinstance(req.headers, dict)
    path, _, query = req.url.partition("?")
    scope = {
        "type": "http",
        "method": req.method,
        "path": path,
        "raw_path": path.encode(),
        "query_string": query.encode(),
        "headers": [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in req.headers.items()],
    }
    size = max(1, len(body) // chunks)
    parts = [body[i : i + size] for i in range(0, len(body), size)] or [b""]
    messages = [
        {"type": "http.request", "body": p, "more_body": i < len(parts) - 1} for i, p in enumerate(parts)
    ]
    sent: List[Dict[str, Any]] = []

    async def receive() -> Dict[str, Any]:
        return messages.pop(0) if messages else {"type": "http.disconnect"}

    async def send(message: Dict[str, Any]) -> None:
        sent.append(message)

    asyncio.run(app(scope, receive, send))
    status = next(m["status"] for m in sent if m["type"] == "http.response.start")
    out = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return status, out


def test_asgi_passes_a_good_request_and_replays_the_body(world: World) -> None:
    SEEN.clear()
    req, _, _ = world.signed_request()
    app = AsgiVerifierMiddleware(asgi_app, config=world.config(), transaction=lambda r: tx())
    status, body = call_asgi(app, req)
    assert status == 200
    assert body == b"ok:" + (req.body if isinstance(req.body, bytes) else b"")
    assert SEEN[-1] is not None and SEEN[-1].ok


def test_asgi_refuses_with_the_denial_code(world: World) -> None:
    world.grant_status.state = "revoked"
    req, _, _ = world.signed_request()
    app = AsgiVerifierMiddleware(asgi_app, config=world.config(), transaction=lambda r: tx())
    status, body = call_asgi(app, req)
    assert status == 403
    assert json.loads(body)["denial_code"] == "grant_revoked"


def test_asgi_status_codes_are_configurable(world: World) -> None:
    world.grant_status.state = "revoked"
    req, _, _ = world.signed_request()
    app = AsgiVerifierMiddleware(
        asgi_app, config=world.config(), transaction=lambda r: tx(), status_for={"grant_revoked": 401}
    )
    status, _ = call_asgi(app, req)
    assert status == 401


def test_asgi_verifies_off_the_event_loop(world: World) -> None:
    """A slow fetcher on a cold cache must not stall other coroutines."""
    ticked = threading.Event()
    waited: List[bool] = []
    inner = world.fetcher

    def slow_fetch(url: str) -> str:
        # Blocks until a concurrent coroutine has run, or gives up: if
        # verification ran on the event loop, that coroutine cannot run.
        if not waited:
            waited.append(ticked.wait(timeout=2.0))
        return inner(url)

    SEEN.clear()
    req, _, _ = world.signed_request()
    app = AsgiVerifierMiddleware(asgi_app, config=world.config(fetch=slow_fetch), transaction=lambda r: tx())
    body = req.body if isinstance(req.body, bytes) else b""
    assert isinstance(req.headers, dict)
    scope = {
        "type": "http",
        "method": req.method,
        "path": req.url,
        "raw_path": req.url.encode(),
        "query_string": b"",
        "headers": [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in req.headers.items()],
    }
    messages = [{"type": "http.request", "body": body, "more_body": False}]
    sent: List[Dict[str, Any]] = []

    async def receive() -> Dict[str, Any]:
        return messages.pop(0) if messages else {"type": "http.disconnect"}

    async def send(message: Dict[str, Any]) -> None:
        sent.append(message)

    async def ticker() -> None:
        await asyncio.sleep(0.01)
        ticked.set()

    async def main() -> None:
        await asyncio.gather(app(scope, receive, send), ticker())

    asyncio.run(main())
    assert waited == [True], "the event loop was blocked while the fetcher ran"
    assert next(m["status"] for m in sent if m["type"] == "http.response.start") == 200
    assert SEEN[-1] is not None and SEEN[-1].ok


def test_asgi_leaves_other_scopes_alone(world: World) -> None:
    seen: List[str] = []

    async def inner(scope: Dict[str, Any], receive: Any, send: Any) -> None:
        seen.append(scope["type"])

    app = AsgiVerifierMiddleware(inner, config=world.config())
    asyncio.run(app({"type": "lifespan"}, None, None))
    assert seen == ["lifespan"]


def test_transaction_type_is_exported() -> None:
    assert Transaction(amount_minor=1).amount_minor == 1


@pytest.mark.parametrize("value", ["", ":not base64", "body;sha-256=:AAAA:"])
def test_unreadable_presentation_fields_read_as_absent(value: str) -> None:
    req = HttpRequest("POST", "/", {"agent-passport": value, "agent-grant": value}, b"{}")
    assert presentations_from_request(req) == (None, None)
