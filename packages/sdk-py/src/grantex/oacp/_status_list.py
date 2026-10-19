"""Token Status List reading for OACP artifacts.

draft-ietf-oauth-status-list, the revision the auth service implements (-21).

An OACP envelope is a Referenced Token (§6.2): it carries
``status.status_list = {"idx": ..., "uri": ...}``. The issuer serves the list
at ``uri`` as a Status List Token (§5.1), media type
``application/statuslist+jwt`` (§8.2), signed with a key from the same JWK Set
as the artifact. The list is ``bits`` wide per entry, packed from the least
significant bit of each byte, DEFLATE-compressed in the ZLIB format and
base64url encoded (§4.1, §4.2).

Everything here fails closed: a list that cannot be fetched, verified or
decoded never reads as VALID.
"""

from __future__ import annotations

import zlib
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, NamedTuple, Optional

from ._jose import (
    JS_WHITESPACE,
    decode_base64url_strict,
    decode_json_segment,
    is_plain_object,
    is_safe_integer,
    select_verification_key,
    verify_jws_signature,
)
from ._time import epoch_millis

__all__ = [
    "OACP_TOKEN_STATUS",
    "STATUS_LIST_CLOCK_SKEW_SECONDS",
    "STATUS_LIST_MAX_DECODED_BYTES",
    "STATUS_LIST_TOKEN_MEDIA_TYPE",
    "STATUS_LIST_TOKEN_TYP",
    "DecodedOacpStatusList",
    "OacpStatusListError",
    "OacpStatusRead",
    "OacpTokenStatus",
    "decode_oacp_status_list",
    "read_oacp_status",
]


class OacpTokenStatus(NamedTuple):
    """draft-ietf-oauth-status-list §7.1 status types."""

    VALID: int
    INVALID: int
    SUSPENDED: int


#: draft-ietf-oauth-status-list §7.1 status types.
OACP_TOKEN_STATUS = OacpTokenStatus(VALID=0x00, INVALID=0x01, SUSPENDED=0x02)

#: §5.1 ``typ`` of a Status List Token.
STATUS_LIST_TOKEN_TYP = "statuslist+jwt"

#: §8.2 media type of a Status List Token response.
STATUS_LIST_TOKEN_MEDIA_TYPE = "application/statuslist+jwt"

#: Upper bound on an inflated list, so a hostile list cannot exhaust memory.
STATUS_LIST_MAX_DECODED_BYTES = 16 * 1024 * 1024

#: Seconds of clock skew allowed on the list's ``iat``.
STATUS_LIST_CLOCK_SKEW_SECONDS = 60

_STATUS_LIST_ALGORITHMS = frozenset({"ES256", "RS256"})
_ALLOWED_BITS = (1, 2, 4, 8)


class OacpStatusListError(Exception):
    """A Status List Token or StatusList object that cannot be read."""


