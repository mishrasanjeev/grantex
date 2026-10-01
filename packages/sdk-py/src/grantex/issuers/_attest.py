"""The attestation step of agent registration.

The registry side of the seam: take the agent's proved key, hand it to the
accredited issuer adapter, post the attestation it returns to the registry's
ingest route, and read the agent's computed level back. Against the mock
issuer this is one call, or one command (``grantex-attest``).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple
from urllib.parse import quote

import httpx

from .._client import Grantex
from .._errors import GrantexApiError
from .._types import Agent
from ..resources._agent_keys import AgentKey
from ._errors import IssuerAdapterError
from ._loader import load_issuer_client
from ._protocol import AccreditedIssuerClient
from ._types import AgentRecord, IssuedAttestation, ProvedKey

ATTESTATION_MEDIA_TYPE = "application/grantex-attestation+jwt"
ATTESTATIONS_PATH = "/v1/registry/attestations"
REGISTRY_REFUSED = "registry_refused"
REGISTRY_UNREACHABLE = "registry_unreachable"
DEFAULT_REGISTRY_TIMEOUT_SECONDS = 10.0


@dataclass(frozen=True)
class AttestationOutcome:
    agent: Agent
    key: AgentKey
    issued: IssuedAttestation
    #: The registry's record of the attestation (``POST /v1/registry/attestations``).
    registry: Dict[str, Any]
    #: ``True`` when the registry created the record now, ``False`` for a repeat of the same bytes.
    created: bool
    #: The registry's records of the companion attestations, in the issuer's order.
    companion_records: Tuple[Dict[str, Any], ...]
    #: The agent's computed level and flags after ingestion, from the lookup.
    level: Optional[str]
    flags: Tuple[str, ...]


def _parse_time(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def post_attestation(
    base_url: str, jws: str, *, timeout: float = DEFAULT_REGISTRY_TIMEOUT_SECONDS, transport: Optional[httpx.BaseTransport] = None
) -> Tuple[Dict[str, Any], bool]:
    """Post a compact JWS to the registry's ingest route; ``(record, created)``.

    No API key: the issuer's signature is the authentication. A refusal keeps
    the registry's code (``key_unproven``, ``issuer_not_accredited``, ...).
    """
    url = f"{base_url.rstrip('/')}{ATTESTATIONS_PATH}"
    headers = {"Content-Type": ATTESTATION_MEDIA_TYPE, "Accept": "application/json"}
    try:
        with httpx.Client(timeout=timeout, transport=transport) as http:
            response = http.post(url, content=jws.encode("ascii"), headers=headers)
    except httpx.HTTPError as exc:
        raise IssuerAdapterError(REGISTRY_UNREACHABLE, f"the registry did not answer: {exc}") from exc
    try:
        body = response.json()
    except ValueError:
        body = None
    if response.status_code in (200, 201):
        if not isinstance(body, dict):
            raise IssuerAdapterError(REGISTRY_REFUSED, f"the registry answered {response.status_code} without a record")
        return body, response.status_code == 201
    code = body.get("code") if isinstance(body, dict) else None
    message = body.get("message") if isinstance(body, dict) else None
    raise IssuerAdapterError(
        str(code) if isinstance(code, str) and code else REGISTRY_REFUSED,
        f"the registry refused the attestation ({response.status_code}): {message or response.text[:200]}",
    )


def attest_agent(
    client: Grantex,
    agent_id: str,
    thumbprint: str,
    *,
    issuer: Optional[AccreditedIssuerClient] = None,
    timeout: float = DEFAULT_REGISTRY_TIMEOUT_SECONDS,
    transport: Optional[httpx.BaseTransport] = None,
) -> AttestationOutcome:
    """Request an attestation for ``agent_id`` bound to its proved key ``thumbprint``.

    1. Reads the agent and the key from its history; the key must be
       ``active`` (possession proven), or the request stops with
       ``key_unproven`` before the issuer is asked.
    2. Hands the agent's identifiers and the public key to the adapter
       (``issuer``, or the one ``GRANTEX_ISSUER_ADAPTER`` names).
    3. Posts the attestation JWS to the registry and reads the agent's level.
    """
    agent = client.agents.get(agent_id)
    keys = client.agents.keys.list(agent_id)
    key = next((k for k in keys if k.thumbprint == thumbprint), None)
    if key is None:
        raise IssuerAdapterError("key_unproven", f"agent {agent_id} has no key {thumbprint} in its history")
    if key.status != "active" or not key.possession_proved_at:
        raise IssuerAdapterError(
            "key_unproven", f"key {thumbprint} is {key.status}; prove possession before requesting attestation"
        )
    adapter = issuer if issuer is not None else load_issuer_client()
    record = AgentRecord(
        agent_id=agent.id,
        did=agent.did,
        developer_id=agent.developer_id,
        software_name=agent.name or None,
    )
    proved = ProvedKey(
        thumbprint=key.thumbprint,
        public_jwk={k: str(v) for k, v in key.jwk.items() if isinstance(v, str)},
        possession_proved_at=_parse_time(key.possession_proved_at),
    )
    issued = adapter.request_attestation(record, proved)
    if issued.key_thumbprint != thumbprint:
        raise IssuerAdapterError(
            "key_binding_mismatch", f"the issuer attested key {issued.key_thumbprint}, not {thumbprint}"
        )
    registry, created = post_attestation(client.base_url, issued.jws, timeout=timeout, transport=transport)
    companion_records = tuple(
        post_attestation(client.base_url, companion.jws, timeout=timeout, transport=transport)[0]
        for companion in issued.companions
    )
    level, flags = _lookup_level(client, agent.did)
    return AttestationOutcome(
        agent=agent, key=key, issued=issued, registry=registry, created=created,
        companion_records=companion_records, level=level, flags=flags,
    )


def _lookup_level(client: Grantex, did: str) -> Tuple[Optional[str], Tuple[str, ...]]:
    """The computed level from the registry lookup, as the developer (an authenticated relying party)."""
    try:
        found = client._http.get(f"/v1/registry/agents/{quote(did, safe='')}")
    except GrantexApiError as exc:
        if exc.status_code == 404:
            return None, ()
        raise
    level = found.get("level") if isinstance(found, dict) else None
    flags = found.get("flags") if isinstance(found, dict) else None
    return (level if isinstance(level, str) else None), tuple(str(f) for f in (flags or []))
