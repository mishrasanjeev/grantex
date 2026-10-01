from __future__ import annotations

from typing import Protocol, runtime_checkable

from ._types import AgentRecord, CredentialRef, IssuedAttestation, IssuerMetadata, IssuerStatus, ProvedKey


@runtime_checkable
class AccreditedIssuerClient(Protocol):
    """The seam between the registry and an accredited issuer.

    Exactly three operations. The mock issuer implements them in this
    repository; a real issuer's implementation lives in its own package, found
    through the ``grantex.issuers`` entry point group (see
    ``docs/issuers/implementing-an-issuer-adapter.md``). Every failure is an
    :class:`IssuerAdapterError` with a code; nothing is swallowed.
    """

    def issuer_metadata(self) -> IssuerMetadata:
        """The issuer's id, keys (or Entity Configuration URL) and trust-mark scopes."""

    def request_attestation(self, agent_record: AgentRecord, proved_key: ProvedKey) -> IssuedAttestation:
        """Ask the issuer to attest ``agent_record`` bound to ``proved_key``.

        Returns the compact JWS the registry ingests. The issuer verifies the
        agent's possession of the key its own way; refusals surface with the
        issuer's code (``key_unproven`` and so on).
        """

    def fetch_status(self, credential_ref: CredentialRef) -> IssuerStatus:
        """The issuer's current status of a credential it issued."""
