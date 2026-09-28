# SPDX-License-Identifier: Apache-2.0
"""The agent request signing profile of spec/verification.md.

The Agent-Passport, Agent-Grant and Agent-Trust headers (section 1),
Content-Digest (section 2), sign() (section 3) and verify() (section 4).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import re
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, Mapping, Optional, Protocol, Tuple, Union

from ._errors import AgentHttpSigError
from ._keys import (
    jwk_thumbprint,
    private_key_object,
    public_key_object,
    sign_bytes,
    verify_bytes,
)
from ._message import (
    HttpRequest,
    body_bytes,
    create_signature_base,
    field_value,
    normalise_authority,
    parse_target,
)
from .structured_fields import (
    InnerList,
    Item,
    Parameters,
    Token,
    parse_dictionary,
    parse_item,
    serialize_dictionary,
    serialize_inner_list,
    serialize_item,
)

AGENT_PAYER_AUTH_TAG = "agent-payer-auth"
COVERED_COMPONENTS: Tuple[str, ...] = (
    "@method",
    "@authority",
    "@path",
    "content-digest",
    "agent-passport",
    "agent-grant",
)
SIGNATURE_PARAMETERS: Tuple[str, ...] = ("created", "expires", "nonce", "keyid", "tag")
MAX_SIGNATURE_WINDOW_SECONDS = 300
DEFAULT_SIGNATURE_WINDOW_SECONDS = 60
DEFAULT_CLOCK_SKEW_SECONDS = 10
MAX_CLOCK_SKEW_SECONDS = 60
INLINE_PRESENTATION_MAX_OCTETS = 6144
MAX_CONTENT_NESTING_DEPTH = 64
DEFAULT_SIGNATURE_LABEL = "sig1"

_NONCE = re.compile(r"[A-Za-z0-9_-]{22,128}")
_KEYID = re.compile(r"[A-Za-z0-9_-]{43}")
# Compact serializations are printable ASCII without spaces.
_PRESENTATION = re.compile(r"[\x21-\x7e]+")
_LABEL = re.compile(r"[a-z*][a-z0-9_\-.*]*")
_METHOD = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+")

# (header, field, member of agent_credentials, required)
_PRESENTATIONS = (
    ("Agent-Passport", "agent-passport", "agent_passport", True),
    ("Agent-Grant", "agent-grant", "agent_grant", True),
    ("Agent-Trust", "agent-trust", "agent_trust", False),
)

JwkLike = Mapping[str, Any]


class NonceStore(Protocol):
    def check_and_store(self, keyid: str, nonce: str, expires_at: int) -> bool:
        """Records (keyid, nonce) until ``expires_at`` (UNIX seconds) and returns True.

        Returns False when the pair is already recorded. Must be atomic.
        """


@dataclass(frozen=True)
class SignResult:
    #: The fields to set on the request, in this order.
    headers: Dict[str, str]
    keyid: str
    alg: str
    created: int
    expires: int
    nonce: str
    signature_base: str


@dataclass(frozen=True)
class VerifyResult:
    """``ok`` with the verified values, or a denial ``code`` and ``reason``."""

    ok: bool
    code: Optional[str] = None
    reason: Optional[str] = None
    keyid: Optional[str] = None
    alg: Optional[str] = None
    label: Optional[str] = None
    created: Optional[int] = None
    expires: Optional[int] = None
    nonce: Optional[str] = None
    agent_passport: Optional[str] = None
    agent_grant: Optional[str] = None
    agent_trust: Optional[str] = None


def _sha256(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def _now() -> int:
    return int(time.time())


def content_digest(body: Union[bytes, str, None]) -> str:
    """RFC 9530 section 2: ``sha-256=:<digest>:`` for the content."""
    return serialize_dictionary({"sha-256": Item(_sha256(body_bytes(body)))})


def _presentation_field(presentation: str) -> str:
    """Section 1.1: inline up to 6144 octets, by reference above."""
    data = presentation.encode("utf-8")
    if len(data) > INLINE_PRESENTATION_MAX_OCTETS:
        return serialize_item(Item(Token("body"), {"sha-256": _sha256(data)}))
    return serialize_item(Item(data))


def _reject_constant(name: str) -> Any:
    # JSON (RFC 8259) has no NaN or Infinity; refuse them as JavaScript does.
    raise ValueError("invalid JSON constant " + name)


# A JSON string, or one bracket; for JSON the strings are matched whole, so
# brackets inside them are not counted.
_JSON_NESTING = re.compile(r'"[^"\\]*(?:\\.[^"\\]*)*"|[\[{]|[\]}]')


def _nested_within_limit(text: str) -> bool:
    """Section 1.2: the content is read only when it nests arrays and objects
    at most 64 deep.

    Counted outside strings; exact for JSON, and content that is not JSON
    fails to parse whatever this returns.
    """
    depth = 0
    for m in _JSON_NESTING.finditer(text):
        c = m.group()
        if c in "[{":
            depth += 1
            if depth > MAX_CONTENT_NESTING_DEPTH:
                return False
        elif c in "]}":
            depth -= 1
    return True


def _read_credentials(body: bytes) -> Union[Mapping[str, Any], str]:
    """Section 1.2: ``agent_credentials`` of a JSON object content, or why the
    content carries no presentations.

    The caller denies (or refuses to sign) when it needs one.
    """
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError:
        # Not UTF-8, so not JSON (RFC 8259 section 8.1): no presentations.
        return "the content is not UTF-8"
    # The depth limit comes before the parse, so Python's recursion limit is
    # never reached and both libraries read the same contents.
    if not _nested_within_limit(text):
        return "the content is nested more than %d deep" % MAX_CONTENT_NESTING_DEPTH
    try:
        # Integers are read as floats, as JavaScript reads every number, so an
        # integer of any length parses (int() refuses over 4300 digits).
        parsed = json.loads(text, parse_constant=_reject_constant, parse_int=float)
    except (ValueError, RecursionError):
        # Content that is not JSON carries no presentations. JSONDecodeError
        # is a ValueError, and a byte order mark is refused as RFC 8259
        # section 8.1 requires. RecursionError cannot follow the depth check
        # for JSON; it is kept so content that is not JSON still fails here.
        return "the content is not JSON"
    credentials = parsed.get("agent_credentials") if isinstance(parsed, dict) else None
    if not isinstance(credentials, dict):
        return "the content is not a JSON object with an agent_credentials object"
    return credentials


def _check_integer(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise AgentHttpSigError(name + " must be a non-negative integer (UNIX seconds)")
    checked: int = value
    return checked


def _check_now(value: Any) -> int:
    """The verifier's clock: a finite, non-negative number of UNIX seconds.

    NaN compares false with everything, so both time checks of section 4.3
    would pass and a stale signature would be accepted; an infinity makes the
    window meaningless. Such a clock is a configuration error, so verify()
    refuses to answer rather than deciding on it (fail closed).
    """
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value < 0
    ):
        raise AgentHttpSigError("now must be a finite, non-negative number (UNIX seconds)")
    return int(value)


def sign(
    request: HttpRequest,
    *,
    key: JwkLike,
    agent_passport: str,
    agent_grant: str,
    agent_trust: Optional[str] = None,
    keyid: Optional[str] = None,
    created: Optional[int] = None,
    expires: Optional[int] = None,
    nonce: Optional[str] = None,
    tag: Optional[str] = None,
    label: str = DEFAULT_SIGNATURE_LABEL,
) -> SignResult:
    """Signs a request with the profile of spec/verification.md section 3.

    Returns the Content-Digest, Agent-Passport, Agent-Grant, Agent-Trust (when
    given), Signature-Input and Signature fields to set on it.
    ``request.url`` must be absolute. A presentation over 6144 octets must
    already be in the JSON content under ``agent_credentials`` (section 1.2).
    """
    private_key, alg = private_key_object(key)
    thumbprint = jwk_thumbprint(key)
    if keyid is not None and keyid != thumbprint:
        raise AgentHttpSigError("keyid must be the RFC 7638 thumbprint of the key")
    if tag is not None and tag != AGENT_PAYER_AUTH_TAG:
        raise AgentHttpSigError("tag must be " + AGENT_PAYER_AUTH_TAG)
    created = _check_integer(_now() if created is None else created, "created")
    expires = _check_integer(
        created + DEFAULT_SIGNATURE_WINDOW_SECONDS if expires is None else expires, "expires"
    )
    if expires <= created or expires - created > MAX_SIGNATURE_WINDOW_SECONDS:
        raise AgentHttpSigError(
            "expires must be 1 to %d seconds after created" % MAX_SIGNATURE_WINDOW_SECONDS
        )
    if nonce is None:
        nonce = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
    if not _NONCE.fullmatch(nonce):
        raise AgentHttpSigError("nonce must be 22 to 128 base64url characters")
    if not _LABEL.fullmatch(label):
        raise AgentHttpSigError("invalid signature label")
    if not _METHOD.fullmatch(request.method):
        raise AgentHttpSigError("invalid method")
    if parse_target(request.url).authority is None:
        raise AgentHttpSigError("sign() needs an absolute URL")

    body = body_bytes(request.body)
    values = {
        "agent_passport": agent_passport,
        "agent_grant": agent_grant,
        "agent_trust": agent_trust,
    }
    headers: Dict[str, str] = {"Content-Digest": content_digest(body)}
    content: Union[Mapping[str, Any], str, None] = None
    for header, _field, member, _required in _PRESENTATIONS:
        presentation = values[member]
        if presentation is None:
            continue
        if not isinstance(presentation, str) or not _PRESENTATION.fullmatch(presentation):
            raise AgentHttpSigError(header + " must be non-empty printable ASCII without spaces")
        if len(presentation.encode("utf-8")) > INLINE_PRESENTATION_MAX_OCTETS:
            if content is None:
                content = _read_credentials(body)
            if isinstance(content, str):
                raise AgentHttpSigError(
                    "%s is over %d octets and goes in the content, but %s"
                    % (header, INLINE_PRESENTATION_MAX_OCTETS, content)
                )
            if content.get(member) != presentation:
                raise AgentHttpSigError(
                    "%s is over %d octets: put it in the JSON content at "
                    "agent_credentials.%s" % (header, INLINE_PRESENTATION_MAX_OCTETS, member)
                )
        headers[header] = _presentation_field(presentation)

    params = _signature_params(created, expires, nonce, thumbprint, AGENT_PAYER_AUTH_TAG)
    message = HttpRequest(request.method, request.url, headers, body)
    signature_base = create_signature_base(message, params)
    signature = sign_bytes(private_key, alg, signature_base)
    headers["Signature-Input"] = label + "=" + serialize_inner_list(params)
    headers["Signature"] = label + "=" + serialize_item(Item(signature))
    return SignResult(headers, thumbprint, alg, created, expires, nonce, signature_base)


def _signature_params(
    created: int, expires: int, nonce: str, keyid: str, tag: str
) -> InnerList:
    params: Parameters = {
        "created": created,
        "expires": expires,
        "nonce": nonce,
        "keyid": keyid,
        "tag": tag,
    }
    return InnerList([Item(c) for c in COVERED_COMPONENTS], params)


class InMemoryNonceStore:
    """In-memory nonce store for one process and for tests (spec section 4.4).

    Safe to share between threads: pruning, the check and the store happen
    under one lock, so two concurrent requests with the same nonce cannot
    both see it as unused (the NonceStore contract requires atomicity).
    """

    def __init__(self, clock: Callable[[], int] = _now) -> None:
        self._clock = clock
        self._seen: Dict[Tuple[str, str], int] = {}
        self._lock = threading.Lock()

    def check_and_store(self, keyid: str, nonce: str, expires_at: int) -> bool:
        with self._lock:
            now = self._clock()
            for k in [k for k, until in self._seen.items() if until < now]:
                del self._seen[k]
            if (keyid, nonce) in self._seen:
                return False
            self._seen[(keyid, nonce)] = expires_at
            return True


def _parse_presentation(value: str) -> Optional[Tuple[str, Union[str, bytes]]]:
    """Section 1.1: ("inline", text) or ("reference", sha-256), or None."""
    try:
        parsed = parse_item(value)
    except AgentHttpSigError:
        # A field that does not parse is malformed; the caller denies.
        return None
    v = parsed.value
    if isinstance(v, bytes) and not parsed.params:
        text = v.decode("latin-1")
        if len(v) > INLINE_PRESENTATION_MAX_OCTETS or not _PRESENTATION.fullmatch(text):
            return None
        return ("inline", text)
    if isinstance(v, Token) and v == "body" and len(parsed.params) == 1:
        digest = parsed.params.get("sha-256")
        if isinstance(digest, bytes) and len(digest) == 32:
            return ("reference", digest)
    return None


def _parse_content_digest(value: Optional[str]) -> Optional[bytes]:
    """Section 2: exactly one member, sha-256, a 32-octet Byte Sequence."""
    if value is None:
        return None
    try:
        dictionary = parse_dictionary(value)
    except AgentHttpSigError:
        # Unparseable Content-Digest is malformed; the caller denies.
        return None
    member = dictionary.get("sha-256")
    if len(dictionary) != 1 or not isinstance(member, Item):
        return None
    if not isinstance(member.value, bytes) or member.params or len(member.value) != 32:
        return None
    return member.value


def _deny(reason: str, code: str = "request_signature_invalid") -> VerifyResult:
    return VerifyResult(ok=False, code=code, reason=reason)


def _is_str(value: Any) -> bool:
    # A String bare item, not a Token or Display String.
    return type(value) is str


def _is_int(value: Any) -> bool:
    # An Integer bare item, not a Boolean or Date.
    return type(value) is int


def verify(
    request: HttpRequest,
    *,
    resolve_key: Callable[[str], Optional[JwkLike]],
    expected_authority: str,
    nonce_store: NonceStore,
    now: Optional[int] = None,
    clock_skew_seconds: int = DEFAULT_CLOCK_SKEW_SECONDS,
) -> VerifyResult:
    """Verifies a request against the profile of spec/verification.md section 4.

    Applies its steps in order. A request that fails is answered with a
    denial; an exception from ``resolve_key`` or ``nonce_store`` propagates,
    and the caller must refuse the request.
    """
    skew = clock_skew_seconds
    if not _is_int(skew) or not 0 <= skew <= MAX_CLOCK_SKEW_SECONDS:
        raise AgentHttpSigError(
            "clock_skew_seconds must be an integer from 0 to %d" % MAX_CLOCK_SKEW_SECONDS
        )
    if not isinstance(expected_authority, str) or expected_authority == "":
        raise AgentHttpSigError("expected_authority is required")
    # The verifier's authority is compared as RFC 9421 section 2.2.3
    # normalises it; a URL or a value with a path is a configuration error.
    authority = normalise_authority(expected_authority, None)
    # @authority omits the default port (RFC 9421 section 2.2.3), so a
    # configured :80 or :443 would deny every request; refuse it here.
    if re.search(r":(?:80|443)\Z", authority):
        raise AgentHttpSigError("expected_authority must omit the default port (80 or 443)")
    current = _check_now(_now() if now is None else now)
    headers = request.headers

    # 1-2. Both fields, both Dictionaries (RFC 9421 sections 4.1, 4.2).
    input_field = field_value(headers, "signature-input")
    signature_field = field_value(headers, "signature")
    if input_field is None or signature_field is None:
        return _deny("signature_missing")
    try:
        inputs = parse_dictionary(input_field)
        signatures = parse_dictionary(signature_field)
    except AgentHttpSigError:
        # RFC 9651 section 4.2: a field that fails to parse is treated as
        # malformed; the request is denied.
        return _deny("signature_malformed")

    # 3. Exactly one signature carries the profile tag (RFC 9421 section 7.2.7).
    tagged = [
        (label, m)
        for label, m in inputs.items()
        if isinstance(m, InnerList)
        and _is_str(m.params.get("tag"))
        and m.params.get("tag") == AGENT_PAYER_AUTH_TAG
    ]
    if not tagged:
        return _deny("signature_not_found")
    if len(tagged) > 1:
        return _deny("signature_ambiguous")
    label, member = tagged[0]
    assert isinstance(member, InnerList)

    # 4. Its Signature value (RFC 9421 section 3.2 step 1.2).
    sig_member = signatures.get(label)
    if (
        not isinstance(sig_member, Item)
        or not isinstance(sig_member.value, bytes)
        or sig_member.params
    ):
        return _deny("signature_malformed")
    signature = sig_member.value

    # 5. Exactly the covered components, in order, without parameters.
    components = member.items
    if len(components) != len(COVERED_COMPONENTS) or any(
        not _is_str(c.value) or c.value != COVERED_COMPONENTS[i] or c.params
        for i, c in enumerate(components)
    ):
        return _deny("covered_components_mismatch")

    # 6. Exactly the parameters, in order, with their types and formats.
    p = member.params
    created, expires = p.get("created"), p.get("expires")
    nonce, keyid = p.get("nonce"), p.get("keyid")
    if (
        tuple(p.keys()) != SIGNATURE_PARAMETERS
        or not _is_int(created)
        or not _is_int(expires)
        or not _is_str(nonce)
        or not _is_str(keyid)
    ):
        return _deny("signature_params_mismatch")
    assert isinstance(created, int) and isinstance(expires, int)
    assert isinstance(nonce, str) and isinstance(keyid, str)
    if (
        created < 0
        or expires <= created
        or not _NONCE.fullmatch(nonce)
        or not _KEYID.fullmatch(keyid)
    ):
        return _deny("signature_params_mismatch")

    # 7-9. Time (spec section 4.3).
    if expires - created > MAX_SIGNATURE_WINDOW_SECONDS:
        return _deny("window_too_long")
    if created > current + skew:
        return _deny("created_in_future")
    if current >= expires + skew:
        return _deny("expired", "request_signature_stale")

    # 10. An absolute target must name this verifier.
    try:
        target = parse_target(request.url)
    except AgentHttpSigError:
        # A target that cannot be read cannot be matched to this verifier.
        return _deny("authority_mismatch")
    if target.authority is not None and target.authority != authority:
        return _deny("authority_mismatch")

    # 11. Content-Digest shape (spec section 2).
    digest = _parse_content_digest(field_value(headers, "content-digest"))
    if digest is None:
        return _deny("content_digest_malformed")

    # 12. The presentation fields (spec section 1.1).
    presentations: Dict[str, Tuple[str, Union[str, bytes]]] = {}
    for _header, name, member_name, required in _PRESENTATIONS:
        value = field_value(headers, name)
        if value is None:
            if required:
                return _deny("presentation_malformed")
            continue
        parsed = _parse_presentation(value)
        if parsed is None:
            return _deny("presentation_malformed")
        presentations[member_name] = parsed

    # 13-14. The key for keyid, whose thumbprint must be keyid. A resolver
    # failure propagates: the request is not answered as if it were forged.
    resolved = resolve_key(keyid)
    if resolved is None:
        return _deny("key_unknown")
    pub = public_key_object(resolved)
    if pub is None or jwk_thumbprint(resolved) != keyid:
        return _deny("key_mismatch")

    # 15. The signature over the recreated base, with this verifier's authority.
    try:
        base = create_signature_base(request, member, {"@authority": authority})
    except AgentHttpSigError:
        # A base that cannot be built (RFC 9421 section 2.5) cannot be verified.
        return _deny("signature_mismatch")
    if not verify_bytes(pub[0], pub[1], base, signature):
        return _deny("signature_mismatch")

    # 16. The content matches its digest.
    body = body_bytes(request.body)
    if not hmac.compare_digest(_sha256(body), digest):
        return _deny("content_digest_mismatch")

    # 17. Presentations by reference (spec section 1.2).
    out: Dict[str, str] = {}
    content: Union[Mapping[str, Any], str, None] = None
    for member_name, (form, data) in presentations.items():
        if form == "inline":
            assert isinstance(data, str)
            out[member_name] = data
            continue
        assert isinstance(data, bytes)
        if content is None:
            content = _read_credentials(body)
        value = None if isinstance(content, str) else content.get(member_name)
        if not isinstance(value, str):
            return _deny("presentation_missing")
        encoded = value.encode("utf-8", "surrogatepass")
        if len(encoded) <= INLINE_PRESENTATION_MAX_OCTETS or not _PRESENTATION.fullmatch(value):
            return _deny("presentation_malformed")
        if not hmac.compare_digest(_sha256(encoded), data):
            return _deny("presentation_hash_mismatch")
        out[member_name] = value

    # 18. The nonce, last, so only a request that passed everything else uses it up.
    if nonce_store.check_and_store(keyid, nonce, expires + skew) is not True:
        return _deny("nonce_replayed")

    return VerifyResult(
        ok=True,
        keyid=keyid,
        alg=pub[1],
        label=label,
        created=created,
        expires=expires,
        nonce=nonce,
        agent_passport=out["agent_passport"],
        agent_grant=out["agent_grant"],
        agent_trust=out.get("agent_trust"),
    )
