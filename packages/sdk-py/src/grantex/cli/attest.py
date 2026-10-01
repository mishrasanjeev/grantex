"""``grantex-attest``: register an agent key, prove it, and have the configured
accredited issuer attest the agent, in one command.

    grantex-attest AGENT_ID --key agent-key.json

``--key`` is the agent's private JWK (generated with ``--generate-key FILE``
when the file does not exist). The key is added to the agent's history if it
is not there, proven with the registry's challenge, and handed to the adapter
named by ``GRANTEX_ISSUER_ADAPTER``; the attestation is posted to the registry
and the agent's level printed. Each step is one JSON line on stdout with a
``source`` of ``live`` (the registry) or the adapter's name; a refusal is
``code: message`` on stderr with exit status 1.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, Mapping, Optional, Sequence, TextIO

from .._client import Grantex
from .._errors import GrantexApiError, GrantexError
from ..issuers import IssuerAdapterError, load_issuer_client
from ..issuers._attest import attest_agent
from ..issuers._proof import generate_agent_key, jwk_thumbprint, public_jwk, sign_key_proof

DEFAULT_BASE_URL = "https://api.grantex.dev"


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="grantex-attest", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("agent_id", help="the agent to attest (ag_...)")
    parser.add_argument("--key", required=True, metavar="FILE", help="the agent's private JWK file")
    parser.add_argument("--generate-key", action="store_true", help="create --key (ES256) when the file does not exist")
    parser.add_argument("--api-key", help="developer API key (default: GRANTEX_API_KEY)")
    parser.add_argument("--base-url", help=f"registry base URL (default: GRANTEX_BASE_URL or {DEFAULT_BASE_URL})")
    parser.add_argument("--adapter", help="issuer adapter name (default: GRANTEX_ISSUER_ADAPTER)")
    parser.add_argument("--provider-did", help="the agent's provider DID, did:web:<domain> (default: GRANTEX_PROVIDER_DID)")
    parser.add_argument("--passport-out", metavar="FILE", help="write the issuer's credential (the Agent Passport) here")
    return parser


def _emit(out: TextIO, step: str, source: str, **fields: Any) -> None:
    out.write(json.dumps({"step": step, "source": source, **fields}, sort_keys=True) + "\n")
    out.flush()


def _load_or_create_key(path: str, generate: bool, out: TextIO) -> Dict[str, Any]:
    if os.path.exists(path):
        with open(path, encoding="utf-8") as handle:
            key = json.load(handle)
        if not isinstance(key, dict) or "d" not in key:
            raise IssuerAdapterError("adapter_invalid", f"{path} must hold the agent's private JWK")
        return key
    if not generate:
        raise IssuerAdapterError("adapter_invalid", f"{path} does not exist; pass --generate-key to create it")
    private_jwk, _public, thumbprint = generate_agent_key("ES256")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(private_jwk, handle)
        handle.write("\n")
    _emit(out, "key_generated", "local", thumbprint=thumbprint, file=path)
    return private_jwk


def run(argv: Sequence[str], out: TextIO, err: TextIO, environ: Optional[Mapping[str, str]] = None) -> int:
    env = os.environ if environ is None else environ
    args = _parser().parse_args(argv)
    api_key = args.api_key or env.get("GRANTEX_API_KEY")
    if not api_key:
        err.write("grantex-attest: an API key is required (--api-key or GRANTEX_API_KEY)\n")
        return 2
    base_url = args.base_url or env.get("GRANTEX_BASE_URL") or DEFAULT_BASE_URL
    adapter_name = args.adapter or env.get("GRANTEX_ISSUER_ADAPTER")
    try:
        private = _load_or_create_key(args.key, args.generate_key, out)
        pub = public_jwk(private)
        thumbprint = jwk_thumbprint(pub)
        issuer = load_issuer_client(adapter_name, environ=env)
        source = adapter_name or "adapter"
        # The mock runs the agent's side of the possession proof itself and
        # needs the private key file; a real issuer proves with the agent.
        register = getattr(issuer, "register_agent_key_file", None)
        if callable(register):
            register(thumbprint, os.path.abspath(args.key))
        with Grantex(api_key=api_key, base_url=base_url, revocation_check="offline") as client:
            keys = {k.thumbprint: k for k in client.agents.keys.list(args.agent_id)}
            key = keys.get(thumbprint)
            if key is None:
                key = client.agents.keys.add(args.agent_id, pub)
                _emit(out, "key_added", "live", thumbprint=key.thumbprint, status=key.status)
            if key.status == "pending":
                challenge = client.agents.keys.challenge(args.agent_id, thumbprint)
                proof = sign_key_proof(challenge, private)
                key = client.agents.keys.prove(args.agent_id, thumbprint, proof)
                _emit(out, "key_proved", "live", thumbprint=thumbprint, status=key.status, possession_proved_at=key.possession_proved_at)
            elif not key.usable:
                # The registry's verdict: a rotated key still inside its overlap is usable.
                raise IssuerAdapterError(key.denial or "key_not_active", f"key {thumbprint} is {key.status} and not usable")
            metadata = issuer.issuer_metadata()
            _emit(out, "issuer", source, issuer_id=metadata.issuer_id, scopes=list(metadata.scopes))
            provider_did = args.provider_did or env.get("GRANTEX_PROVIDER_DID")
            outcome = attest_agent(client, args.agent_id, thumbprint, issuer=issuer, provider_did=provider_did)
    except IssuerAdapterError as exc:
        err.write(f"grantex-attest: {exc.code}: {exc.detail}\n")
        return 1
    except GrantexApiError as exc:
        err.write(f"grantex-attest: {exc.code or 'registry_error'}: {exc} (HTTP {exc.status_code})\n")
        return 1
    except GrantexError as exc:
        err.write(f"grantex-attest: error: {exc}\n")
        return 1
    records = [(outcome.issued, outcome.registry), *zip(outcome.issued.companions, outcome.companion_records)]
    for issued, record in records:
        _emit(
            out, "attestation_issued", source,
            attestation_type=issued.attestation_type,
            issuer=issued.credential_ref.issuer,
            external_credential_id=issued.credential_ref.external_credential_id,
            external_credential_hash=issued.credential_ref.external_credential_hash,
            issuer_attestation_id=issued.credential_ref.issuer_attestation_id,
        )
        _emit(out, "attestation_ingested", "live", id=record.get("id"), type=record.get("type"), state=record.get("state"))
    _emit(out, "lookup", "live", agent_did=outcome.agent.did, level=outcome.level, flags=list(outcome.flags))
    if args.passport_out:
        if not outcome.issued.passport:
            err.write("grantex-attest: the issuer returned no passport to write\n")
            return 1
        # The credential is the agent's: created readable by this user only, replaced if present.
        fd = os.open(args.passport_out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(outcome.issued.passport + "\n")
        _emit(out, "passport_written", "local", file=args.passport_out)
    return 0


def main(argv: Optional[Sequence[str]] = None) -> int:
    """The ``grantex-attest`` console script."""
    return run(sys.argv[1:] if argv is None else argv, sys.stdout, sys.stderr)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
