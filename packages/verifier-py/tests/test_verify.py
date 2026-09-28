# SPDX-License-Identifier: Apache-2.0
"""verify(): every named check, its pass path and its failure codes."""

from __future__ import annotations

from typing import Any

import pytest
from conftest import (
    ACCEPTANCE_URI,
    AGENT_DID,
    BUDGET,
    INVALID,
    ISSUER_LIST_URI,
    NOW,
    ORIGIN,
    SUSPENDED,
    World,
    p256,
    tx,
)

from grantex_verifier import CHECK_ORDER, GrantStatus, VerificationResult, verify


def run(world: World, *, transaction: Any = None, config: Any = None, **request: Any) -> VerificationResult:
    req, passport, grant = world.signed_request(**request)
    return verify(
        passport,
        grant,
        req,
        tx() if transaction is None else transaction,
        config=world.config() if config is None else config,
    )


def failed(result: VerificationResult, check: str, code: str) -> None:
    assert not result.ok
    assert result.checks[check].ok is False, result.checks[check]
    assert result.checks[check].code == code, result.checks[check]


def test_a_good_request_passes_every_check(world: World) -> None:
    result = run(world)
    assert result.ok, {k: v for k, v in result.checks.items() if not v.ok}
    assert result.denial_code is None
    assert list(result.checks) == list(CHECK_ORDER)
    assert all(c.ok for c in result.checks.values())
    assert result.level == "attested"
    assert result.flags == ()
    assert result.tier == "B"
    for name in ("passport.status", "attestation.accepted", "key.status"):
        assert result.checks[name].cached_at == NOW


def test_the_result_serialises_with_the_documented_shape(world: World) -> None:
    out = run(world).to_dict()
    assert set(out) >= {"ok", "denial_code", "checks", "level", "flags", "tier", "evidence"}
    assert set(out["checks"]["passport.signature"]) >= {"ok", "detail", "cached_at"}


def test_evidence_records_hash_attestation_both_statuses_and_level(world: World) -> None:
    result = run(world)
    evidence = result.evidence
    assert evidence["passport_hash"].startswith("sha-256:")
    assert evidence["attestation_id"] == "att_01J00000000000000000000000"
    assert evidence["passport_status"]["uri"] == ISSUER_LIST_URI
    assert evidence["passport_status"]["status"] == "VALID"
    assert evidence["acceptance_status"]["uri"] == ACCEPTANCE_URI
    assert evidence["acceptance_status"]["status"] == "VALID"
    assert evidence["level"] == "attested"
    assert evidence["verified_at"] == NOW


# ── issuer.accredited ────────────────────────────────────────────────────────


def test_an_issuer_missing_from_the_manifest_is_not_accredited(world: World) -> None:
    world.fetcher.documents["https://registry.example/.well-known/agent-registry.json"] = world.manifest(
        issuers=[]
    )
    result = run(world)
    assert result.denial_code == "issuer_not_accredited"
    failed(result, "issuer.accredited", "issuer_not_accredited")
    # Every check is still reported.
    assert list(result.checks) == list(CHECK_ORDER)


def test_a_withdrawn_issuer_is_not_accredited(world: World) -> None:
    world.issuer_state = "withdrawn"
    world.publish()
    failed(run(world), "issuer.accredited", "issuer_not_accredited")


def test_a_suspended_issuer_is_refused(world: World) -> None:
    world.issuer_state = "suspended"
    world.publish()
    result = run(world)
    assert result.denial_code == "issuer_suspended"
    failed(result, "issuer.accredited", "issuer_suspended")


def test_an_issuer_without_the_agent_identity_mark_is_refused(world: World) -> None:
    world.issuer_trust_marks = ["urn:grantex:tm:provider.entity"]
    world.publish()
    failed(run(world), "issuer.accredited", "trust_mark_missing")


# ── passport.signature ───────────────────────────────────────────────────────


def test_a_passport_signed_by_a_key_not_in_the_manifest_is_refused(world: World) -> None:
    world.issuer_manifest_keys = [p256("mock-issuer-2026").public_jwk]
    world.publish()
    result = run(world)
    assert result.denial_code == "passport_invalid_signature"
    failed(result, "passport.signature", "passport_invalid_signature")


def test_an_expired_passport_is_refused(world: World) -> None:
    world.now = float(NOW + 31 * 86_400)
    world.publish()
    failed(run(world, created=NOW + 31 * 86_400), "passport.signature", "passport_expired")


def test_a_manifest_that_does_not_verify_fails_closed(world: World) -> None:
    world.fetcher.documents["https://registry.example/.well-known/agent-registry.json"] = (
        world.manifest().rsplit(".", 1)[0] + ".AAAA"
    )
    result = run(world)
    failed(result, "passport.signature", "passport_invalid_signature")
    failed(result, "issuer.accredited", "passport_invalid_signature")


@pytest.mark.parametrize(
    "header",
    [
        {"alg": "RS256", "kid": "registry-rs256-1", "typ": "JWT"},
        {"alg": "HS256", "kid": "registry-rs256-1", "typ": "grantex-registry-manifest+jwt"},
        {"alg": "RS256", "kid": "registry-rs256-1", "typ": "grantex-registry-manifest+jwt", "jku": "https://x.example"},
        {"alg": "RS256", "kid": "registry-rs256-1", "typ": "grantex-registry-manifest+jwt", "crit": ["b64"]},
        {"alg": "RS256", "kid": "unknown", "typ": "grantex-registry-manifest+jwt"},
    ],
)
def test_manifest_header_rules(world: World, header: Any) -> None:
    world.fetcher.documents["https://registry.example/.well-known/agent-registry.json"] = world.manifest(header)
    failed(run(world), "issuer.accredited", "passport_invalid_signature")


def test_a_manifest_from_another_registry_is_refused(world: World) -> None:
    world.fetcher.documents["https://registry.example/.well-known/agent-registry.json"] = world.manifest(
        iss="https://other-registry.example"
    )
    failed(run(world), "issuer.accredited", "passport_invalid_signature")


def test_a_manifest_older_than_an_hour_is_stale(world: World) -> None:
    world.fetcher.documents["https://registry.example/.well-known/agent-registry.json"] = world.manifest(
        iat=NOW - 3700, exp=NOW + 60
    )
    result = run(world)
    assert result.denial_code == "status_stale"
    failed(result, "issuer.accredited", "status_stale")


def test_an_unreachable_manifest_fails_closed(world: World) -> None:
    world.fetcher.down.add("https://registry.example/.well-known/agent-registry.json")
    result = run(world)
    failed(result, "issuer.accredited", "status_stale")
    failed(result, "passport.signature", "status_stale")


# ── passport.status ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("value", [INVALID, SUSPENDED, 0x03])
def test_a_passport_the_issuer_does_not_hold_valid_is_revoked(world: World, value: int) -> None:
    world.issuer_status = value
    world.publish()
    result = run(world)
    assert result.denial_code == "passport_revoked"
    failed(result, "passport.status", "passport_revoked")
    assert result.evidence["passport_status"]["ok"] is False


def test_an_issuer_list_signed_by_another_key_is_stale(world: World) -> None:
    from conftest import sign_jwt

    forged = sign_jwt(
        {"alg": "ES256", "kid": "mock-issuer-2026", "typ": "statuslist+jwt"},
        {"sub": ISSUER_LIST_URI, "iat": NOW, "exp": NOW + 600, "status_list": {"bits": 2, "lst": "eNoDAAAAAAE"}},
        p256().key,
    )
    world.fetcher.documents[ISSUER_LIST_URI] = forged
    failed(run(world), "passport.status", "status_stale")


def test_an_issuer_list_for_another_uri_is_stale(world: World) -> None:
    world.fetcher.documents[ISSUER_LIST_URI] = world.issuer_list(sub="https://mock-issuer.example/status/2")
    failed(run(world), "passport.status", "status_stale")


def test_an_issuer_list_with_another_typ_is_stale(world: World) -> None:
    from conftest import sign_jwt

    world.fetcher.documents[ISSUER_LIST_URI] = sign_jwt(
        {"alg": "ES256", "kid": "mock-issuer-2026", "typ": "JWT"},
        {"sub": ISSUER_LIST_URI, "iat": NOW, "exp": NOW + 600, "status_list": {"bits": 2, "lst": "eNoDAAAAAAE"}},
        world.issuer.key,
    )
    failed(run(world), "passport.status", "status_stale")


def test_an_expired_issuer_list_is_stale(world: World) -> None:
    world.fetcher.documents[ISSUER_LIST_URI] = world.issuer_list(exp=NOW - 1)
    failed(run(world), "passport.status", "status_stale")


def test_an_unreachable_issuer_list_is_stale(world: World) -> None:
    world.fetcher.down.add(ISSUER_LIST_URI)
    result = run(world)
    assert result.denial_code == "status_stale"
    failed(result, "passport.status", "status_stale")



STATUS_BASE = "https://mock-issuer.example/status/"


@pytest.mark.parametrize(
    "uri",
    [
        "https://mock-issuer.example/status/../admin/1",
        "https://mock-issuer.example/status/./1",
        "https://mock-issuer.example/status/%2e%2e/admin/1",
        "https://mock-issuer.example/status/.%2E/admin/1",
        "https://mock-issuer.example/status/a/%2e/1",
        "https://mock-issuer.example/status/a/..",
        "https://mock-issuer.example/status/a\\..\\1",
        "https://mock-issuer.example/status/a b",
        "https://mock-issuer.example/status/1?x=1",
        "https://mock-issuer.example/status/1#x",
        "https://mock-issuer.example/status/",
        "http://mock-issuer.example/status/1",
    ],
)
def test_a_status_uri_not_in_canonical_form_under_the_base_is_refused(uri: str) -> None:
    # owner decision 8, as statusUriUnderBase: the URI must be its own WHATWG
    # serialisation (no dot segments) and under the base.
    from grantex_verifier._verify import _under_base

    assert _under_base(uri, STATUS_BASE) is False


@pytest.mark.parametrize(
    "uri", ["https://mock-issuer.example/status/1", "https://mock-issuer.example/status/a/..b/%2E1"]
)
def test_a_canonical_status_uri_under_the_base_is_accepted(uri: str) -> None:
    from grantex_verifier._verify import _under_base

    assert _under_base(uri, STATUS_BASE) is True


def test_a_passport_whose_status_uri_has_dot_segments_is_stale(world: World) -> None:
    # The list is served, and signed for, at the dotted URI: only the base
    # check stands between it and the fetcher.
    from conftest import ATTESTATION_ID, ISSUER, ISSUER_IDX
    from grantex_agent_passport import issue_passport

    uri = "https://mock-issuer.example/status/../admin/1"
    world.passport = issue_passport(
        issuer_key=world.issuer.private_jwk,
        iss=ISSUER,
        sub=AGENT_DID,
        cnf_jwk=world.agent.public_jwk,
        iat=int(world.now) - 3600,
        exp=int(world.now) + 30 * 86_400,
        status={"status_list": {"uri": uri, "idx": ISSUER_IDX}},
        claims={
            "provider": {"did": "did:web:provider.example", "name": "Provider Example Ltd"},
            "agent": {"software_name": "Nimbus Shopper", "software_version": "2.4"},
            "verification": {"level": "substantial"},
            "attestation_id": ATTESTATION_ID,
        },
    ).compact
    world.fetcher.documents[uri] = world.issuer_list(sub=uri)
    failed(run(world), "passport.status", "status_stale")


# ── attestation.registered ───────────────────────────────────────────────────


def test_a_grant_bound_to_another_attestation_is_not_registered(world: World) -> None:
    entry = world.commerce_entry()
    entry["passport"]["id"] = "att_01J99999999999999999999999"
    grant = world.grant(authorization_details=[entry])
    failed(run(world, grant=grant), "attestation.registered", "attestation_not_registered")


def test_a_grant_bound_to_another_hash_is_a_hash_mismatch(world: World) -> None:
    entry = world.commerce_entry()
    entry["passport"]["hash"] = "sha-256:" + "A" * 43
    grant = world.grant(authorization_details=[entry])
    result = run(world, grant=grant)
    assert result.denial_code == "attestation_hash_mismatch"
    failed(result, "attestation.registered", "attestation_hash_mismatch")


def test_a_grant_without_a_passport_binding_is_not_registered(world: World) -> None:
    grant = world.grant(authorization_details=[{"type": BUDGET, "amount": 10.0, "currency": "EUR"}])
    failed(run(world, grant=grant), "attestation.registered", "attestation_not_registered")


def test_a_grant_bound_by_another_issuer_is_a_mismatch(world: World) -> None:
    entry = world.commerce_entry()
    entry["passport"]["issuer"] = "https://issuer.example"
    grant = world.grant(authorization_details=[entry])
    failed(run(world, grant=grant), "attestation.registered", "attestation_mismatch")


# ── attestation.accepted ─────────────────────────────────────────────────────


@pytest.mark.parametrize("value", [INVALID, SUSPENDED])
def test_an_attestation_the_registry_no_longer_accepts_is_refused(world: World, value: int) -> None:
    world.acceptance = value
    world.publish()
    result = run(world)
    assert result.denial_code == "attestation_not_accepted"
    failed(result, "attestation.accepted", "attestation_not_accepted")


def test_an_acceptance_list_outside_the_registry_is_not_registered(world: World) -> None:
    entry = world.commerce_entry(acceptance_status={"uri": "https://mock-issuer.example/status/9", "idx": 1})
    grant = world.grant(authorization_details=[entry])
    failed(run(world, grant=grant), "attestation.accepted", "attestation_not_registered")


def test_an_acceptance_list_signed_by_another_key_is_stale(world: World) -> None:
    from conftest import rsa_key, sign_jwt

    world.fetcher.documents[ACCEPTANCE_URI] = sign_jwt(
        {"alg": "RS256", "kid": "registry-rs256-1", "typ": "statuslist+jwt"},
        {"iss": "https://registry.example", "sub": ACCEPTANCE_URI, "iat": NOW, "exp": NOW + 600,
         "status_list": {"bits": 2, "lst": "eNoDAAAAAAE"}},
        rsa_key("registry-rs256-1").key,
    )
    failed(run(world), "attestation.accepted", "status_stale")


def test_an_unreachable_acceptance_list_is_stale(world: World) -> None:
    world.fetcher.down.add(ACCEPTANCE_URI)
    failed(run(world), "attestation.accepted", "status_stale")


# ── grant.signature, grant.status, grant.audience ────────────────────────────


def test_a_grant_not_signed_by_the_registry_is_invalid(world: World) -> None:
    from conftest import rsa_key, sign_jwt

    forged = sign_jwt(
        {"alg": "RS256", "kid": "registry-rs256-1", "typ": "at+jwt"}, world.grant_claims(), rsa_key("x").key
    )
    result = run(world, grant=forged)
    failed(result, "grant.signature", "token_invalid")


@pytest.mark.parametrize(
    "header",
    [
        {"alg": "none", "kid": "registry-rs256-1", "typ": "at+jwt"},
        {"alg": "RS256", "kid": "registry-rs256-1", "typ": "JWT"},
        {"alg": "RS256", "kid": "registry-rs256-1", "typ": "at+jwt", "jwk": {"kty": "RSA"}},
    ],
)
def test_grant_header_rules(world: World, header: Any) -> None:
    failed(run(world, grant=world.grant(header)), "grant.signature", "token_invalid")


def test_an_expired_grant_is_invalid(world: World) -> None:
    failed(run(world, grant=world.grant(exp=NOW - 120)), "grant.signature", "token_invalid")


