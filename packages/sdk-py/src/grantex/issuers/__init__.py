"""Accredited issuer adapters.

The registry asks an accredited issuer to attest an agent through one
interface, :class:`AccreditedIssuerClient`. The mock issuer's implementation is
here (``GRANTEX_ISSUER_ADAPTER=mock``); a real issuer's lives in its own
package and is found through the ``grantex.issuers`` entry point group. See
``docs/issuers/implementing-an-issuer-adapter.md``.
"""

from ._errors import (
    ADAPTER_AMBIGUOUS,
    ADAPTER_INVALID,
    ADAPTER_NOT_CONFIGURED,
    ADAPTER_NOT_INSTALLED,
    ISSUER_RESPONSE_INVALID,
    ISSUER_UNREACHABLE,
    KEY_BINDING_MISMATCH,
    IssuerAdapterError,
)
from ._loader import ADAPTER_ENV, ENTRY_POINT_GROUP, MOCK_ADAPTER_NAME, installed_adapters, load_issuer_client
from ._mock import MockIssuerClient, create_mock_issuer_client
from ._protocol import AccreditedIssuerClient
from ._types import (
    AgentRecord,
    CredentialRef,
    IssuedAttestation,
    IssuerAdapterConfig,
    IssuerMetadata,
    IssuerStatus,
    IssuerStatusState,
    ProvedKey,
)

__all__ = [
    "ADAPTER_AMBIGUOUS",
    "ADAPTER_ENV",
    "ADAPTER_INVALID",
    "ADAPTER_NOT_CONFIGURED",
    "ADAPTER_NOT_INSTALLED",
    "ENTRY_POINT_GROUP",
    "ISSUER_RESPONSE_INVALID",
    "ISSUER_UNREACHABLE",
    "KEY_BINDING_MISMATCH",
    "MOCK_ADAPTER_NAME",
    "AccreditedIssuerClient",
    "AgentRecord",
    "CredentialRef",
    "IssuedAttestation",
    "IssuerAdapterConfig",
    "IssuerAdapterError",
    "IssuerMetadata",
    "IssuerStatus",
    "IssuerStatusState",
    "MockIssuerClient",
    "ProvedKey",
    "create_mock_issuer_client",
    "installed_adapters",
    "load_issuer_client",
]
