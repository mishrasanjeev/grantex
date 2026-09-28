# SPDX-License-Identifier: Apache-2.0
"""WSGI and ASGI middleware for a relying party (a merchant or a PSP).

Each reads the ``Agent-Passport`` and ``Agent-Grant`` headers (spec/verification.md
section 1.1; a presentation over 6 KB is carried in the JSON content under
``agent_credentials``, section 1.2), the signature fields and the content,
calls :func:`verify`, attaches the :class:`VerifierDecision` to the request
(``environ["grantex.verification"]``, or ``scope["grantex.verification"]``)
and, unless ``reject=False``, answers a failed verification itself:

    request_signature_invalid, request_signature_stale   401
    status_stale                                        503 (the request may be good)
    every other denial code                             403

with a JSON body ``{"denial_code": ..., "check": ...}``. ``status_for`` maps
codes to other statuses. A request without both presentations is 401; a
content larger than ``max_body_bytes`` is 413. With ``reject=False`` the
application receives every request with the decision attached and acts on it.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Awaitable, Callable, Dict, Iterable, List, Mapping, Optional, Tuple
from urllib.parse import quote

from grantex_agent_httpsig import HttpRequest, Item, Token, parse_item

from ._codes import REQUEST_SIGNATURE_INVALID, REQUEST_SIGNATURE_STALE, STATUS_STALE
from ._verify import Transaction, VerifierConfig, VerifierDecision, verify

INLINE_PRESENTATION_MAX_OCTETS = 6144
DEFAULT_MAX_BODY_BYTES = 1_048_576
RESULT_KEY = "grantex.verification"
DEFAULT_STATUS = {REQUEST_SIGNATURE_INVALID: 401, REQUEST_SIGNATURE_STALE: 401, STATUS_STALE: 503}
_REASONS = {401: "401 Unauthorized", 403: "403 Forbidden", 413: "413 Content Too Large", 503: "503 Service Unavailable"}

TransactionFor = Callable[[HttpRequest], Transaction]


def _header(request: HttpRequest, name: str) -> Optional[str]:
    lines: List[str] = []
    headers = request.headers
    pairs: Iterable[Tuple[str, Any]] = headers.items() if isinstance(headers, Mapping) else headers
    for n, v in pairs:
        if n.lower() == name:
            lines.extend([v] if isinstance(v, str) else list(v))
    return ", ".join(line.strip(" \t") for line in lines) if lines else None


def _credentials(body: bytes) -> Optional[Mapping[str, Any]]:
    try:
        parsed = json.loads(body.decode("utf-8"), parse_int=float)
    except (UnicodeDecodeError, ValueError, RecursionError):
        # Content that is not JSON carries no presentations (section 1.2).
        return None
    credentials = parsed.get("agent_credentials") if isinstance(parsed, dict) else None
    return credentials if isinstance(credentials, dict) else None


def presentations_from_request(request: HttpRequest) -> Tuple[Optional[str], Optional[str]]:
    """The Agent Passport and grant the request presents, or None for each it
    does not carry readably.

    Nothing here is verified: ``verify()`` checks the signature over the
    headers, the digest of the content and each presentation by reference,
    and refuses credentials that are not the ones the request signed.
    """
    body = request.body.encode("utf-8") if isinstance(request.body, str) else bytes(request.body or b"")
    out: List[Optional[str]] = []
    credentials: Optional[Mapping[str, Any]] = None
    for header, member in (("agent-passport", "agent_passport"), ("agent-grant", "agent_grant")):
        value = _header(request, header)
        item: Optional[Item] = None
        if value is not None:
            try:
                item = parse_item(value)
            except ValueError:
                # A field that does not parse carries no presentation.
                item = None
        if item is not None and isinstance(item.value, bytes) and not item.params:
            try:
                out.append(item.value.decode("ascii"))
            except UnicodeDecodeError:
                out.append(None)
            continue
        if item is not None and isinstance(item.value, Token) and item.value == "body":
            if credentials is None:
                credentials = _credentials(body)
            found = credentials.get(member) if credentials is not None else None
            out.append(found if isinstance(found, str) else None)
            continue
        out.append(None)
    return out[0], out[1]


def _default_transaction(config: VerifierConfig) -> TransactionFor:
    return lambda request: Transaction(merchant=config.origin)


class _Base:
    def __init__(
        self,
        app: Any,
        *,
        config: VerifierConfig,
        transaction: Optional[TransactionFor] = None,
        reject: bool = True,
        status_for: Optional[Mapping[str, int]] = None,
        max_body_bytes: int = DEFAULT_MAX_BODY_BYTES,
    ) -> None:
        self.app = app
        self.config = config
        self.transaction = transaction or _default_transaction(config)
        self.reject = reject
        self.status_for: Dict[str, int] = dict(DEFAULT_STATUS)
        self.status_for.update(status_for or {})
        self.max_body_bytes = max_body_bytes

    def decide(self, request: HttpRequest) -> Tuple[Optional[VerifierDecision], Optional[Tuple[int, bytes]]]:
        """The verifier decision, and the refusal to send (status, JSON body) if any."""
        passport, grant = presentations_from_request(request)
        if passport is None or grant is None:
            body = {"denial_code": REQUEST_SIGNATURE_INVALID, "check": "request.signature"}
            return None, (401, json.dumps(body).encode())
        result = verify(passport, grant, request, self.transaction(request), config=self.config)
        if result.ok:
            return result, None
        code = result.denial_code or REQUEST_SIGNATURE_INVALID
        check = next((name for name, c in result.checks.items() if c.code == code and not c.ok), None)
        status = self.status_for.get(code, 403)
        return result, (status, json.dumps({"denial_code": code, "check": check}).encode())


class WsgiVerifierMiddleware(_Base):
    """WSGI (PEP 3333) middleware: verifies each request before the application sees it."""

    def __call__(self, environ: Dict[str, Any], start_response: Callable[..., Any]) -> Iterable[bytes]:
        import io

        try:
            length = int(environ.get("CONTENT_LENGTH") or 0)
        except ValueError:
            length = -1
        if length < 0 or length > self.max_body_bytes:
            return self._refuse(start_response, 413, b'{"denial_code":"request_signature_invalid"}')
        body = environ["wsgi.input"].read(length) if length else b""
        environ["wsgi.input"] = io.BytesIO(body)
        request = HttpRequest(environ.get("REQUEST_METHOD", "GET"), _wsgi_target(environ), _wsgi_headers(environ), body)
        result, refusal = self.decide(request)
        environ[RESULT_KEY] = result
        if refusal is not None and self.reject:
            return self._refuse(start_response, *refusal)
        return self.app(environ, start_response)  # type: ignore[no-any-return]

    @staticmethod
    def _refuse(start_response: Callable[..., Any], status: int, body: bytes) -> List[bytes]:
        start_response(
            _REASONS.get(status, "%d Refused" % status),
            [("Content-Type", "application/json"), ("Content-Length", str(len(body)))],
        )
        return [body]


def _wsgi_target(environ: Mapping[str, Any]) -> str:
    raw = environ.get("RAW_URI") or environ.get("REQUEST_URI")
    if isinstance(raw, str) and raw.startswith("/"):
        return raw
    # PEP 3333 paths are bytes decoded as latin-1; re-encode for @path.
    path = (environ.get("SCRIPT_NAME", "") + environ.get("PATH_INFO", "")) or "/"
    target = quote(path.encode("latin-1"), safe="/:@!$&'()*+,;=-._~%")
    query = environ.get("QUERY_STRING", "")
    return target + ("?" + query if query else "")


def _wsgi_headers(environ: Mapping[str, Any]) -> List[Tuple[str, str]]:
    headers: List[Tuple[str, str]] = []
    for key, value in environ.items():
        if key.startswith("HTTP_"):
            headers.append((key[5:].replace("_", "-").lower(), value))
        elif key in ("CONTENT_TYPE", "CONTENT_LENGTH") and value:
            headers.append((key.replace("_", "-").lower(), value))
    return headers


Receive = Callable[[], Awaitable[Dict[str, Any]]]
Send = Callable[[Dict[str, Any]], Awaitable[None]]


class AsgiVerifierMiddleware(_Base):
    """ASGI 3 middleware for HTTP scopes; other scopes pass through untouched.

    ``verify()`` is synchronous and may call the injected fetcher, registry
    lookup and grant-status client, so it runs in the event loop's default
    executor: a cold cache does not block other requests.
    """

    async def __call__(self, scope: Dict[str, Any], receive: Receive, send: Send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        chunks: List[bytes] = []
        size = 0
        while True:
            message = await receive()
            if message.get("type") != "http.request":
                break
            chunk = message.get("body", b"")
            size += len(chunk)
            if size > self.max_body_bytes:
                await self._refuse(send, 413, b'{"denial_code":"request_signature_invalid"}')
                return
            chunks.append(chunk)
            if not message.get("more_body"):
                break
        body = b"".join(chunks)
        raw_path = scope.get("raw_path")
        path = raw_path.decode("latin-1") if isinstance(raw_path, bytes) else quote(scope.get("path", "/"))
        query = scope.get("query_string", b"").decode("latin-1")
        headers = [(k.decode("latin-1"), v.decode("latin-1")) for k, v in scope.get("headers", [])]
        request = HttpRequest(scope.get("method", "GET"), path + ("?" + query if query else ""), headers, body)
        loop = asyncio.get_running_loop()
        result, refusal = await loop.run_in_executor(None, self.decide, request)
        scope[RESULT_KEY] = result
        if refusal is not None and self.reject:
            await self._refuse(send, *refusal)
            return
        replayed = False

        async def replay() -> Dict[str, Any]:
            nonlocal replayed
            if not replayed:
                replayed = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        await self.app(scope, replay, send)

    @staticmethod
    async def _refuse(send: Send, status: int, body: bytes) -> None:
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
            }
        )
        await send({"type": "http.response.body", "body": body})
