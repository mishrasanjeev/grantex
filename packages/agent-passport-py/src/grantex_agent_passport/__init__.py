# SPDX-License-Identifier: Apache-2.0
"""grantex-agent-passport: the Agent Passport SD-JWT VC profile.

See spec/agent-passport-1.0.md. The TypeScript package @grantex/agent-passport
implements the same rules and passes the same vectors.
"""

from ._errors import PASSPORT_ERROR_CODES, PassportError
from ._jwk import jwk_thumbprint, keys_equal
from ._key_binding import (
    DEFAULT_KB_MAX_AGE_SECONDS,
    KB_JWT_TYP,
    KeyBindingRequirement,
    create_key_binding_jwt,
)
from ._passport import (
    DISCLOSABLE_CLAIMS,
    MAX_PASSPORT_LIFETIME_SECONDS,
    PASSPORT_TYP,
    PASSPORT_VCT,
    IssuedDisclosure,
    IssuedPassport,
    IssuerKeyResolver,
    VerifiedDisclosure,
    VerifiedPassport,
    issue_passport,
    verify_passport,
)
from ._sd_jwt import (
    SD_ALG,
    disclosure_digest,
    encode_disclosure,
    external_credential_hash,
    select_disclosures,
)

__version__ = "0.1.0"

__all__ = [
    "DEFAULT_KB_MAX_AGE_SECONDS",
    "DISCLOSABLE_CLAIMS",
    "KB_JWT_TYP",
    "MAX_PASSPORT_LIFETIME_SECONDS",
    "PASSPORT_ERROR_CODES",
    "PASSPORT_TYP",
    "PASSPORT_VCT",
    "SD_ALG",
    "IssuedDisclosure",
    "IssuedPassport",
    "IssuerKeyResolver",
    "KeyBindingRequirement",
    "PassportError",
    "VerifiedDisclosure",
    "VerifiedPassport",
    "create_key_binding_jwt",
    "disclosure_digest",
    "encode_disclosure",
    "external_credential_hash",
    "issue_passport",
    "jwk_thumbprint",
    "keys_equal",
    "select_disclosures",
    "verify_passport",
]
