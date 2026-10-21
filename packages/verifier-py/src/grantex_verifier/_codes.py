# SPDX-License-Identifier: Apache-2.0
"""Denial codes and the order in which checks decide the denial.

PRD Appendix C codes are used wherever one applies. Three checks refuse for
reasons Appendix C has no code for (a grant that does not verify, a revoked
grant, a transaction outside the grant's constraints); they reuse the codes
the grantex SDKs already give ``enforce()`` denials (``token_invalid``,
``grant_revoked``, ``cap_exceeded``; see ``grantex.denials``), so a relying
party sees one vocabulary. The Agent Passport profile's own
``passport_malformed`` and ``passport_not_accepted`` are passed through as
spec/passport-binding.md does.
"""

from __future__ import annotations

from typing import Tuple

# PRD Appendix C.
PASSPORT_INVALID_SIGNATURE = "passport_invalid_signature"
PASSPORT_REVOKED = "passport_revoked"
PASSPORT_EXPIRED = "passport_expired"
ATTESTATION_NOT_ACCEPTED = "attestation_not_accepted"
ISSUER_NOT_ACCREDITED = "issuer_not_accredited"
ISSUER_SUSPENDED = "issuer_suspended"
TRUST_MARK_MISSING = "trust_mark_missing"
ATTESTATION_NOT_REGISTERED = "attestation_not_registered"
ATTESTATION_HASH_MISMATCH = "attestation_hash_mismatch"
KEY_BINDING_MISMATCH = "key_binding_mismatch"
KEY_NOT_ACTIVE = "key_not_active"
KEY_UNPROVEN = "key_unproven"
ATTESTATION_MISMATCH = "attestation_mismatch"
LEVEL_BELOW_POLICY = "level_below_policy"
AUDIENCE_MISMATCH = "audience_mismatch"
REQUEST_SIGNATURE_INVALID = "request_signature_invalid"
REQUEST_SIGNATURE_STALE = "request_signature_stale"
STATUS_STALE = "status_stale"

# The grantex SDKs' enforce() taxonomy, for what Appendix C does not cover.
TOKEN_INVALID = "token_invalid"
GRANT_REVOKED = "grant_revoked"
CAP_EXCEEDED = "cap_exceeded"

APPENDIX_C_CODES: Tuple[str, ...] = (
    PASSPORT_INVALID_SIGNATURE,
    PASSPORT_REVOKED,
    PASSPORT_EXPIRED,
    ATTESTATION_NOT_ACCEPTED,
    ISSUER_NOT_ACCREDITED,
    ISSUER_SUSPENDED,
    TRUST_MARK_MISSING,
    ATTESTATION_NOT_REGISTERED,
    ATTESTATION_HASH_MISMATCH,
    KEY_BINDING_MISMATCH,
    KEY_NOT_ACTIVE,
    KEY_UNPROVEN,
    ATTESTATION_MISMATCH,
    LEVEL_BELOW_POLICY,
    AUDIENCE_MISMATCH,
    REQUEST_SIGNATURE_INVALID,
    REQUEST_SIGNATURE_STALE,
    STATUS_STALE,
)

#: Every check verify() reports, in the order that decides the denial code:
#: the first that fails sets it. Accreditation comes before the passport's
#: signature, as at grant issuance (spec/passport-binding.md section 4), so
#: an unknown or suspended issuer is refused as such.
CHECK_ORDER: Tuple[str, ...] = (
    "issuer.accredited",
    "passport.signature",
    "passport.status",
    "attestation.registered",
    "attestation.accepted",
    "grant.signature",
    "grant.status",
    "grant.audience",
    "key.binding",
    "key.status",
    "request.signature",
    "level",
    "constraints",
    "budget.remaining",
)


class Refusal(Exception):
    """One check failed: its denial code and why. Internal to the verifier."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail
