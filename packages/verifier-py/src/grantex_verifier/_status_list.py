# SPDX-License-Identifier: Apache-2.0
"""Token Status List (draft-ietf-oauth-status-list-21) for a relying party.

A Status List Token is a JWT with ``typ`` ``statuslist+jwt`` (section 5.1),
``sub`` the list's URI, ``iat``, and, RECOMMENDED, ``exp`` and ``ttl`` (the
seconds it may be cached). ``status_list`` holds ``bits`` (1, 2, 4 or 8) and
``lst``, the statuses packed from the least significant bit and compressed
with DEFLATE in the ZLIB format (section 4.1). Section 7.1 defines 0x00
VALID, 0x01 INVALID and 0x02 SUSPENDED. Section 8.3 is the validation this
module performs; every failure to read an entry is a JoseError the caller
turns into ``status_stale``, never a pass.
"""

from __future__ import annotations

import zlib
from dataclasses import dataclass
from typing import Any, Mapping, Optional, Sequence

from ._jose import JoseError, b64url_decode, check_header, parse, verify_with_keys

STATUS_LIST_TYP = "statuslist+jwt"
VALID, INVALID, SUSPENDED = 0x00, 0x01, 0x02
STATUS_NAMES = {VALID: "VALID", INVALID: "INVALID", SUSPENDED: "SUSPENDED"}
#: A decompressed list larger than this is refused (a small token can inflate a lot).
MAX_DECODED_BYTES = 16 * 1024 * 1024
#: Tolerance for an ``iat`` slightly in the future (clock difference).
CLOCK_TOLERANCE_SECONDS = 60


def status_name(value: int) -> str:
    return STATUS_NAMES.get(value, "0x%02x" % value)


@dataclass(frozen=True)
class StatusListToken:
    """A verified Status List Token: its times and its decoded entries."""

    uri: str
    iat: int
    exp: Optional[int]
    ttl: Optional[int]
    bits: int
    data: bytes

    def entry(self, idx: int) -> int:
        per_byte = 8 // self.bits
        if idx < 0 or idx >= len(self.data) * per_byte:
            # Section 8.3 step 6: an index out of bounds is an error, not a status.
            raise JoseError("index_out_of_range", "the status list has no entry %d" % idx)
        byte = self.data[idx // per_byte]
        return (byte >> ((idx % per_byte) * self.bits)) & ((1 << self.bits) - 1)

    def usable_at(self, now: float) -> bool:
        """Fresh by ``exp`` or, without ``exp``, by ``iat`` + ``ttl`` (section 13.7)."""
        if self.exp is not None:
            return now < self.exp
        return self.ttl is not None and now < self.iat + self.ttl


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _decode_lst(lst: Any) -> bytes:
    if not isinstance(lst, str) or lst == "":
        raise JoseError("bad_claim", "lst must be a base64url string")
    decompressor = zlib.decompressobj()
    try:
        data = decompressor.decompress(b64url_decode(lst), MAX_DECODED_BYTES)
    except zlib.error as cause:
        raise JoseError("bad_claim", "lst is not ZLIB data") from cause
    if decompressor.unconsumed_tail or not decompressor.eof:
        raise JoseError("bad_claim", "lst is truncated or larger than the limit")
    return data


def read_status_list(
    token: str,
    *,
    uri: str,
    keys: Sequence[Mapping[str, Any]],
    algorithms: Sequence[str],
    now: float,
    issuer: Optional[str] = None,
) -> StatusListToken:
    """Verify a Status List Token for ``uri`` with ``keys`` (section 8.3)."""
    jws = parse(token)
    alg = check_header(jws.header, STATUS_LIST_TYP, algorithms)
    verify_with_keys(jws, alg, keys)
    claims = jws.payload
    # Section 8.3 step 4.1: sub equals the uri of the reference.
    if claims.get("sub") != uri:
        raise JoseError("sub_mismatch", "the status list's sub is not the referenced uri")
    if issuer is not None and claims.get("iss") != issuer:
        raise JoseError("iss_mismatch", "the status list's iss is not the expected issuer")
    iat: Any = claims.get("iat")
    exp: Any = claims.get("exp")
    ttl: Any = claims.get("ttl")
    if not _is_int(iat):
        raise JoseError("bad_claim", "iat must be an integer")
    if exp is not None and not _is_int(exp):
        raise JoseError("bad_claim", "exp must be an integer")
    if ttl is not None and (not _is_int(ttl) or ttl == 0):
        raise JoseError("bad_claim", "ttl must be a positive integer")
    if exp is None and ttl is None:
        raise JoseError("no_freshness", "the status list has neither exp nor ttl")
    if iat > now + CLOCK_TOLERANCE_SECONDS:
        raise JoseError("not_yet_valid", "the status list's iat is in the future")
    status_list = claims.get("status_list")
    if not isinstance(status_list, Mapping) or status_list.get("bits") not in (1, 2, 4, 8):
        raise JoseError("bad_claim", "status_list must have bits 1, 2, 4 or 8")
    read = StatusListToken(uri, iat, exp, ttl, int(status_list["bits"]), _decode_lst(status_list.get("lst")))
    if not read.usable_at(now):
        raise JoseError("expired", "the status list has expired")
    return read
