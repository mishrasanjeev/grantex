# SPDX-License-Identifier: Apache-2.0
"""The adversarial cases of PRD section 14 that a relying party's verifier meets."""

from __future__ import annotations

from conftest import ISSUER_LIST_URI, NOW, World, p256, tx

from grantex_agent_httpsig import HttpRequest, InMemoryNonceStore, sign
from grantex_agent_passport import issue_passport, jwk_thumbprint
from grantex_verifier import presentations_from_request, verify


def test_forged_issuer_key_not_in_the_manifest(world: World) -> None:
    # A passport signed with a key that claims the issuer's kid but is not in
    # the manifest: issuer keys come from the signed manifest only.
    forger = p256("mock-issuer-2026")
    forged = issue_passport(
        issuer_key=forger.private_jwk,
        iss="https://mock-issuer.example",
        sub="did:grantex:ag_01J8Z3K4M5N6P7Q8R9S0T1V2W3",
        cnf_jwk=world.agent.public_jwk,
        iat=NOW - 60,
        exp=NOW + 86_400,
        status={"status_list": {"uri": ISSUER_LIST_URI, "idx": 42}},
        claims={"attestation_id": "att_01J00000000000000000000000"},
    ).compact
    req, passport, grant = world.signed_request(passport=forged)
    result = verify(passport, grant, req, tx(), config=world.config())
    assert result.denial_code == "passport_invalid_signature"


def test_a_passport_naming_its_own_key_is_refused(world: World) -> None:
    # Swap in a header with jwk: the verifier never takes a key from the token.
    import base64
    import json

    head, rest = world.passport.split(".", 1)
    header = json.loads(base64.urlsafe_b64decode(head + "=="))
    header["jwk"] = world.issuer.public_jwk
    tampered = base64.urlsafe_b64encode(json.dumps(header).encode()).rstrip(b"=").decode() + "." + rest
    req, passport, grant = world.signed_request(passport=tampered)
    result = verify(passport, grant, req, tx(), config=world.config())
    assert not result.checks["passport.signature"].ok


def test_unproven_key(world: World) -> None:
    world.lookup_answers[world.agent_thumbprint] = world.lookup_answer(key_status="pending", key_current=False)
    req, passport, grant = world.signed_request()
    assert verify(passport, grant, req, tx(), config=world.config()).denial_code == "key_unproven"


def test_compromised_key(world: World) -> None:
    world.lookup_answers[world.agent_thumbprint] = world.lookup_answer(key_status="compromised", key_current=False)
    req, passport, grant = world.signed_request()
    assert verify(passport, grant, req, tx(), config=world.config()).denial_code == "key_not_active"


def test_swapped_headers_under_a_valid_signature(world: World) -> None:
    # The agent signs a request whose Agent-Passport carries the grant and
    # whose Agent-Grant carries the passport. The signature verifies, but
    # neither credential is what its header says.
    grant = world.grant()
    req, _, _ = world.signed_request(passport=grant, grant=world.passport)
    passport_value, grant_value = presentations_from_request(req)
    assert passport_value == grant
    result = verify(passport_value or "", grant_value or "", req, tx(), config=world.config())
    assert not result.ok
    assert not result.checks["passport.signature"].ok
    assert not result.checks["grant.signature"].ok


def test_replay_at_a_second_relying_party_fails_the_authority(world: World) -> None:
    req, passport, grant = world.signed_request()
    config = world.config(origin="https://second-merchant.example")
    result = verify(passport, grant, req, tx(merchant="https://second-merchant.example"), config=config)
    assert not result.ok
    assert result.checks["request.signature"].code == "request_signature_invalid"
    assert result.checks["grant.audience"].code == "audience_mismatch"


def test_replay_at_the_same_relying_party_reuses_the_nonce(world: World) -> None:
    config = world.config()
    req, passport, grant = world.signed_request()
    assert verify(passport, grant, req, tx(), config=config).ok
    again = verify(passport, grant, req, tx(), config=config)
    assert again.denial_code == "request_signature_invalid"
    assert "nonce" in again.checks["request.signature"].detail


def test_stale_status_list(world: World) -> None:
    world.fetcher.documents[ISSUER_LIST_URI] = world.issuer_list(exp=NOW - 10)
    req, passport, grant = world.signed_request()
    assert verify(passport, grant, req, tx(), config=world.config()).denial_code == "status_stale"


def test_suspended_issuer(world: World) -> None:
    world.issuer_state = "suspended"
    world.publish()
    req, passport, grant = world.signed_request()
    assert verify(passport, grant, req, tx(), config=world.config()).denial_code == "issuer_suspended"


def test_rotated_key_past_overlap(world: World) -> None:
    world.lookup_answers[world.agent_thumbprint] = world.lookup_answer(key_status="rotated", key_current=False)
    req, passport, grant = world.signed_request()
    assert verify(passport, grant, req, tx(), config=world.config()).denial_code == "key_not_active"


def test_a_sub_agent_presenting_its_parents_passport(world: World) -> None:
    # The sub-agent holds its own key, and its delegated grant is bound to it;
    # it presents the parent's passport, which is bound to the parent's key.
    sub_agent = p256()
    sub_thumbprint = jwk_thumbprint(sub_agent.public_jwk)
    world.lookup_answers[sub_thumbprint] = world.lookup_answer(
        key_thumbprint=sub_thumbprint, agent_did="did:grantex:ag_01SUBAGENT"
    )
    entry = world.commerce_entry()
    entry["passport"]["key_thumbprint"] = sub_thumbprint
    grant = world.grant(cnf={"jkt": sub_thumbprint}, authorization_details=[entry])
    headers = {"content-type": "application/json"}
    body = b'{"cart_id":"c-1001"}'
    signed = sign(
        HttpRequest("POST", "https://merchant.example/v1/checkout", headers, body),
        key=sub_agent.private_jwk,
        agent_passport=world.passport,
        agent_grant=grant,
        created=NOW,
    )
    req = HttpRequest("POST", "/v1/checkout", {**headers, **signed.headers}, body)
    config = world.config(nonce_store=InMemoryNonceStore(clock=lambda: NOW))
    result = verify(world.passport, grant, req, tx(), config=config)
    assert result.denial_code == "key_binding_mismatch"
    assert result.checks["key.binding"].code == "key_binding_mismatch"
    # The request was signed by a key the passport is not bound to.
    assert result.checks["request.signature"].code == "request_signature_invalid"
