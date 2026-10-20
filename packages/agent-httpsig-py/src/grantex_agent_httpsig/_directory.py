# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
"""The HTTP Message Signatures key directory, and several signatures on one request.

draft-meunier-webbotauth-httpsig-directory-00: a JWK Set served at
``/.well-known/http-message-signatures-directory`` with media type
``application/http-message-signatures-directory+json`` (section 3), each
key's ``kid`` its RFC 7638 thumbprint, the response signed once per key
(section 5.2) over ``"@authority";req`` and ``content-digest`` with
``tag="http-message-signatures-directory"``. Clients SHOULD ignore keys
without a valid response signature; ``verify_directory_response`` returns
only those. Mirrors ``packages/agent-httpsig/src/directory.ts``.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence

from ._errors import AgentHttpSigError
from ._keys import jwk_thumbprint, private_key_object, public_jwk, public_key_object, sign_bytes, verify_bytes
from ._message import HttpRequest, HttpResponse, body_bytes, create_signature_base, field_value, normalise_authority
from ._profile import content_digest
from ._profiles import ProfileSignResult
from .structured_fields import InnerList, Item, parse_dictionary, serialize_dictionary, serialize_inner_list

SIGNATURE_DIRECTORY_PATH = "/.well-known/http-message-signatures-directory"
SIGNATURE_DIRECTORY_MEDIA_TYPE = "application/http-message-signatures-directory+json"
SIGNATURE_DIRECTORY_TAG = "http-message-signatures-directory"
DIRECTORY_SIGNATURE_WINDOW_SECONDS = 300

JwkLike = Mapping[str, Any]


def build_signature_directory(keys: Sequence[JwkLike]) -> Dict[str, List[Dict[str, Any]]]:
    """The directory document: public members, ``kid`` = thumbprint, ``use`` = sig."""
    seen: set[str] = set()
    out: List[Dict[str, Any]] = []
    for key in keys:
        pub: Dict[str, Any] = dict(public_jwk(key))
        kid = jwk_thumbprint(pub)
        if kid in seen:
            continue
        seen.add(kid)
        pub["kid"] = kid
        pub["use"] = "sig"
        for extra in ("nbf", "exp"):
            if extra in key:
                pub[extra] = key[extra]
        out.append(pub)
    return {"keys": out}


def _directory_request(authority: str) -> HttpRequest:
    return HttpRequest("GET", "https://" + authority + SIGNATURE_DIRECTORY_PATH)


def sign_directory_response(
    body: str,
    *,
    authority: str,
    signing_keys: Sequence[JwkLike],
    created: Optional[int] = None,
    expires: Optional[int] = None,
) -> Dict[str, str]:
    """Content-Type, Content-Digest and one signature per signing key (sig1, sig2, ...)."""
    if not signing_keys:
        raise AgentHttpSigError("at least one signing key is required")
    host = normalise_authority(authority, None)
    created = int(time.time()) if created is None else created
    expires = created + DIRECTORY_SIGNATURE_WINDOW_SECONDS if expires is None else expires
    if expires <= created:
        raise AgentHttpSigError("expires must be after created (UNIX seconds)")
    headers: Dict[str, str] = {
        "Content-Type": SIGNATURE_DIRECTORY_MEDIA_TYPE,
        "Content-Digest": content_digest(body),
    }
    request = _directory_request(host)
    inputs: List[str] = []
    signatures: List[str] = []
    for i, jwk in enumerate(signing_keys):
        private_key, alg = private_key_object(jwk)
        label = "sig%d" % (i + 1)
        params = InnerList(
            [Item("@authority", {"req": True}), Item("content-digest")],
            {"created": created, "expires": expires, "keyid": jwk_thumbprint(jwk), "tag": SIGNATURE_DIRECTORY_TAG},
        )
        base = create_signature_base(HttpResponse(200, dict(headers), body), params, None, request)
        inputs.append(label + "=" + serialize_inner_list(params))
        signatures.append(label + "=:" + base64.b64encode(sign_bytes(private_key, alg, base)).decode() + ":")
    headers["Signature-Input"] = ", ".join(inputs)
    headers["Signature"] = ", ".join(signatures)
    return headers


@dataclass(frozen=True)
class VerifiedDirectory:
    #: Keys with a valid, current response signature; the only ones to use.
    keys: List[Dict[str, Any]]
    #: Keys present without a valid signature (ignored, section 5.2).
    ignored: List[str] = field(default_factory=list)


def _thumbprint_or_none(key: Any) -> Optional[str]:
    try:
        return jwk_thumbprint(key)
    except (AgentHttpSigError, TypeError):
        return None


def verify_directory_response(
    response: HttpResponse,
    *,
    authority: str,
    now: Optional[int] = None,
    clock_skew_seconds: int = 10,
) -> VerifiedDirectory:
    """Reads a directory response and returns the keys with their own valid signature.

    Raises when the response is not a directory at all (not 200, another
    media type, not a JWK Set).
    """
    if response.status != 200:
        raise AgentHttpSigError("a directory is read from a 200 response only")
    content_type = field_value(response.headers, "content-type")
    if content_type is None or content_type.split(";")[0].strip().lower() != SIGNATURE_DIRECTORY_MEDIA_TYPE:
        raise AgentHttpSigError("the directory media type is " + SIGNATURE_DIRECTORY_MEDIA_TYPE)
    body = body_bytes(response.body)
    try:
        document = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise AgentHttpSigError("the directory is not JSON") from None
    keys = document.get("keys") if isinstance(document, dict) else None
    if not isinstance(keys, list):
        raise AgentHttpSigError("the directory is not a JWK Set")
    host = normalise_authority(authority, None)
    current = int(time.time()) if now is None else now
    request = _directory_request(host)

    digest_ok = False
    digest_field = field_value(response.headers, "content-digest")
    if digest_field is not None:
        try:
            member = parse_dictionary(digest_field).get("sha-256")
            digest_ok = (
                isinstance(member, Item) and isinstance(member.value, bytes)
                and hmac.compare_digest(member.value, hashlib.sha256(body).digest())
            )
        except AgentHttpSigError:
            digest_ok = False

    inputs: Dict[str, Any] = {}
    signatures: Dict[str, Any] = {}
    input_field = field_value(response.headers, "signature-input")
    signature_field = field_value(response.headers, "signature")
    if input_field is not None and signature_field is not None:
        try:
            inputs = dict(parse_dictionary(input_field))
            signatures = dict(parse_dictionary(signature_field))
        except AgentHttpSigError:
            inputs = {}

    signed: set[str] = set()
    if digest_ok:
        for label, member in inputs.items():
            if not isinstance(member, InnerList):
                continue
            p = member.params
            keyid, created, expires = p.get("keyid"), p.get("created"), p.get("expires")
            if p.get("tag") != SIGNATURE_DIRECTORY_TAG or type(keyid) is not str:
                continue
            if type(created) is not int or type(expires) is not int:
                continue
            if created > current + clock_skew_seconds or current >= expires + clock_skew_seconds:
                continue
            covered = [str(c.value) + (";req" if "req" in c.params else "") for c in member.items]
            if "@authority;req" not in covered or "content-digest" not in covered:
                continue
            jwk = next((k for k in keys if _thumbprint_or_none(k) == keyid), None)
            pub = None if jwk is None else public_key_object(public_jwk(jwk))
            sig = signatures.get(label)
            if pub is None or not isinstance(sig, Item) or not isinstance(sig.value, bytes):
                continue
            try:
                base = create_signature_base(response, member, None, request)
            except AgentHttpSigError:
                continue
            if verify_bytes(pub[0], pub[1], base, sig.value):
                signed.add(keyid)

    valid: List[Dict[str, Any]] = []
    ignored: List[str] = []
    for k in keys:
        kid = _thumbprint_or_none(k)
        if kid is None:
            ignored.append(str(k.get("kid", "")) if isinstance(k, dict) else "")
            continue
        declared = k.get("kid")
        if kid in signed and (declared is None or declared == kid):
            entry: Dict[str, Any] = dict(public_jwk(k))
            entry["kid"] = kid
            entry["use"] = "sig"
            valid.append(entry)
        else:
            ignored.append(kid)
    return VerifiedDirectory(valid, ignored)


def combine_signatures(*results: ProfileSignResult) -> Dict[str, str]:
    """Merges the fields of several signatures of one request (RFC 9421 section 4.3).

    Use it to send a grantex and a web-bot-auth signature together, so the
    request carries Signature-Agent for Web Bot Auth relying parties while
    Grantex verifiers read the ``agent-payer-auth`` signature.
    """
    dictionaries: Dict[str, Dict[str, Any]] = {}
    out: Dict[str, str] = {}
    labels: set[str] = set()
    for result in results:
        if result.label in labels:
            raise AgentHttpSigError("signature label %s is used twice" % result.label)
        labels.add(result.label)
        for name, value in result.headers.items():
            if name in ("Signature-Input", "Signature", "Signature-Agent"):
                dictionary = dictionaries.setdefault(name, {})
                for key, member in parse_dictionary(value).items():
                    if key in dictionary:
                        raise AgentHttpSigError("%s member %s is set twice" % (name, key))
                    dictionary[key] = member
            elif name in out and out[name] != value:
                raise AgentHttpSigError("the signatures disagree on " + name)
            else:
                out[name] = value
    for name in ("Signature-Agent", "Signature-Input", "Signature"):
        if name in dictionaries:
            out[name] = serialize_dictionary(dictionaries[name])
    return out


__all__ = [
    "DIRECTORY_SIGNATURE_WINDOW_SECONDS",
    "SIGNATURE_DIRECTORY_MEDIA_TYPE",
    "SIGNATURE_DIRECTORY_PATH",
    "SIGNATURE_DIRECTORY_TAG",
    "VerifiedDirectory",
    "build_signature_directory",
    "combine_signatures",
    "sign_directory_response",
    "verify_directory_response",
]
