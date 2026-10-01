"""Records exchanged with an accredited issuer adapter.

These are the inputs the registry hands to an adapter and the outputs it takes
back. They carry only what an issuer needs: the agent's identifiers and its
proved public key, never a private key or an API credential.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal, Mapping, Optional, Tuple

#: One status value per credential, in the issuer's own words reduced to three
#: states. ``revoked`` is final; ``suspended`` may be reinstated.
IssuerStatusState = Literal["valid", "suspended", "revoked"]


@dataclass(frozen=True)
class AgentRecord:
    """The agent as the registry knows it when attestation is requested."""

    agent_id: str
    did: str
    developer_id: Optional[str] = None
    provider_did: Optional[str] = None
    software_name: Optional[str] = None
    software_version: Optional[str] = None


@dataclass(frozen=True)
class ProvedKey:
    """A public key the agent has proved possession of to the registry.

    ``thumbprint`` is the RFC 7638 thumbprint the registry stored (``agent_keys``),
    ``public_jwk`` the key's public members only. The issuer runs its own
    possession proof against this key; the adapter never sees a private key.
    """

    thumbprint: str
    public_jwk: Mapping[str, str]
    possession_proved_at: Optional[datetime] = None


@dataclass(frozen=True)
class CredentialRef:
    """What identifies an issuer's credential in a registry lookup.

    All three are required by ``GET /v1/registry/lookup``; ``external_credential_hash``
    is ``sha-256:`` + base64url(SHA-256) of the issuer-signed credential.
    """

    issuer: str
    external_credential_id: str
    external_credential_hash: str


@dataclass(frozen=True)
class IssuedAttestation:
    """What an issuer returns: the attestation JWS and how to refer to it later."""

    #: The compact JWS, ``typ`` ``grantex-attestation+jwt``, as the issuer signed it.
    jws: str
    #: The trust mark attested, ``urn:grantex:tm:agent.identity`` or ``provider.entity``.
    attestation_type: str
    credential_ref: CredentialRef
    key_thumbprint: str
    expires_at: Optional[datetime] = None
    #: The issuer's own credential (an Agent Passport, SD-JWT VC) when it issued one.
    passport: Optional[str] = None


@dataclass(frozen=True)
class IssuerStatus:
    state: IssuerStatusState
    checked_at: datetime
    #: Where the answer came from, for the audit trail (``status_list``, ``api``, ``cli``).
    source: str


@dataclass(frozen=True)
class IssuerMetadata:
    """What the registry records about an issuer at accreditation (PRD 7.1)."""

    issuer_id: str
    scopes: Tuple[str, ...]
    jwks: Optional[Mapping[str, object]] = None
    entity_configuration_url: Optional[str] = None
    status_list_base: Optional[str] = None


@dataclass(frozen=True)
class IssuerAdapterConfig:
    """Adapter settings, read from the environment by :meth:`from_environ`.

    The public repository never holds an issuer's URL or credential; they come
    from these variables at run time. A secret is passed through untouched and
    is never logged or repeated in an error.
    """

    adapter: Optional[str] = None
    base_url: Optional[str] = None
    client_id: Optional[str] = None
    client_secret: Optional[str] = None
    token: Optional[str] = None
    scopes: Tuple[str, ...] = field(default_factory=tuple)

    @classmethod
    def from_environ(cls, environ: Optional[Mapping[str, str]] = None) -> IssuerAdapterConfig:
        env = os.environ if environ is None else environ

        def read(name: str) -> Optional[str]:
            value = env.get(name)
            return value if value else None

        scopes = tuple(s for s in (read("GRANTEX_ISSUER_SCOPES") or "").replace(",", " ").split() if s)
        return cls(
            adapter=read("GRANTEX_ISSUER_ADAPTER"),
            base_url=read("GRANTEX_ISSUER_BASE_URL"),
            client_id=read("GRANTEX_ISSUER_CLIENT_ID"),
            client_secret=read("GRANTEX_ISSUER_CLIENT_SECRET"),
            token=read("GRANTEX_ISSUER_TOKEN"),
            scopes=scopes,
        )