def test_a_grant_from_another_issuer_is_invalid(world: World) -> None:
    failed(run(world, grant=world.grant(iss="https://auth.example")), "grant.signature", "token_invalid")


@pytest.mark.parametrize("state", ["revoked", "suspended"])
def test_a_revoked_grant_is_refused(world: World, state: str) -> None:
    world.grant_status.state = state
    result = run(world)
    assert result.denial_code == "grant_revoked"
    failed(result, "grant.status", "grant_revoked")


def test_an_unknown_grant_status_fails_closed(world: World) -> None:
    world.grant_status.state = "unknown"
    failed(run(world), "grant.status", "status_stale")


def test_an_unreachable_grant_status_fails_closed(world: World) -> None:
    world.grant_status.raises = True
    failed(run(world), "grant.status", "status_stale")


def test_a_grant_for_another_relying_party_is_an_audience_mismatch(world: World) -> None:
    result = run(world, grant=world.grant(aud="https://other-merchant.example"))
    assert result.denial_code == "audience_mismatch"
    failed(result, "grant.audience", "audience_mismatch")


def test_a_child_grant_must_name_the_merchant_origin(world: World) -> None:
    config = world.config(audience="merchant-api")
    failed(run(world, grant=world.grant(aud="merchant-api"), config=config), "grant.audience", "audience_mismatch")


def test_a_root_grant_may_name_the_configured_audience(world: World) -> None:
    config = world.config(audience="merchant-api")
    claims = world.grant_claims(aud="merchant-api")
    del claims["urn:grantex:grant"]["parent_grant_id"]
    del claims["urn:grantex:grant"]["delegation_depth"]
    grant = world.grant(**{"aud": "merchant-api", "urn:grantex:grant": claims["urn:grantex:grant"]})
    assert run(world, grant=grant, config=config).checks["grant.audience"].ok


# ── key.binding and key.status ───────────────────────────────────────────────


def test_a_grant_bound_to_another_key_is_a_key_binding_mismatch(world: World) -> None:
    result = run(world, grant=world.grant(cnf={"jkt": "A" * 43}))
    assert result.denial_code == "key_binding_mismatch"
    failed(result, "key.binding", "key_binding_mismatch")


def test_an_unproven_key_is_refused(world: World) -> None:
    world.lookup_answers[world.agent_thumbprint] = world.lookup_answer(key_status="pending", key_current=False)
    result = run(world)
    failed(result, "key.status", "key_unproven")


def test_a_key_the_registry_does_not_know_is_unproven(world: World) -> None:
    world.lookup_answers.clear()
    failed(run(world), "key.status", "key_unproven")


def test_a_compromised_key_is_not_active(world: World) -> None:
    world.lookup_answers[world.agent_thumbprint] = world.lookup_answer(
        key_status="compromised", key_current=False, flags=["key_compromised"]
    )
    result = run(world)
    assert result.denial_code == "key_not_active"
    failed(result, "key.status", "key_not_active")
    assert result.flags == ("key_compromised",)


def test_a_rotated_key_past_its_overlap_is_not_active(world: World) -> None:
    world.lookup_answers[world.agent_thumbprint] = world.lookup_answer(key_status="rotated", key_current=False)
    failed(run(world), "key.status", "key_not_active")


def test_a_rotated_key_inside_its_overlap_is_accepted(world: World) -> None:
    world.lookup_answers[world.agent_thumbprint] = world.lookup_answer(key_status="rotated", key_current=True)
    assert run(world).ok


def test_a_key_held_by_another_agent_is_a_key_binding_mismatch(world: World) -> None:
    world.lookup_answers[world.agent_thumbprint] = world.lookup_answer(agent_did="did:grantex:ag_01OTHER")
    failed(run(world), "key.status", "key_binding_mismatch")


def test_an_unreachable_lookup_fails_closed(world: World) -> None:
    world.lookup_raises = True
    result = run(world)
    failed(result, "key.status", "status_stale")
    assert result.level is None


