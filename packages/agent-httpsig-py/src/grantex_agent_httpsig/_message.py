# SPDX-License-Identifier: Apache-2.0
"""HTTP messages as RFC 9421 sees them.

Field values (section 2.1), the derived components this library implements
(section 2.2) and the signature base (section 2.5).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Iterable, Mapping, Optional, Sequence, Tuple, Union

from ._errors import AgentHttpSigError
from .structured_fields import (
    InnerList,
    parse_dictionary,
    serialize_inner_list,
    serialize_item,
    serialize_key,
    serialize_member,
)

HeaderValue = Union[str, Sequence[str]]
Headers = Union[Mapping[str, HeaderValue], Iterable[Tuple[str, str]]]
Body = Union[bytes, str, None]


@dataclass
class HttpRequest:
    """A request to sign or verify.

    ``url`` is absolute (``https://merchant.example/v1/checkout``) or, when
    verifying, origin-form (``/v1/checkout``). ``headers`` is a mapping (a
    value may be a list of field lines) or a sequence of (name, value) pairs.
    A ``str`` body is sent as UTF-8.
    """

    method: str
    url: str
    headers: Headers = field(default_factory=dict)
    body: Body = b""


@dataclass
class HttpResponse:
    status: int
    headers: Headers = field(default_factory=dict)
    body: Body = b""


HttpMessage = Union[HttpRequest, HttpResponse]


def body_bytes(body: Body) -> bytes:
    if body is None:
        return b""
    return body.encode("utf-8") if isinstance(body, str) else bytes(body)


def _trim(value: str) -> str:
    return value.strip(" \t")


def field_lines(headers: Headers, name: str) -> Optional[list[str]]:
    """The field lines named ``name`` (case-insensitive), in order.

    Each is trimmed of leading and trailing whitespace (RFC 9421 section 2.1
    step 2). None when the field is absent.
    """
    lower = name.lower()
    out: list[str] = []
    pairs: Iterable[Tuple[str, HeaderValue]]
    if isinstance(headers, Mapping):
        pairs = headers.items()
    else:
        pairs = headers
    for n, v in pairs:
        if n.lower() != lower:
            continue
        for line in [v] if isinstance(v, str) else v:
            out.append(_trim(line))
    return out or None


def field_value(headers: Headers, name: str) -> Optional[str]:
    """The field value: its lines joined with ", " (RFC 9421 section 2.1 step 4)."""
    lines = field_lines(headers, name)
    return None if lines is None else ", ".join(lines)


@dataclass
class TargetUri:
    scheme: Optional[str]
    #: Normalised authority (RFC 9421 section 2.2.3); None for an origin-form target.
    authority: Optional[str]
    path: str
    query: Optional[str]


_DEFAULT_PORTS = {"http": "80", "https": "443"}
_ORIGIN_FORM = re.compile(r"([^?#]*)(\?[^#]*)?(#.*)?", re.S)
_ABSOLUTE = re.compile(r"([A-Za-z][A-Za-z0-9+.-]*)://([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?", re.S)
_AUTHORITY = re.compile(r"(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._~%!$&'()*+,;=-]+)(?::([0-9]*))?")


def parse_target(url: str) -> TargetUri:
    """Splits a target with the RFC 3986 Appendix B expression.

    Nothing is resolved or re-encoded: RFC 9421 takes @path and @query before
    percent-decoding (sections 2.2.6, 2.2.7).
    """
    if url.startswith("/"):
        m = _ORIGIN_FORM.fullmatch(url)
        assert m is not None
        return TargetUri(None, None, m.group(1), m.group(2))
    m = _ABSOLUTE.fullmatch(url)
    if m is None:
        raise AgentHttpSigError(
            "request target is neither an absolute http(s) URL nor an absolute path"
        )
    scheme = m.group(1).lower()
    if scheme not in ("http", "https"):
        raise AgentHttpSigError("unsupported scheme " + scheme)
    return TargetUri(scheme, normalise_authority(m.group(2), scheme), m.group(3), m.group(4))


def normalise_authority(authority: str, scheme: Optional[str]) -> str:
    """RFC 9421 section 2.2.3 (RFC 9110 section 4.2.3).

    Host lowercased, default port omitted. Userinfo is refused (RFC 9110
    section 4.2.4).
    """
    m = _AUTHORITY.fullmatch(authority)
    if m is None:
        raise AgentHttpSigError("invalid authority")
    host = m.group(1).lower()
    port = m.group(2)
    if not port or (scheme is not None and _DEFAULT_PORTS.get(scheme) == port):
        return host
    return host + ":" + port


def _derived_value(message: HttpMessage, name: str) -> str:
    if name == "@status":
        # Section 2.2.9: responses only.
        if isinstance(message, HttpRequest):
            raise AgentHttpSigError("@status is not defined for a request")
        status = message.status
        if isinstance(status, bool) or not isinstance(status, int) or not 100 <= status <= 999:
            raise AgentHttpSigError("invalid status")
        return str(status)
    if not isinstance(message, HttpRequest):
        raise AgentHttpSigError(name + " is not implemented for a response")
    target = parse_target(message.url)
    if name == "@method":
        # Section 2.2.1: as sent, case preserved.
        return message.method
    if name == "@target-uri":
        # Section 2.2.2: the full target URI (RFC 9110 section 7.1), without a fragment.
        if target.authority is None or target.scheme is None:
            raise AgentHttpSigError("@target-uri needs an absolute target")
        return (
            target.scheme + "://" + target.authority + (target.path or "/")
            + (target.query or "")
        )
    if name == "@authority":
        # Section 2.2.3.
        if target.authority is None:
            raise AgentHttpSigError("@authority needs an absolute target")
        return target.authority
    if name == "@scheme":
        # Section 2.2.4.
        if target.scheme is None:
            raise AgentHttpSigError("@scheme needs an absolute target")
        return target.scheme
    if name == "@path":
        # Section 2.2.6: an empty path is "/".
        return target.path or "/"
    if name == "@query":
        # Section 2.2.7: with the leading "?", and "?" alone when absent.
        return target.query if target.query is not None else "?"
    raise AgentHttpSigError("derived component " + name + " is not implemented")


# RFC 9110 section 5.6.2 tchar without uppercase ALPHA (RFC 9421 section 2.1).
_FIELD_NAME = re.compile(r"[!#$%&'*+\-.^_`|~0-9a-z]+")
_PRINTABLE = re.compile(r"[\x20-\x7e]*")


def _check_value(value: str, name: str) -> None:
    # Component values are ASCII (section 2.5 step 4) with no line breaks (section 2.2).
    if not _PRINTABLE.fullmatch(value):
        raise AgentHttpSigError(
            "component " + name + " has a value outside printable ASCII"
        )


_IMPLEMENTED_COMPONENT_PARAMS = frozenset(("key", "req"))


def create_signature_base(
    message: HttpMessage,
    signature_params: InnerList,
    overrides: Optional[Mapping[str, str]] = None,
    related: Optional[HttpRequest] = None,
) -> str:
    """RFC 9421 section 2.5.

    The signature base for the covered components and signature parameters
    of ``signature_params``. Of the component parameters, ``key`` (a
    Dictionary member, section 2.1.2) and ``req`` (the component of the
    request a response answers, section 2.4, read from ``related``) are
    implemented; any other (``sf``, ``bs``, ``tr``, ``name``) fails, as step
    2.5 requires for a parameter that is not understood. ``overrides`` gives
    values used in place of the message's own for derived components without
    parameters (the verifier's @authority or @target-uri).
    """
    lines: list[str] = []
    seen: set[str] = set()
    for component in signature_params.items:
        name = component.value
        if not isinstance(name, str) or type(name) is not str:
            raise AgentHttpSigError("a component identifier is not a String")
        for param in component.params:
            if param not in _IMPLEMENTED_COMPONENT_PARAMS:
                raise AgentHttpSigError(
                    "component parameter " + param + " is not implemented (" + name + ")"
                )
        key = component.params.get("key")
        req = component.params.get("req")
        if key is not None and type(key) is not str:
            raise AgentHttpSigError("the key parameter of " + name + " is not a String")
        if req is not None and req is not True:
            raise AgentHttpSigError("the req parameter of " + name + " is not true")
        identifier = serialize_item(component)
        # Step 2.1: no component twice (the same name and parameters).
        if identifier in seen:
            raise AgentHttpSigError("component " + identifier + " is covered twice")
        seen.add(identifier)
        if name == "@signature-params":
            raise AgentHttpSigError("@signature-params cannot be a covered component")
        source: HttpMessage = message
        if req is not None:
            # Section 2.4: only a response has a related request.
            if isinstance(message, HttpRequest):
                raise AgentHttpSigError(identifier + " needs a response")
            if related is None:
                raise AgentHttpSigError(identifier + " needs the related request")
            source = related
        if name.startswith("@"):
            if key is not None:
                raise AgentHttpSigError("the key parameter does not apply to " + name)
            value = (overrides or {}).get(name) if not component.params else None
            if value is None:
                value = _derived_value(source, name)
        else:
            # Section 2.1: the lowercased form of an RFC 9110 section 5.1
            # field name (token = 1*tchar, section 5.6.2).
            if not _FIELD_NAME.fullmatch(name):
                raise AgentHttpSigError("invalid field name %r" % name)
            v = field_value(source.headers, name)
            if v is None:
                raise AgentHttpSigError("covered field " + name + " is not in the message")
            if key is not None:
                # Section 2.1.2: the member, re-serialized; a missing member fails.
                member = parse_dictionary(v).get(key)
                if member is None:
                    raise AgentHttpSigError(
                        "covered field " + name + " has no member " + key
                    )
                value = serialize_member(member)
            else:
                value = v
        _check_value(value, name)
        lines.append(identifier + ": " + value)
    lines.append('"@signature-params": ' + serialize_inner_list(signature_params))
    base = "\n".join(lines)
    _check_value(base.replace("\n", " "), "@signature-params")
    return base


def signature_base_for(
    message: HttpMessage, label: str, related: Optional[HttpRequest] = None
) -> str:
    """The signature base of the signature labelled ``label``.

    Taken from the message's Signature-Input field (RFC 9421 section 3.2
    steps 2 and 7). ``related`` is the request a response answers, for
    components with ``req``.
    """
    serialize_key(label)
    value = field_value(message.headers, "signature-input")
    if value is None:
        raise AgentHttpSigError("the message has no Signature-Input field")
    member = parse_dictionary(value).get(label)
    if member is None:
        raise AgentHttpSigError("Signature-Input has no signature labelled " + label)
    if not isinstance(member, InnerList):
        raise AgentHttpSigError("Signature-Input member " + label + " is not an Inner List")
    return create_signature_base(message, member, None, related)
