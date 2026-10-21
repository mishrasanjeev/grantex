# SPDX-License-Identifier: Apache-2.0
"""SD-JWT framing, disclosures and digests (RFC 9901), and the hash rule."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from ._b64 import b64url_encode, b64url_json, json_compact
from ._errors import malformed

#: The only digest algorithm the profile uses (RFC 9901 section 4.1.1).
SD_ALG = "sha-256"

_JWS_SEGMENTS = re.compile(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")


@dataclass(frozen=True)
class SplitSdJwt:
    issuer_jwt: str
    disclosures: List[str]
    #: The Key Binding JWT, or "" when there is none.
    kb_jwt: str


def split_sd_jwt(compact: str) -> SplitSdJwt:
    """RFC 9901 section 4: <Issuer-signed JWT>~<Disclosure>~...~<optional KB-JWT>.

    Without a KB-JWT the last element is empty and the trailing tilde is not omitted.
    """
    if not isinstance(compact, str):
        raise malformed("not_sd_jwt", "an SD-JWT is a string")
    parts = compact.split("~")
    if len(parts) < 2:
        raise malformed("not_sd_jwt", "an SD-JWT has at least one tilde")
    disclosures = parts[1:-1]
    if parts[0] == "" or any(d == "" for d in disclosures):
        raise malformed("not_sd_jwt", "an SD-JWT has no empty elements before the last tilde")
    return SplitSdJwt(parts[0], disclosures, parts[-1])


def sha256_b64url(ascii_text: str) -> str:
    """base64url(sha-256(US-ASCII bytes)): RFC 9901 section 4.2.3 (digests) and 4.3.1 (sd_hash)."""
    return b64url_encode(hashlib.sha256(ascii_text.encode("ascii")).digest())


def disclosure_digest(encoded: str) -> str:
    """The digest of an encoded disclosure, over its US-ASCII bytes (RFC 9901 section 4.2.3)."""
    return sha256_b64url(encoded)


def encode_disclosure(salt: str, name: Optional[str], value: Any) -> str:
    """Encode a disclosure.

    base64url of the UTF-8 JSON array [salt, name, value] for an object property
    (RFC 9901 section 4.2.1), or [salt, value] for an array element (section
    4.2.2) when name is None.
    """
    array = [salt, value] if name is None else [salt, name, value]
    return b64url_encode(json_compact(array).encode("utf-8"))


def external_credential_hash(compact: str) -> str:
    """The hash rule.

    'sha-256:' + base64url(sha-256(the ASCII bytes of the issuer-signed JWT)),
    the part before the first '~'. Disclosures and the KB-JWT are never hashed,
    so every presentation of one passport has the same hash whatever the holder
    disclosed.
    """
    end = compact.find("~") if isinstance(compact, str) else -1
    if end < 0:
        raise malformed(
            "not_sd_jwt", "the hash rule takes an SD-JWT (issuer-signed JWT followed by ~)"
        )
    issuer_jwt = compact[:end]
    if not _JWS_SEGMENTS.fullmatch(issuer_jwt):
        raise malformed("not_sd_jwt", "the issuer-signed JWT is not a compact JWS")
    return f"{SD_ALG}:{sha256_b64url(issuer_jwt)}"


@dataclass(frozen=True)
class DecodedDisclosure:
    encoded: str
    digest: str
    salt: str
    #: None for an array element disclosure.
    name: Optional[str]
    value: Any


def decode_disclosure(encoded: str) -> DecodedDisclosure:
    decoded = b64url_json(encoded)
    array = decoded[0] if decoded is not None else None
    if (
        not isinstance(array, list)
        or len(array) not in (2, 3)
        or not isinstance(array[0], str)
    ):
        raise malformed(
            "disclosure_malformed",
            "a disclosure is base64url JSON [salt, name, value] or [salt, value]",
        )
    digest = disclosure_digest(encoded)
    if len(array) == 2:
        return DecodedDisclosure(encoded, digest, array[0], None, array[1])
    if not isinstance(array[1], str):
        raise malformed("disclosure_malformed", "a disclosure claim name is a string")
    return DecodedDisclosure(encoded, digest, array[0], array[1], array[2])


class _Processor:
    """RFC 9901 section 7.1 steps 3 to 5 over one payload and its disclosures."""

    def __init__(self, disclosures: Sequence[DecodedDisclosure], reserved: Set[str]) -> None:
        self.by_digest = {d.digest: d for d in disclosures}
        self.reserved = reserved
        self.seen: Set[str] = set()
        self.used: Set[str] = set()

    def take_digest(self, digest: Any) -> Optional[DecodedDisclosure]:
        if not isinstance(digest, str):
            raise malformed("bad_claim", "a digest is a string")
        # Step 4: a digest may appear only once, directly or through other disclosures.
        if digest in self.seen:
            raise malformed("duplicate_digest", "a digest appears more than once")
        self.seen.add(digest)
        disclosure = self.by_digest.get(digest)
        if disclosure is not None:
            self.used.add(digest)
        return disclosure

    def value(self, value: Any) -> Any:
        if isinstance(value, list):
            return self.array(value)
        if isinstance(value, dict):
            return self.object(value, top_level=False)
        return value

    def array(self, array: List[Any]) -> List[Any]:
        out: List[Any] = []
        for element in array:
            if isinstance(element, dict) and len(element) == 1 and "..." in element:
                # Step 3.4: an array element digest, removed when not disclosed.
                disclosure = self.take_digest(element["..."])
                if disclosure is None:
                    continue
                if disclosure.name is not None:
                    raise malformed(
                        "disclosure_malformed",
                        "an array element digest refers to an object property disclosure",
                    )
                out.append(self.value(disclosure.value))
            else:
                out.append(self.value(element))
        return out

    def object(self, obj: Dict[str, Any], top_level: bool) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for name, value in obj.items():
            if name == "_sd" or (top_level and name == "_sd_alg"):
                continue
            out[name] = self.value(value)
        if "_sd" not in obj:
            return out
        sd = obj["_sd"]
        if not isinstance(sd, list):
            raise malformed("bad_claim", "_sd is an array of digests")
        for digest in sd:
            disclosure = self.take_digest(digest)
            if disclosure is None:
                continue  # a decoy digest, or a claim the holder withheld
            claim_name = disclosure.name
            if claim_name is None:
                raise malformed(
                    "disclosure_malformed", "an _sd digest refers to an array element disclosure"
                )
            # Step 3.3.2.2.2 (_sd and ...) and SD-JWT VC section 2.2.2.3 (claims that must not be disclosed).
            if claim_name in ("_sd", "...") or (top_level and claim_name in self.reserved):
                raise malformed(
                    "disclosure_name_not_allowed", f"claim {claim_name} cannot be selectively disclosed"
                )
            # Step 3.3.2.2.3: the claim name must not already exist at this level.
            if claim_name in obj or claim_name in out:
                raise malformed(
                    "claim_name_conflict", f"claim {claim_name} is both in the clear and disclosed"
                )
            out[claim_name] = self.value(disclosure.value)
        return out


def process_disclosures(
    payload: Dict[str, Any], encoded_disclosures: Sequence[str], reserved: Set[str]
) -> Tuple[Dict[str, Any], List[DecodedDisclosure]]:
    """Rebuild the claims from the payload and the disclosures (RFC 9901 section 7.1).

    Each digest in _sd (or in a {"...": digest} array element) is replaced by
    its disclosure, recursively; digests without a disclosure are dropped; a
    digest seen twice, a disclosure presented twice or never referenced, and a
    claim name that is reserved or already present are refused.
    """
    seen_encoded: Set[str] = set()
    for encoded in encoded_disclosures:
        if encoded in seen_encoded:
            raise malformed("duplicate_disclosure", "a disclosure appears more than once")
        seen_encoded.add(encoded)
    decoded = [decode_disclosure(e) for e in encoded_disclosures]
    processor = _Processor(decoded, reserved)
    claims = processor.object(payload, top_level=True)
    # Step 5: every disclosure must have been referenced.
    for d in decoded:
        if d.digest not in processor.used:
            raise malformed(
                "disclosure_not_referenced", "a disclosure is not referenced by any digest"
            )
    return claims, decoded


def select_disclosures(compact: str, claim_names: Iterable[str]) -> str:
    """Keep only the top-level disclosures of the named claims, to build a presentation."""
    split = split_sd_jwt(compact)
    if split.kb_jwt != "":
        raise malformed(
            "unexpected_key_binding", "select disclosures before adding a Key Binding JWT"
        )
    wanted = set(claim_names)
    kept = []
    for encoded in split.disclosures:
        d = decode_disclosure(encoded)
        if d.name is not None and d.name in wanted:
            kept.append(encoded)
    return split.issuer_jwt + "~" + "".join(d + "~" for d in kept)