# ── request.signature ────────────────────────────────────────────────────────


def test_a_stale_request_signature_is_refused(world: World) -> None:
    result = run(world, created=NOW - 400)
    failed(result, "request.signature", "request_signature_stale")


def test_a_request_signed_for_another_authority_is_refused(world: World) -> None:
    result = run(world, url="https://other-merchant.example/v1/checkout")
    failed(result, "request.signature", "request_signature_invalid")


def test_a_presentation_other_than_the_signed_one_is_refused(world: World) -> None:
    req, passport, grant = world.signed_request()
    other_grant = world.grant(scope="checkout:create checkout:refund")
    result = verify(passport, other_grant, req, tx(), config=world.config())
    failed(result, "request.signature", "request_signature_invalid")
    assert "presentation" in result.checks["request.signature"].detail


# ── level ────────────────────────────────────────────────────────────────────


def test_a_level_below_the_configured_minimum_is_refused(world: World) -> None:
    world.lookup_answers[world.agent_thumbprint] = world.lookup_answer(level="verified")
    result = run(world, config=world.config(min_level="attested"))
    assert result.denial_code == "level_below_policy"
    failed(result, "level", "level_below_policy")


def test_the_level_meeting_the_minimum_passes(world: World) -> None:
    assert run(world, config=world.config(min_level="attested")).checks["level"].ok


# ── constraints and budget ───────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("transaction", "code"),
    [
        (dict(amount_minor=60_000), "cap_exceeded"),
        (dict(amount_minor=50), "cap_exceeded"),
        (dict(currency="USD"), "cap_exceeded"),
        (dict(merchant="https://other-merchant.example"), "audience_mismatch"),
        (dict(amount_minor=None), "cap_exceeded"),
        (dict(at=float(NOW + 2 * 86_400)), "cap_exceeded"),
    ],
)
def test_a_transaction_outside_the_constraints_is_refused(world: World, transaction: Any, code: str) -> None:
    result = run(world, transaction=tx(**transaction))
    failed(result, "constraints", code)


def test_unreadable_constraints_are_refused(world: World) -> None:
    entry = world.commerce_entry(constraints={"amount_range": {"max_minor": "lots"}})
    failed(run(world, grant=world.grant(authorization_details=[entry])), "constraints", "token_invalid")


def test_unknown_constraint_members_are_refused(world: World) -> None:
    entry = world.commerce_entry(constraints={"currency": "EUR", "max_per_day": 3})
    failed(run(world, grant=world.grant(authorization_details=[entry])), "constraints", "token_invalid")


def test_budget_is_reported_not_enforced(world: World) -> None:
    result = run(world)
    check = result.checks["budget.remaining"]
    assert check.ok
    assert "400" in check.detail and "EUR" in check.detail
    assert result.evidence["budget"] == {"amount": 400.0, "currency": "EUR"}


# ── ordering ─────────────────────────────────────────────────────────────────


def test_the_first_failing_check_in_order_sets_the_denial_code(world: World) -> None:
    world.issuer_state = "suspended"
    world.publish()
    world.grant_status.state = "revoked"
    result = run(world, grant=world.grant(aud="https://other-merchant.example"))
    assert result.denial_code == "issuer_suspended"
    assert result.checks["grant.status"].code == "grant_revoked"
    assert result.checks["grant.audience"].code == "audience_mismatch"


def test_the_agent_did_in_the_evidence_is_the_passport_subject(world: World) -> None:
    assert run(world).evidence["agent_did"] == AGENT_DID


def test_an_origin_with_a_path_is_a_configuration_error(world: World) -> None:
    with pytest.raises(ValueError):
        world.config(origin="https://merchant.example/checkout")


def test_grant_status_values_are_checked() -> None:
    with pytest.raises(ValueError):
        GrantStatus(state="fine", checked_at=0.0)


def test_origin_default_audience(world: World) -> None:
    assert world.config().audience == ORIGIN
