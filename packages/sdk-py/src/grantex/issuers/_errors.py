from __future__ import annotations

from .._errors import GrantexError

#: Codes an adapter or the loader raises. Issuer refusals keep the issuer's own
#: code (``key_unproven``, ``passport_revoked``, ...) so callers see one vocabulary.
ADAPTER_NOT_CONFIGURED = "adapter_not_configured"
ADAPTER_NOT_INSTALLED = "adapter_not_installed"
ADAPTER_AMBIGUOUS = "adapter_ambiguous"
ADAPTER_INVALID = "adapter_invalid"
ISSUER_UNREACHABLE = "issuer_unreachable"
ISSUER_RESPONSE_INVALID = "issuer_response_invalid"
KEY_BINDING_MISMATCH = "key_binding_mismatch"


class IssuerAdapterError(GrantexError):
    """An accredited issuer adapter could not be loaded, or the issuer refused.

    ``code`` is one of the constants above or the issuer's own refusal code.
    The message never contains a credential.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.detail = message
