# SPDX-License-Identifier: Apache-2.0
"""RFC 9421 HTTP Message Signatures for agent requests.

The Agent-Passport, Agent-Grant and Agent-Trust headers and the
``agent-payer-auth`` signing profile of spec/verification.md. Not yet
published.
"""

from __future__ import annotations

from ._errors import AgentHttpSigError
from ._keys import (
    ECDSA_P256_SHA256,
    ED25519,
    jwk_thumbprint,
    private_jwk_from_key,
    public_jwk,
    verify_signature_value,
)
from ._message import (
    HttpMessage,
    HttpRequest,
    HttpResponse,
    create_signature_base,
    signature_base_for,
)
from ._profile import (
    AGENT_PAYER_AUTH_TAG,
    COVERED_COMPONENTS,
    DEFAULT_CLOCK_SKEW_SECONDS,
    DEFAULT_SIGNATURE_LABEL,
    DEFAULT_SIGNATURE_WINDOW_SECONDS,
    INLINE_PRESENTATION_MAX_OCTETS,
    MAX_CLOCK_SKEW_SECONDS,
    MAX_CONTENT_NESTING_DEPTH,
    MAX_SIGNATURE_WINDOW_SECONDS,
    SIGNATURE_PARAMETERS,
    InMemoryNonceStore,
    NonceStore,
    SignResult,
    VerifyResult,
    content_digest,
    sign,
    verify,
)
from .structured_fields import (
    Date,
    Dictionary,
    DisplayString,
    InnerList,
    Item,
    Token,
    parse_dictionary,
    parse_item,
    parse_list,
    serialize_dictionary,
    serialize_inner_list,
    serialize_item,
    serialize_list,
)

__version__ = "0.1.0"

__all__ = [
    "AGENT_PAYER_AUTH_TAG",
    "COVERED_COMPONENTS",
    "DEFAULT_CLOCK_SKEW_SECONDS",
    "DEFAULT_SIGNATURE_LABEL",
    "DEFAULT_SIGNATURE_WINDOW_SECONDS",
    "ECDSA_P256_SHA256",
    "ED25519",
    "INLINE_PRESENTATION_MAX_OCTETS",
    "MAX_CLOCK_SKEW_SECONDS",
    "MAX_CONTENT_NESTING_DEPTH",
    "MAX_SIGNATURE_WINDOW_SECONDS",
    "SIGNATURE_PARAMETERS",
    "AgentHttpSigError",
    "Date",
    "Dictionary",
    "DisplayString",
    "HttpMessage",
    "HttpRequest",
    "HttpResponse",
    "InMemoryNonceStore",
    "InnerList",
    "Item",
    "NonceStore",
    "SignResult",
    "Token",
    "VerifyResult",
    "content_digest",
    "create_signature_base",
    "jwk_thumbprint",
    "parse_dictionary",
    "parse_item",
    "parse_list",
    "private_jwk_from_key",
    "public_jwk",
    "serialize_dictionary",
    "serialize_inner_list",
    "serialize_item",
    "serialize_list",
    "sign",
    "signature_base_for",
    "verify",
    "verify_signature_value",
]
