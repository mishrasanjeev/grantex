"""The mock accredited issuer as an adapter.

It drives the repository's mock issuer (``packages/mock-issuer``, the CLI
``grantex-mock-issuer``) in a subprocess: ``keys`` for metadata,
``issue-passport`` then ``attest`` for an attestation, ``status`` for status.
No network is used. The CLI runs both sides of the possession proof, so it
needs the agent's private key file: the one ``issue-passport
--generate-agent-key`` writes under ``<state dir>/agents/<thumbprint>.json``,
or a path given per thumbprint. A real issuer runs its own possession flow
with the agent and never receives a private key.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence

from ._errors import (
    ADAPTER_INVALID,
    ADAPTER_NOT_INSTALLED,
    ISSUER_RESPONSE_INVALID,
    ISSUER_UNREACHABLE,
    KEY_BINDING_MISMATCH,
    IssuerAdapterError,
)
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

CLI_ENV = "GRANTEX_MOCK_ISSUER_CLI"
STATE_DIR_ENV = "GRANTEX_MOCK_ISSUER_DIR"
AGENT_KEYS_ENV = "GRANTEX_MOCK_ISSUER_AGENT_KEYS"
TYPES_ENV = "GRANTEX_MOCK_ISSUER_TYPES"
ATTESTATION_TYP = "grantex-attestation+jwt"
TRUST_MARK_AGENT_IDENTITY = "urn:grantex:tm:agent.identity"
TRUST_MARK_PROVIDER_ENTITY = "urn:grantex:tm:provider.entity"
MOCK_SCOPES = (TRUST_MARK_AGENT_IDENTITY, TRUST_MARK_PROVIDER_ENTITY)
DEFAULT_TIMEOUT_SECONDS = 30.0
_CLI_PREFIX = "grantex-mock-issuer: "


def _b64url_json(segment: str) -> Dict[str, Any]:
    padded = segment + "=" * (-len(segment) % 4)
    decoded = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))
    if not isinstance(decoded, dict):
        raise ValueError("not a JSON object")
    return decoded


def _repository_cli() -> Optional[List[str]]:
    """``node packages/mock-issuer/src/cli.ts`` when this SDK runs from the repository."""
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "packages" / "mock-issuer" / "src" / "cli.ts"
        if candidate.is_file():
            return ["node", str(candidate)]
    return None


class MockIssuerClient:
    """``AccreditedIssuerClient`` over the mock issuer CLI."""

    def __init__(
        self,
        *,
        cli: Sequence[str],
        state_dir: str,
        agent_key_files: Optional[Mapping[str, str]] = None,
        attestation_types: Sequence[str] = MOCK_SCOPES,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        if not cli:
            raise IssuerAdapterError(ADAPTER_INVALID, "the mock issuer command is empty")
        types = tuple(dict.fromkeys(attestation_types))
        if not types or any(t not in MOCK_SCOPES for t in types):
            raise IssuerAdapterError(
                ADAPTER_INVALID, f"the mock issuer attests {', '.join(MOCK_SCOPES)}, not {list(attestation_types)}"
            )
        self._cli = list(cli)
        self._state_dir = os.path.abspath(state_dir)
        self._agent_key_files = dict(agent_key_files or {})
        self._attestation_types = types
        self._timeout = timeout_seconds
        self._metadata: Optional[IssuerMetadata] = None

    @classmethod
    def from_config(cls, config: IssuerAdapterConfig, environ: Optional[Mapping[str, str]] = None) -> MockIssuerClient:
        """The entry-point factory: command, state directory and agent keys from the environment."""
        env = os.environ if environ is None else environ
        command = env.get(CLI_ENV)
        cli = command.split() if command else _repository_cli()
        if not cli:
            raise IssuerAdapterError(
                ADAPTER_NOT_INSTALLED,
                f"the mock issuer CLI was not found; set {CLI_ENV} to the command that runs "
                "packages/mock-issuer/src/cli.ts",
            )
        state_dir = env.get(STATE_DIR_ENV) or env.get("MOCK_ISSUER_DIR")
        if not state_dir:
            raise IssuerAdapterError(ADAPTER_INVALID, f"set {STATE_DIR_ENV} to the mock issuer's state directory")
        key_files: Dict[str, str] = {}
        for item in (env.get(AGENT_KEYS_ENV) or "").split(","):
            item = item.strip()
            if not item:
                continue
            thumbprint, sep, path = item.partition("=")
            if not sep or not thumbprint or not path:
                raise IssuerAdapterError(ADAPTER_INVALID, f"{AGENT_KEYS_ENV} entries are thumbprint=path")
            key_files[thumbprint] = path
        types = [t.strip() for t in (env.get(TYPES_ENV) or "").split(",") if t.strip()] or list(MOCK_SCOPES)
        # The mock's base URL and credentials are not used: it has no network side.
        return cls(cli=cli, state_dir=state_dir, agent_key_files=key_files, attestation_types=types)

    # ─── the three operations ───────────────────────────────────────────────

    def issuer_metadata(self) -> IssuerMetadata:
        if self._metadata is None:
            keys = self._run_json(["keys"])
            entity_id = keys.get("entity_id")
            jwks = keys.get("jwks")
            if not isinstance(entity_id, str) or not isinstance(jwks, dict):
                raise IssuerAdapterError(ISSUER_RESPONSE_INVALID, "keys did not return entity_id and jwks")
            base = keys.get("status_list_base")
            self._metadata = IssuerMetadata(
                issuer_id=entity_id,
                scopes=MOCK_SCOPES,
                jwks=jwks,
                status_list_base=base if isinstance(base, str) else None,
            )
        return self._metadata

    def register_agent_key_file(self, thumbprint: str, path: str) -> None:
        """Tell the mock where the agent's private key is, so it can run the possession proof."""
        self._agent_key_files[thumbprint] = path

    def request_attestation(self, agent_record: AgentRecord, proved_key: ProvedKey) -> IssuedAttestation:
        if TRUST_MARK_PROVIDER_ENTITY in self._attestation_types and not agent_record.provider_did:
            raise IssuerAdapterError(
                ADAPTER_INVALID,
                "a provider.entity attestation needs the agent's provider DID (AgentRecord.provider_did); "
                f"give it, or leave provider.entity out of {TYPES_ENV}",
            )
        key_file = self._agent_key_file(proved_key.thumbprint)
        args = [
            "issue-passport",
            "--agent-key", key_file,
            "--agent-did", agent_record.did,
        ]
        if agent_record.provider_did:
            args += ["--provider-did", agent_record.provider_did]
        if agent_record.software_name:
            args += ["--software-name", agent_record.software_name]
        if agent_record.software_version:
            args += ["--software-version", agent_record.software_version]
        issued = self._run_json(args)
        attestation_id = issued.get("attestation_id")
        passport_id = issued.get("passport_id")
        key_thumbprint = issued.get("key_thumbprint")
        credential_hash = issued.get("external_credential_hash")
        passport = issued.get("passport")
        if not (
            isinstance(attestation_id, str) and isinstance(passport_id, str)
            and isinstance(key_thumbprint, str) and isinstance(credential_hash, str)
        ):
            raise IssuerAdapterError(ISSUER_RESPONSE_INVALID, "issue-passport did not return the passport record")
        # The issuer bound the key the registry proved, or the attestation is for another agent.
        if key_thumbprint != proved_key.thumbprint:
            raise IssuerAdapterError(
                KEY_BINDING_MISMATCH,
                f"the issuer bound key {key_thumbprint} but the registry proved {proved_key.thumbprint}",
            )
        exp = issued.get("exp")
        # The attestation names the passport (external_credential_id, its hash)
        # and carries the issuer's own id of the attestation as `id`; the
        # mock's status operations take the latter.
        credential_ref = CredentialRef(
            issuer=self.issuer_metadata().issuer_id,
            external_credential_id=passport_id,
            external_credential_hash=credential_hash,
            issuer_attestation_id=attestation_id,
        )
        # One passport, one attestation per trust mark: the first is the main
        # one, the rest come along with it.
        attestations: List[IssuedAttestation] = []
        for attestation_type in self._attestation_types:
            jws = self._run_text(["attest", "--attestation-id", attestation_id, "--type", attestation_type]).strip()
            self._check_attestation(jws, attestation_type, key_thumbprint=key_thumbprint, passport_id=passport_id)
            attestations.append(
                IssuedAttestation(
                    jws=jws,
                    attestation_type=attestation_type,
                    credential_ref=credential_ref,
                    key_thumbprint=key_thumbprint,
                    expires_at=datetime.fromtimestamp(exp, tz=timezone.utc) if isinstance(exp, int) else None,
                    passport=passport if isinstance(passport, str) else None,
                )
            )
        main, companions = attestations[0], tuple(attestations[1:])
        return IssuedAttestation(
            jws=main.jws, attestation_type=main.attestation_type, credential_ref=main.credential_ref,
            key_thumbprint=main.key_thumbprint, expires_at=main.expires_at, passport=main.passport,
            companions=companions,
        )

    def fetch_status(self, credential_ref: CredentialRef) -> IssuerStatus:
        issuer_id = self.issuer_metadata().issuer_id
        if credential_ref.issuer != issuer_id:
            raise IssuerAdapterError(
                ISSUER_RESPONSE_INVALID, f"credential {credential_ref.external_credential_id} was not issued by {issuer_id}"
            )
        if not credential_ref.issuer_attestation_id:
            raise IssuerAdapterError(
                ISSUER_RESPONSE_INVALID,
                f"the mock issuer reads status by its attestation id; the reference to {credential_ref.external_credential_id} carries none",
            )
        answer = self._run_json(["status", "--attestation-id", credential_ref.issuer_attestation_id])
        state = answer.get("status")
        mapped: Dict[str, IssuerStatusState] = {"valid": "valid", "suspended": "suspended", "invalid": "revoked"}
        if not isinstance(state, str) or state not in mapped:
            raise IssuerAdapterError(ISSUER_RESPONSE_INVALID, f"status returned {state!r}")
        return IssuerStatus(state=mapped[state], checked_at=datetime.now(tz=timezone.utc), source="cli")

    # ─── helpers ────────────────────────────────────────────────────────────

    def _agent_key_file(self, thumbprint: str) -> str:
        path = self._agent_key_files.get(thumbprint) or os.path.join(self._state_dir, "agents", f"{thumbprint}.json")
        if not os.path.isfile(path):
            raise IssuerAdapterError(
                "key_unproven",
                f"the mock issuer has no agent key for thumbprint {thumbprint}; generate it with "
                "`issue-passport --generate-agent-key` or name its file in "
                f"{AGENT_KEYS_ENV} (the mock runs the agent's side of the possession proof itself)",
            )
        return path

    @staticmethod
    def _check_attestation(jws: str, attestation_type: str, *, key_thumbprint: str, passport_id: str) -> None:
        parts = jws.split(".")
        if len(parts) != 3 or not all(parts):
            raise IssuerAdapterError(ISSUER_RESPONSE_INVALID, "attest did not return a compact JWS")
        try:
            header = _b64url_json(parts[0])
            payload = _b64url_json(parts[1])
        except (ValueError, json.JSONDecodeError) as exc:
            raise IssuerAdapterError(ISSUER_RESPONSE_INVALID, f"attestation is not decodable: {exc}") from exc
        if header.get("typ") != ATTESTATION_TYP:
            raise IssuerAdapterError(ISSUER_RESPONSE_INVALID, f"attestation typ is {header.get('typ')!r}, not {ATTESTATION_TYP}")
        if not isinstance(header.get("kid"), str):
            raise IssuerAdapterError(ISSUER_RESPONSE_INVALID, "attestation header has no kid")
        # spec/attestation-1.0.md: every agent.* attestation names the bound key.
        if attestation_type.startswith("urn:grantex:tm:agent."):
            if payload.get("key_thumbprint") != key_thumbprint:
                raise IssuerAdapterError(
                    KEY_BINDING_MISMATCH,
                    f"attestation key_thumbprint is {payload.get('key_thumbprint')!r}, not the issued passport's {key_thumbprint}",
                )
        elif payload.get("key_thumbprint") not in (None, key_thumbprint):
            raise IssuerAdapterError(KEY_BINDING_MISMATCH, "attestation key_thumbprint differs from the issued passport")
        if payload.get("external_credential_id") not in (None, passport_id):
            raise IssuerAdapterError(
                ISSUER_RESPONSE_INVALID,
                f"attestation external_credential_id is {payload.get('external_credential_id')!r}, not the passport {passport_id}",
            )
        if payload.get("type") not in (None, attestation_type):
            raise IssuerAdapterError(
                ISSUER_RESPONSE_INVALID, f"attestation type is {payload.get('type')!r}, not {attestation_type}"
            )

    def _run_text(self, args: Sequence[str]) -> str:
        command = [*self._cli, *args, "--dir", self._state_dir]
        try:
            completed = subprocess.run(  # noqa: S603 - the command is operator configuration
                command, capture_output=True, text=True, timeout=self._timeout, check=False, encoding="utf-8"
            )
        except FileNotFoundError as exc:
            raise IssuerAdapterError(ADAPTER_NOT_INSTALLED, f"cannot run the mock issuer: {exc}") from exc
        except subprocess.TimeoutExpired as exc:
            raise IssuerAdapterError(ISSUER_UNREACHABLE, f"the mock issuer did not answer within {self._timeout}s") from exc
        if completed.returncode == 0:
            return completed.stdout
        stderr = completed.stderr.strip()
        line = stderr.splitlines()[0] if stderr else ""
        if line.startswith(_CLI_PREFIX):
            line = line[len(_CLI_PREFIX):]
        if completed.returncode == 2:
            raise IssuerAdapterError(ADAPTER_INVALID, f"mock issuer usage error: {line or 'no message'}")
        # Refusals are "<code>: <message>"; the code is the issuer's own.
        code, sep, message = line.partition(": ")
        if sep and code and " " not in code:
            raise IssuerAdapterError(code, message)
        raise IssuerAdapterError(ISSUER_UNREACHABLE, f"the mock issuer failed (exit {completed.returncode}): {line or 'no message'}")

    def _run_json(self, args: Sequence[str]) -> Dict[str, Any]:
        text = self._run_text(args)
        try:
            value = json.loads(text)
        except json.JSONDecodeError as exc:
            raise IssuerAdapterError(ISSUER_RESPONSE_INVALID, f"{args[0]} did not print JSON: {exc}") from exc
        if not isinstance(value, dict):
            raise IssuerAdapterError(ISSUER_RESPONSE_INVALID, f"{args[0]} did not print a JSON object")
        return value


def create_mock_issuer_client(config: IssuerAdapterConfig) -> MockIssuerClient:
    """The ``grantex.issuers`` entry point ``mock``."""
    return MockIssuerClient.from_config(config)
