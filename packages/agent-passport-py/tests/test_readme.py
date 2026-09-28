# SPDX-License-Identifier: Apache-2.0
"""The README examples, run as written (with a stub registry and fresh keys)."""

from __future__ import annotations

import contextlib
import io
import time
from typing import Any, Dict, List

from conftest import ISSUER, p256_key_pair, passport_params
from grantex_agent_passport import (
    KeyBindingRequirement,
    PassportError,
    create_key_binding_jwt,
    external_credential_hash,
    issue_passport,
    keys_equal,
    select_disclosures,
    verify_passport,
)


class _Registry:
    def __init__(self, keys: Dict[str, List[Dict[str, Any]]]) -> None:
        self._keys = keys

    def issuer_keys(self, issuer: str) -> List[Dict[str, Any]]:
        return self._keys.get(issuer, [])


class _StatusLists:
    def status(self, uri: str, idx: int) -> str:
        return "valid"


def test_readme_examples() -> None:
    issuer = p256_key_pair("mock-issuer-2026")
    agent = p256_key_pair()
    registry = _Registry({ISSUER: [issuer.public_jwk]})
    status_lists = _StatusLists()
    now = int(time.time())
    passport_compact = issue_passport(
        **passport_params(issuer, agent, iat=now - 60, exp=now + 86_400)
    ).compact
    agent_private_jwk = agent.private_jwk
    registered_agent_key = dict(agent.public_jwk, kid="shopper-01-key-1")
    nonce = "n-0S6_WzA2Mj"

    # README: Present selected claims
    presentation = create_key_binding_jwt(
        select_disclosures(passport_compact, ["provider", "agent"]),
        holder_key=agent_private_jwk,
        aud="https://merchant.example",
        nonce=nonce,
    )

    # README: Verify a presentation
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        try:
            passport = verify_passport(
                presentation,
                # Issuer keys come only from your own trust configuration, never from the token.
                issuer_keys=registry.issuer_keys,
                # Revoked, suspended or unresolvable status is refused (passport_revoked, status_stale).
                status_resolver=status_lists.status,
                key_binding=KeyBindingRequirement(aud="https://merchant.example", nonce=nonce),
                payments_rails=True,
            )
            print(passport.sub, passport.disclosed["agent"]["software_name"])
            print(passport.external_credential_hash, passport.cnf_thumbprint)
        except PassportError as error:
            print(error.code, error.reason)
    lines = out.getvalue().splitlines()
    assert lines[0] == "did:web:provider.example:agents:shopper-01 Nimbus Shopper"

    # README: Hash rule and key rule
    assert external_credential_hash(presentation) == external_credential_hash(passport_compact)
    assert keys_equal(passport.cnf_jwk, registered_agent_key)

    # The error branch of the README example.
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        try:
            verify_passport(
                presentation,
                issuer_keys=registry.issuer_keys,
                status_resolver=status_lists.status,
                key_binding=KeyBindingRequirement(aud="https://merchant.example", nonce="another"),
                payments_rails=True,
            )
        except PassportError as error:
            print(error.code, error.reason)
    assert out.getvalue().strip() == "key_unproven nonce_mismatch"
