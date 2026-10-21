# SPDX-License-Identifier: Apache-2.0
"""PassportError: every refusal carries a code and a reason.

The codes that have a counterpart in the registry denial codes
(passport_invalid_signature, passport_expired, key_binding_mismatch,
key_unproven, audience_mismatch) use it; passport_revoked and status_stale
are the status refusals of spec/agent-passport-1.0.md section 4;
passport_malformed and
passport_not_accepted cover a credential that is not a well-formed Agent
Passport and one this relying party's options refuse. The reason says which
rule failed; spec/agent-passport-1.0.md lists them.
"""

from __future__ import annotations

PASSPORT_ERROR_CODES = frozenset(
    {
        "passport_malformed",
        "passport_not_accepted",
        "passport_invalid_signature",
        "passport_expired",
        "key_unproven",
        "key_binding_mismatch",
        "audience_mismatch",
        "passport_revoked",
        "status_stale",
    }
)


class PassportError(Exception):
    """An Agent Passport, presentation or key was refused."""

    def __init__(self, code: str, reason: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.reason = reason


def malformed(reason: str, message: str) -> PassportError:
    return PassportError("passport_malformed", reason, message)