@dataclass(frozen=True)
class DecodedOacpStatusList:
    """A decoded §4.2 StatusList: ``bits`` per entry over ``size`` entries."""

    bits: int
    #: Number of entries the byte array holds.
    size: int
    _bytes: bytes = field(repr=False)

    def status_at(self, idx: int) -> int:
        """The status at ``idx``; raises for an index outside the list (§8.3 step 6)."""
        if not is_safe_integer(idx) or idx < 0 or idx >= self.size:
            raise OacpStatusListError(f"index {idx} is outside a list of {self.size} entries")
        index = int(idx)
        per_byte = 8 // self.bits
        mask = (1 << self.bits) - 1
        # §4.1 step 3: entries are packed from the least significant bit.
        return (self._bytes[index // per_byte] >> ((index % per_byte) * self.bits)) & mask


def _inflate(compressed: bytes) -> bytes:
    """ZLIB-format inflate bounded by :data:`STATUS_LIST_MAX_DECODED_BYTES`.

    Bytes after the end of the ZLIB stream are ignored, as Node's
    ``inflateSync`` ignores them; a truncated stream is refused.
    """
    decompressor = zlib.decompressobj()
    try:
        data = decompressor.decompress(compressed, STATUS_LIST_MAX_DECODED_BYTES + 1)
    except zlib.error as exc:
        raise OacpStatusListError(f"lst is not ZLIB data: {exc}") from None
    if len(data) > STATUS_LIST_MAX_DECODED_BYTES:
        raise OacpStatusListError(
            f"lst is not ZLIB data: it inflates past {STATUS_LIST_MAX_DECODED_BYTES} bytes"
        )
    if not decompressor.eof:
        raise OacpStatusListError("lst is not ZLIB data: unexpected end of file")
    return data


def decode_oacp_status_list(status_list: Any) -> DecodedOacpStatusList:
    """Reads a §4.2 StatusList object ``{"bits": ..., "lst": ...}``.

    Raises :class:`OacpStatusListError` on anything malformed.
    """
    if not is_plain_object(status_list):
        raise OacpStatusListError("status_list must be an object")
    bits = status_list.get("bits")
    lst = status_list.get("lst")
    if not is_safe_integer(bits) or int(bits) not in _ALLOWED_BITS:
        raise OacpStatusListError("bits must be 1, 2, 4 or 8")
    if not isinstance(lst, str) or len(lst) == 0:
        raise OacpStatusListError("lst must be a base64url string")
    compressed = decode_base64url_strict(lst)
    if compressed is None:
        raise OacpStatusListError("lst must be a base64url string")
    # §8.3 step 5: a decompressor for DEFLATE in the ZLIB format.
    data = _inflate(compressed)
    width = int(bits)
    return DecodedOacpStatusList(bits=width, size=len(data) * (8 // width), _bytes=data)


@dataclass(frozen=True)
class OacpStatusRead:
    """The status entry read from a verified Status List Token."""

    status: int
    #: Seconds the read may be reused for (the list's ``ttl``), when it states one.
    ttl_seconds: Optional[int]


def read_oacp_status(
    *,
    token: Any,
    uri: str,
    idx: int,
    jwks: Any,
    issuer: str,
    now: datetime,
) -> OacpStatusRead:
    """Verifies a Status List Token (§5.1, §8.3) and returns the status at ``idx``.

    ``token`` is the Status List Token text, ``uri`` the URI the artifact
    names (the token's ``sub`` must equal it), ``jwks`` the issuer's JWK Set
    (the one the artifact verified against) and ``issuer`` the pinned issuer
    (a token with an ``iss`` must name it). A naive ``now`` is read as UTC.

    Raises :class:`OacpStatusListError` for anything that prevents reading the entry.
    """
    return _read_status(token=token, uri=uri, idx=idx, jwks=jwks, issuer=issuer, now_ms=epoch_millis(now))


def _read_status(*, token: Any, uri: str, idx: int, jwks: Any, issuer: str, now_ms: int) -> OacpStatusRead:
    if not isinstance(token, str):
        raise OacpStatusListError("the status list is not a compact JWS")
    parts = token.strip(JS_WHITESPACE).split(".")
    if len(parts) != 3 or any(len(part) == 0 for part in parts):
        raise OacpStatusListError("the status list is not a compact JWS")
    header_segment, payload_segment, signature_segment = parts
    header = decode_json_segment(header_segment)
    if header is None:
        raise OacpStatusListError("the status list header is not a JSON object")
    if header.get("typ") != STATUS_LIST_TOKEN_TYP:
        raise OacpStatusListError(f"the status list typ is not {STATUS_LIST_TOKEN_TYP}")
    alg = header.get("alg")
    if not isinstance(alg, str) or alg not in _STATUS_LIST_ALGORITHMS:
        raise OacpStatusListError("the status list algorithm is not ES256 or RS256")
    if "crit" in header:
        raise OacpStatusListError("the status list header has crit parameters")
    kid = header.get("kid")
    if not isinstance(kid, str) or len(kid) == 0:
        raise OacpStatusListError("the status list header has no kid")
    key = select_verification_key(jwks, kid, alg)
    if key.key is None:
        raise OacpStatusListError(f"status list key: {key.reason}")
    signature = decode_base64url_strict(signature_segment)
    if signature is None or not verify_jws_signature(
        alg, key.key, f"{header_segment}.{payload_segment}", signature
    ):
        raise OacpStatusListError("the status list signature does not verify")

    claims = decode_json_segment(payload_segment)
    if claims is None:
        raise OacpStatusListError("the status list claims are not a JSON object")
    if not isinstance(claims.get("sub"), str) or claims["sub"] != uri:
        raise OacpStatusListError("the status list sub is not the URI the artifact names")
    if "iss" in claims and (not isinstance(claims["iss"], str) or claims["iss"] != issuer):
        raise OacpStatusListError("the status list iss is not the pinned issuer")
    now_s = now_ms // 1000

    def is_time(value: Any) -> bool:
        return is_safe_integer(value) and value >= 0

    iat: Any = claims.get("iat")
    if not is_time(iat):
        raise OacpStatusListError("the status list iat must be an integer")
    has_exp = "exp" in claims
    has_ttl = "ttl" in claims
    exp: Any = claims.get("exp")
    ttl: Any = claims.get("ttl")
    if has_exp and not is_time(exp):
        raise OacpStatusListError("the status list exp must be an integer")
    if has_ttl and (not is_time(ttl) or ttl == 0):
        raise OacpStatusListError("the status list ttl must be a positive integer")
    if int(iat) > now_s + STATUS_LIST_CLOCK_SKEW_SECONDS:
        raise OacpStatusListError("the status list iat is in the future")
    if has_exp:
        if now_s >= int(exp):
            raise OacpStatusListError("the status list has expired")
    elif has_ttl:
        if now_s >= int(iat) + int(ttl):
            raise OacpStatusListError("the status list is older than its ttl")
    else:
        raise OacpStatusListError("the status list has neither exp nor ttl")
    status_list = decode_oacp_status_list(claims.get("status_list"))
    return OacpStatusRead(
        status=status_list.status_at(idx),
        ttl_seconds=int(ttl) if has_ttl else None,
    )
