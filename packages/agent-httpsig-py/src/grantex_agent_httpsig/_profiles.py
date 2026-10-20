# SPDX-License-Identifier: Apache-2.0
"""Signature profiles: one RFC 9421 signer and verifier for three profiles.

``grantex``
    spec/verification.md: ``tag="agent-payer-auth"``, exactly ("@method"
    "@authority" "@path" "content-digest" "agent-passport" "agent-grant"), at
    most 300 seconds. ``sign()`` and ``verify()``, unchanged; this module
    delegates to them.
``tap``
    Visa Trusted Agent Protocol message signature: ``tag`` is
    ``agent-browser-auth`` (browsing) or ``agent-payer-auth`` (payment), at
    least ("@authority" "@path"), ``created``, ``expires`` at most 8 minutes
    later, ``keyid`` (an identifier from the network's key store, not a
    thumbprint), ``alg``, and a ``nonce`` that is equal in every signature of
    the message and refused when seen in the last 8 minutes.
``web-bot-auth``
    draft-ietf-webbotauth-httpsig-protocol-00 section 5: ``tag="web-bot-auth"``,
    ``@authority`` or ``@target-uri``, the ``"signature-agent";key="<label>"``
    member of the Signature-Agent Dictionary (section 5.2.1), ``created``,
    ``expires`` (at most 24 hours later, section 5.2), ``keyid`` the key's
    RFC 7638 thumbprint, and keys looked up by the (Signature-Agent URL,
    keyid) pair (section 5.4).

The grantex profile and the TAP payer profile share the tag
``agent-payer-auth``; the verifier is configured with the profile it
enforces. Mirrors ``packages/agent-httpsig/src/profiles.ts``.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import math
import re
import secrets
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import urlsplit

from ._errors import AgentHttpSigError
from ._keys import jwk_thumbprint, private_key_object, public_key_object, sign_bytes, verify_bytes
from ._message import (
    HttpRequest,
    body_bytes,
    create_signature_base,
    field_value,
    normalise_authority,
    parse_target,
)
from ._profile import (
    AGENT_PAYER_AUTH_TAG,
    COVERED_COMPONENTS,
    DEFAULT_CLOCK_SKEW_SECONDS,
    DEFAULT_SIGNATURE_LABEL,
    MAX_CLOCK_SKEW_SECONDS,
    MAX_SIGNATURE_WINDOW_SECONDS,
    NonceStore,
    VerifyResult,
    content_digest,
    sign,
    verify,
)
from .structured_fields import (
    InnerList,
    Item,
    Parameters,
    Token,
    parse_dictionary,
    serialize_dictionary,
    serialize_inner_list,
)

TAP_BROWSER_TAG = "agent-browser-auth"
TAP_PAYER_TAG = AGENT_PAYER_AUTH_TAG
WEB_BOT_AUTH_TAG = "web-bot-auth"
TAP_MAX_WINDOW_SECONDS = 480
TAP_NONCE_REPLAY_WINDOW_SECONDS = 480
WEB_BOT_AUTH_MAX_WINDOW_SECONDS = 86_400
SIGNATURE_AGENT_FIELD = "signature-agent"
SIGNATURE_AGENT_TYPES: Tuple[str, ...] = ("directory", "jwks_uri", "cimd")

JwkLike = Mapping[str, Any]


@dataclass(frozen=True)
class ProfileDefinition:
    name: str
    #: The tags a signature of the profile carries; the first is the signer's default.
    tags: Tuple[str, ...]
    #: What the signer covers by default (the grantex set is fixed).
    default_components: Tuple[str, ...]
    max_window_seconds: int
    default_window_seconds: int
    #: "required" or "optional".
    nonce: str
    #: "thumbprint" (RFC 7638) or "opaque" (an identifier from a key store).
    keyid: str


SIGNATURE_PROFILES: Mapping[str, ProfileDefinition] = {
    "grantex": ProfileDefinition(
        "grantex", (AGENT_PAYER_AUTH_TAG,), COVERED_COMPONENTS,
        MAX_SIGNATURE_WINDOW_SECONDS, 60, "required", "thumbprint",
    ),
    "tap": ProfileDefinition(
        "tap", (TAP_PAYER_TAG, TAP_BROWSER_TAG), ("@authority", "@path"),
        TAP_MAX_WINDOW_SECONDS, TAP_MAX_WINDOW_SECONDS, "required", "opaque",
    ),
    "web-bot-auth": ProfileDefinition(
        "web-bot-auth", (WEB_BOT_AUTH_TAG,), ("@authority", SIGNATURE_AGENT_FIELD),
        WEB_BOT_AUTH_MAX_WINDOW_SECONDS, 300, "optional", "thumbprint",
    ),
}


@dataclass(frozen=True)
class SignatureAgent:
    """A Signature-Agent member: an https URL and how to read it."""

    label: str
    url: str
    type: str = "directory"


@dataclass(frozen=True)
class KeyReference:
    """What a profile verifier hands its key resolver.

    For Web Bot Auth, look keys up by (``signature_agent.url``, ``keyid``),
    never by ``keyid`` alone (section 5.4).
    """

    profile: str
    tag: str
    keyid: str
    signature_agent: Optional[SignatureAgent]


@dataclass(frozen=True)
class ProfileSignResult:
    profile: str
    #: The fields to set on the request.
    headers: Dict[str, str]
    label: str
    tag: str
    keyid: str
    alg: str
    created: int
    expires: int
    nonce: Optional[str]
    components: Tuple[str, ...]
    signature_base: str


@dataclass(frozen=True)
class ProfileVerifyResult:
    """``ok`` with the verified values, or a denial ``code`` and ``reason``."""

    ok: bool
    profile: str
    code: Optional[str] = None
    reason: Optional[str] = None
    tag: Optional[str] = None
    label: Optional[str] = None
    keyid: Optional[str] = None
    alg: Optional[str] = None
    created: Optional[int] = None
    expires: Optional[int] = None
    nonce: Optional[str] = None
    components: Tuple[str, ...] = ()
    signature_agent: Optional[SignatureAgent] = None
    #: For the grantex profile: what ``verify()`` returned (the presentations).
    grantex: Optional[VerifyResult] = field(default=None, repr=False)


_OPAQUE_KEYID = re.compile(r'[!#-\[\]-~]{1,256}')
_THUMBPRINT_KEYID = re.compile(r"[A-Za-z0-9_-]{43}")
_TAP_NONCE = re.compile(r'[!#-\[\]-~]{1,256}')
_B64URL_NONCE = re.compile(r"[A-Za-z0-9_-]{22,128}")
_LABEL = re.compile(r"[a-z*][a-z0-9_\-.*]*")
_METHOD = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+")
_FIELD = re.compile(r"[!#$%&'*+\-.^_`|~0-9a-z]+")
_DERIVED = frozenset(("@method", "@target-uri", "@authority", "@scheme", "@path", "@query"))


def _now() -> int:
    return int(time.time())


def _is_int(value: Any) -> bool:
    return type(value) is int


def _is_str(value: Any) -> bool:
    return type(value) is str


def _is_https_url(value: str) -> bool:
    try:
        parts = urlsplit(value)
    except ValueError:
        return False
    return (
        parts.scheme == "https"
        and bool(parts.hostname)
        and parts.username is None
        and parts.password is None
        and parts.fragment == ""
        and "#" not in value
    )


# ── Signature-Agent ──────────────────────────────────────────────────────────


def serialize_signature_agent(agents: Sequence[SignatureAgent]) -> str:
    """The Signature-Agent field in the Dictionary form signers MUST use.

    draft-ietf-webbotauth-httpsig-protocol-00 section 5.2.1. ``type`` is
    omitted when it is ``directory``, the default.
    """
    dictionary: Dict[str, Any] = {}
    for agent in agents:
        if not _LABEL.fullmatch(agent.label):
            raise AgentHttpSigError("invalid Signature-Agent label")
        if not _is_https_url(agent.url):
            raise AgentHttpSigError("a Signature-Agent value must be an https URL")
        if agent.type not in SIGNATURE_AGENT_TYPES:
            raise AgentHttpSigError("unsupported Signature-Agent type")
        params: Parameters = {}
        if agent.type != "directory":
            params["type"] = Token(agent.type)
        dictionary[agent.label] = Item(agent.url, params)
    return serialize_dictionary(dictionary)


def parse_signature_agent(value: str) -> Dict[str, SignatureAgent]:
    """The members of a Signature-Agent field a verifier can use.

    String values holding an https URL, with a ``type`` of directory (the
    default), jwks_uri or cimd. Members of another type are ignored, as
    section 5.2.1 requires; a field that does not parse raises.
    """
    out: Dict[str, SignatureAgent] = {}
    for label, member in parse_dictionary(value).items():
        if not isinstance(member, Item) or not _is_str(member.value):
            continue
        agent_type = "directory"
        if "type" in member.params:
            t = member.params["type"]
            if not isinstance(t, Token) or str(t) not in SIGNATURE_AGENT_TYPES:
                continue
            agent_type = str(t)
        url = str(member.value)
        if not _is_https_url(url):
            continue
        out[label] = SignatureAgent(label, url, agent_type)
    return out


# ── Signing ──────────────────────────────────────────────────────────────────


def _component_item(component: str, agent_label: Optional[str]) -> Item:
    if component == SIGNATURE_AGENT_FIELD:
        if agent_label is None:
            raise AgentHttpSigError("signature-agent is covered but no Signature-Agent is sent")
        return Item(component, {"key": agent_label})
    if component not in _DERIVED and not _FIELD.fullmatch(component):
        raise AgentHttpSigError("unsupported covered component " + component)
    return Item(component)


def _check_profile_components(profile: str, components: Sequence[str], has_agent: bool) -> None:
    if len(set(components)) != len(components):
        raise AgentHttpSigError("a component is listed twice")
    if profile == "tap":
        if "@authority" not in components or "@path" not in components:
            raise AgentHttpSigError("a TAP signature covers @authority and @path")
        if SIGNATURE_AGENT_FIELD in components:
            raise AgentHttpSigError("TAP does not use Signature-Agent")
    else:
        if "@authority" not in components and "@target-uri" not in components:
            raise AgentHttpSigError("a Web Bot Auth signature covers @authority or @target-uri")
        if has_agent and SIGNATURE_AGENT_FIELD not in components:
            raise AgentHttpSigError("a Web Bot Auth signature covers signature-agent")


_UNSET: Any = object()


def sign_with_profile(
    request: HttpRequest,
    *,
    profile: str = "grantex",
    key: JwkLike,
    created: Optional[int] = None,
    expires: Optional[int] = None,
    label: str = DEFAULT_SIGNATURE_LABEL,
    components: Optional[Sequence[str]] = None,
    keyid: Optional[str] = None,
    tag: Optional[str] = None,
    nonce: Any = _UNSET,
    include_alg: bool = True,
    signature_agent_url: Optional[str] = None,
    signature_agent_type: str = "directory",
    **grantex_options: Any,
) -> ProfileSignResult:
    """Signs a request under a profile and returns the fields to set on it.

    ``grantex``: ``sign()`` (pass ``agent_passport``, ``agent_grant`` and
    optionally ``agent_trust``). ``tap``: ``keyid`` is the key's identifier
    in the network's key store (defaults to the thumbprint), ``tag`` defaults
    to ``agent-payer-auth``, ``nonce`` to a random UUID; put the same nonce in
    the TAP body objects. ``web-bot-auth``: ``signature_agent_url`` is
    required; ``nonce=None`` sends no nonce.
    """
    if profile == "grantex":
        result = sign(
            request,
            key=key,
            created=created,
            expires=expires,
            label=label,
            keyid=keyid,
            tag=tag,
            nonce=None if nonce is _UNSET else nonce,
            **grantex_options,
        )
        return ProfileSignResult(
            "grantex", result.headers, label, AGENT_PAYER_AUTH_TAG, result.keyid, result.alg,
            result.created, result.expires, result.nonce, COVERED_COMPONENTS,
            result.signature_base,
        )
    if grantex_options:
        raise AgentHttpSigError("unexpected options for the %s profile: %s" % (profile, ", ".join(sorted(grantex_options))))
    definition = SIGNATURE_PROFILES.get(profile)
    if definition is None:
        raise AgentHttpSigError("unknown signature profile")
    private_key, alg = private_key_object(key)
    thumbprint = jwk_thumbprint(key)
    if not _LABEL.fullmatch(label):
        raise AgentHttpSigError("invalid signature label")
    if not _METHOD.fullmatch(request.method):
        raise AgentHttpSigError("invalid method")
    if parse_target(request.url).authority is None:
        raise AgentHttpSigError("sign_with_profile() needs an absolute URL")
    created = _now() if created is None else created
    expires = created + definition.default_window_seconds if expires is None else expires
    for name, value in (("created", created), ("expires", expires)):
        if not _is_int(value) or value < 0:
            raise AgentHttpSigError(name + " must be a non-negative integer (UNIX seconds)")
    if expires <= created or expires - created > definition.max_window_seconds:
        raise AgentHttpSigError(
            "expires must be 1 to %d seconds after created" % definition.max_window_seconds
        )

    agent: Optional[SignatureAgent] = None
    use_alg = False
    if profile == "tap":
        keyid = thumbprint if keyid is None else keyid
        if not _is_str(keyid) or not _OPAQUE_KEYID.fullmatch(keyid):
            raise AgentHttpSigError(
                "a TAP keyid is 1 to 256 printable characters without quotes or backslashes"
            )
        tag = TAP_PAYER_TAG if tag is None else tag
        if tag not in definition.tags:
            raise AgentHttpSigError("a TAP tag is one of " + ", ".join(definition.tags))
        nonce = str(uuid.uuid4()) if nonce is _UNSET or nonce is None else nonce
        if not _is_str(nonce) or not _TAP_NONCE.fullmatch(nonce):
            raise AgentHttpSigError(
                "a TAP nonce is 1 to 256 printable characters without quotes or backslashes"
            )
        use_alg = include_alg
    else:
        if keyid is not None and keyid != thumbprint:
            raise AgentHttpSigError("keyid must be the RFC 7638 thumbprint of the key")
        if tag is not None and tag != WEB_BOT_AUTH_TAG:
            raise AgentHttpSigError("tag must be " + WEB_BOT_AUTH_TAG)
        keyid = thumbprint
        tag = WEB_BOT_AUTH_TAG
        if nonce is _UNSET:
            nonce = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
        if nonce is not None and (not _is_str(nonce) or not _B64URL_NONCE.fullmatch(nonce)):
            raise AgentHttpSigError("nonce must be 22 to 128 base64url characters")
        if signature_agent_url is None:
            raise AgentHttpSigError("signature_agent_url is required for web-bot-auth")
        agent = SignatureAgent(label, signature_agent_url, signature_agent_type)

    covered = tuple(components if components is not None else definition.default_components)
    _check_profile_components(profile, covered, agent is not None)

    headers: Dict[str, str] = {}
    signed: List[Tuple[str, str]] = []
    pairs = request.headers.items() if isinstance(request.headers, Mapping) else request.headers
    for n, v in pairs:
        for line in [v] if isinstance(v, str) else v:
            signed.append((n, line))
    if "content-digest" in covered and field_value(signed, "content-digest") is None:
        headers["Content-Digest"] = content_digest(request.body)
    if agent is not None:
        headers["Signature-Agent"] = serialize_signature_agent([agent])
    signed.extend(headers.items())

    params: Parameters = {"created": created, "expires": expires, "keyid": keyid}
    if use_alg:
        params["alg"] = alg
    if nonce is not None:
        params["nonce"] = nonce
    params["tag"] = tag
    inner = InnerList([_component_item(c, agent.label if agent else None) for c in covered], params)
    base = create_signature_base(HttpRequest(request.method, request.url, signed, request.body), inner)
    signature = sign_bytes(private_key, alg, base)
    headers["Signature-Input"] = label + "=" + serialize_inner_list(inner)
    headers["Signature"] = label + "=:" + base64.b64encode(signature).decode() + ":"
    return ProfileSignResult(
        profile, headers, label, tag, keyid, alg, created, expires, nonce, covered, base
    )


# ── Verification ─────────────────────────────────────────────────────────────


def _content_digest_matches(value: Optional[str], body: bytes) -> Optional[bool]:
    """RFC 9530: every sha-512 and sha-256 member checked; None when none usable."""
    if value is None:
        return None
    try:
        dictionary = parse_dictionary(value)
    except AgentHttpSigError:
        return None
    checked = False
    for name, algorithm in (("sha-512", hashlib.sha512), ("sha-256", hashlib.sha256)):
        member = dictionary.get(name)
        if member is None:
            continue
        if not isinstance(member, Item) or not isinstance(member.value, bytes):
            return None
        if not hmac.compare_digest(algorithm(body).digest(), member.value):
            return False
        checked = True
    return True if checked else None


def verify_with_profile(
    request: HttpRequest,
    *,
    profile: str = "grantex",
    resolve_key: Callable[[Any], Optional[JwkLike]],
    expected_authority: str,
    nonce_store: NonceStore,
    now: Optional[int] = None,
    clock_skew_seconds: int = DEFAULT_CLOCK_SKEW_SECONDS,
    tags: Optional[Sequence[str]] = None,
    required_components: Sequence[str] = (),
    label: Optional[str] = None,
    max_window_seconds: Optional[int] = None,
    require_signature_agent: bool = True,
    expected_scheme: str = "https",
) -> ProfileVerifyResult:
    """Verifies a request under a profile.

    ``grantex``: ``verify()``; ``resolve_key`` receives the keyid string.
    ``tap`` and ``web-bot-auth``: ``resolve_key`` receives a
    :class:`KeyReference`. A request that fails is answered with a denial;
    an exception from ``resolve_key`` or ``nonce_store`` propagates, and the
    caller must refuse the request.
    """
    if profile == "grantex":
        result = verify(
            request,
            resolve_key=resolve_key,
            expected_authority=expected_authority,
            nonce_store=nonce_store,
            now=now,
            clock_skew_seconds=clock_skew_seconds,
        )
        if not result.ok:
            return ProfileVerifyResult(False, "grantex", code=result.code, reason=result.reason)
        return ProfileVerifyResult(
            True, "grantex", tag=AGENT_PAYER_AUTH_TAG, label=result.label, keyid=result.keyid,
            alg=result.alg, created=result.created, expires=result.expires, nonce=result.nonce,
            components=COVERED_COMPONENTS, grantex=result,
        )
    definition = SIGNATURE_PROFILES.get(profile)
    if definition is None:
        raise AgentHttpSigError("unknown signature profile")
    skew = clock_skew_seconds
    if not _is_int(skew) or not 0 <= skew <= MAX_CLOCK_SKEW_SECONDS:
        raise AgentHttpSigError(
            "clock_skew_seconds must be an integer from 0 to %d" % MAX_CLOCK_SKEW_SECONDS
        )
    if not isinstance(expected_authority, str) or expected_authority == "":
        raise AgentHttpSigError("expected_authority is required")
    authority = normalise_authority(expected_authority, None)
    if re.search(r":(?:80|443)\Z", authority):
        raise AgentHttpSigError("expected_authority must omit the default port (80 or 443)")
    current = _now() if now is None else now
    if (
        isinstance(current, bool)
        or not isinstance(current, (int, float))
        or not math.isfinite(current)
        or current < 0
    ):
        raise AgentHttpSigError("now must be a finite, non-negative number (UNIX seconds)")
    current = int(current)
    max_window = definition.max_window_seconds
    if profile == "web-bot-auth" and max_window_seconds is not None:
        if not _is_int(max_window_seconds) or not 1 <= max_window_seconds <= WEB_BOT_AUTH_MAX_WINDOW_SECONDS:
            raise AgentHttpSigError(
                "max_window_seconds must be an integer from 1 to %d" % WEB_BOT_AUTH_MAX_WINDOW_SECONDS
            )
        max_window = max_window_seconds
    accepted = tuple(tags) if (profile == "tap" and tags is not None) else definition.tags
    for t in accepted:
        if t not in definition.tags:
            raise AgentHttpSigError("tag %s is not a %s tag" % (t, profile))

    def deny(reason: str, code: str = "request_signature_invalid") -> ProfileVerifyResult:
        return ProfileVerifyResult(False, profile, code=code, reason=reason)

    headers = request.headers
    input_field = field_value(headers, "signature-input")
    signature_field = field_value(headers, "signature")
    if input_field is None or signature_field is None:
        return deny("signature_missing")
    try:
        inputs = parse_dictionary(input_field)
        signatures = parse_dictionary(signature_field)
    except AgentHttpSigError:
        return deny("signature_malformed")

    tagged = [
        (lbl, m) for lbl, m in inputs.items()
        if isinstance(m, InnerList) and _is_str(m.params.get("tag")) and m.params["tag"] in definition.tags
    ]
    if not tagged:
        return deny("signature_not_found")
    if label is not None:
        tagged = [(lbl, m) for lbl, m in tagged if lbl == label]
    if not tagged:
        return deny("signature_not_found")
    if len(tagged) > 1:
        return deny("signature_ambiguous")
    sig_label, member = tagged[0]
    assert isinstance(member, InnerList)
    tag_value = str(member.params["tag"])
    if tag_value not in accepted:
        return deny("tag_not_accepted")

    sig_member = signatures.get(sig_label)
    if not isinstance(sig_member, Item) or not isinstance(sig_member.value, bytes) or sig_member.params:
        return deny("signature_malformed")
    signature = sig_member.value

    names: List[str] = []
    agent_key: Optional[str] = None
    for c in member.items:
        if not _is_str(c.value):
            return deny("covered_components_mismatch")
        name = str(c.value)
        if name == SIGNATURE_AGENT_FIELD and profile == "web-bot-auth":
            key_param = c.params.get("key")
            if len(c.params) != 1 or not _is_str(key_param) or agent_key is not None:
                return deny("covered_components_mismatch")
            agent_key = str(key_param)
        elif c.params or (name not in _DERIVED and (name.startswith("@") or not _FIELD.fullmatch(name))):
            return deny("covered_components_mismatch")
        names.append(name)
    if len(set(names)) != len(names):
        return deny("covered_components_mismatch")
    if profile == "tap":
        if "@authority" not in names or "@path" not in names:
            return deny("covered_components_mismatch")
    elif "@authority" not in names and "@target-uri" not in names:
        return deny("covered_components_mismatch")
    for required in required_components:
        if required not in names:
            return deny("covered_components_mismatch")

    p = member.params
    created = p.get("created")
    expires = p.get("expires")
    keyid = p.get("keyid")
    nonce = p.get("nonce")
    alg_param = p.get("alg")
    if (
        type(created) is not int or type(expires) is not int or type(keyid) is not str
        or (nonce is not None and not _is_str(nonce))
        or (alg_param is not None and not _is_str(alg_param))
    ):
        return deny("signature_params_mismatch")
    if created < 0 or expires <= created:
        return deny("signature_params_mismatch")
    pattern = _THUMBPRINT_KEYID if definition.keyid == "thumbprint" else _OPAQUE_KEYID
    if not pattern.fullmatch(keyid):
        return deny("signature_params_mismatch")
    nonce_value = str(nonce) if nonce is not None else None
    if definition.nonce == "required" and nonce_value is None:
        return deny("nonce_missing")
    if nonce_value is not None and not (_TAP_NONCE if profile == "tap" else _B64URL_NONCE).fullmatch(nonce_value):
        return deny("signature_params_mismatch")
    if profile == "tap":
        # TAP: the nonce is the same in every signature of the message.
        for m in inputs.values():
            other = m.params.get("nonce") if isinstance(m, InnerList) else None
            if other is not None and (not _is_str(other) or other != nonce_value):
                return deny("nonce_mismatch")

    if expires - created > max_window:
        return deny("window_too_long")
    if created > current + skew:
        return deny("created_in_future")
    if current >= expires + skew:
        return deny("expired", "request_signature_stale")

    try:
        target = parse_target(request.url)
    except AgentHttpSigError:
        return deny("authority_mismatch")
    if target.authority is not None and target.authority != authority:
        return deny("authority_mismatch")

    agent: Optional[SignatureAgent] = None
    if profile == "web-bot-auth":
        if agent_key is None:
            if require_signature_agent:
                return deny("signature_agent_missing")
        else:
            agent_field = field_value(headers, SIGNATURE_AGENT_FIELD)
            if agent_field is None:
                return deny("signature_agent_missing")
            try:
                agents = parse_signature_agent(agent_field)
            except AgentHttpSigError:
                return deny("signature_malformed")
            agent = agents.get(agent_key)
            if agent is None:
                return deny("signature_agent_unsupported")

    resolved = resolve_key(KeyReference(profile, tag_value, keyid, agent))
    if resolved is None:
        return deny("key_unknown")
    pub = public_key_object(resolved)
    if pub is None:
        return deny("key_mismatch")
    if definition.keyid == "thumbprint":
        try:
            if jwk_thumbprint(resolved) != keyid:
                return deny("key_mismatch")
        except AgentHttpSigError:
            return deny("key_mismatch")
    public_key, alg = pub
    if alg_param is not None:
        allowed = (alg, "Ed25519") if (profile == "tap" and alg == "ed25519") else (alg,)
        if alg_param not in allowed:
            return deny("algorithm_mismatch")

    scheme = expected_scheme if profile == "web-bot-auth" else "https"
    overrides = {
        "@authority": authority,
        "@target-uri": scheme + "://" + authority + (target.path or "/") + (target.query or ""),
    }
    try:
        base = create_signature_base(request, member, overrides)
    except AgentHttpSigError:
        return deny("signature_mismatch")
    if not verify_bytes(public_key, alg, base, signature):
        return deny("signature_mismatch")

    if "content-digest" in names:
        match = _content_digest_matches(field_value(headers, "content-digest"), body_bytes(request.body))
        if match is None:
            return deny("content_digest_malformed")
        if not match:
            return deny("content_digest_mismatch")

    if nonce_value is not None:
        if profile == "tap":
            until = max(expires + skew, current + TAP_NONCE_REPLAY_WINDOW_SECONDS)
        else:
            until = expires + skew
        scope = keyid if agent is None else agent.url + " " + keyid
        if nonce_store.check_and_store(scope, nonce_value, until) is not True:
            return deny("nonce_replayed")

    return ProfileVerifyResult(
        True, profile, tag=tag_value, label=sig_label, keyid=keyid, alg=alg, created=created,
        expires=expires, nonce=nonce_value, components=tuple(names), signature_agent=agent,
    )


__all__ = [
    "KeyReference",
    "ProfileDefinition",
    "ProfileSignResult",
    "ProfileVerifyResult",
    "SIGNATURE_AGENT_FIELD",
    "SIGNATURE_AGENT_TYPES",
    "SIGNATURE_PROFILES",
    "SignatureAgent",
    "TAP_BROWSER_TAG",
    "TAP_MAX_WINDOW_SECONDS",
    "TAP_NONCE_REPLAY_WINDOW_SECONDS",
    "TAP_PAYER_TAG",
    "WEB_BOT_AUTH_MAX_WINDOW_SECONDS",
    "WEB_BOT_AUTH_TAG",
    "parse_signature_agent",
    "serialize_signature_agent",
    "sign_with_profile",
    "verify_with_profile",
]
