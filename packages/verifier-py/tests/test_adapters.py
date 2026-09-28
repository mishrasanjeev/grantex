# SPDX-License-Identifier: Apache-2.0
"""The ACP and AP2 rendering functions (Phase 1 preview)."""

from __future__ import annotations

import copy

import pytest
from conftest import AGENT_DID, ISSUER, NOW, ORIGIN, World

from grantex_verifier import render_acp_delegate_payment, render_ap2_mandate


def test_acp_allowance_and_usage_limits_come_from_the_child_grant(world: World) -> None:
    claims = world.grant_claims()
    out = render_acp_delegate_payment(claims, merchant_id="merchant-example", checkout_session_id="cs_01")
    assert out["allowance"] == {
        "reason": "one_time",
        "max_amount": 50_000,
        "currency": "eur",
        "checkout_session_id": "cs_01",
        "merchant_id": "merchant-example",
        "expires_at": out["allowance"]["expires_at"],
    }
    # The earlier of the grant's exp and the constraint window's end.
    assert out["usage_limits"] == {"currency": "eur", "max_amount": 50_000, "expires_at": NOW + 3600}
    assert out["allowance"]["expires_at"].endswith("Z")


def test_acp_needs_a_child_grant(world: World) -> None:
    claims = world.grant_claims()
    del claims["urn:grantex:grant"]["parent_grant_id"]
    with pytest.raises(ValueError):
        render_acp_delegate_payment(claims, merchant_id="m")


def test_acp_needs_an_amount_ceiling_and_currency(world: World) -> None:
    claims = world.grant_claims()
    claims["authorization_details"][1]["constraints"] = {"currency": "EUR"}
    with pytest.raises(ValueError):
        render_acp_delegate_payment(claims, merchant_id="m")


def test_acp_rendering_does_not_change_its_input(world: World) -> None:
    claims = world.grant_claims()
    before = copy.deepcopy(claims)
    render_acp_delegate_payment(claims, merchant_id="m")
    assert claims == before


def test_ap2_mandate_binds_the_agent_key_and_discloses_the_passport_selectively(world: World) -> None:
    claims = world.grant_claims()
    out = render_ap2_mandate(claims, agent_did=AGENT_DID, agent_jwk=world.agent.public_jwk)
    body = out["claims"]
    assert body["cnf"] == {"jwk": world.agent.public_jwk}
    assert body["sub"] == AGENT_DID
    assert body["checkout_mandate"]["merchants"] == [ORIGIN]
    assert body["payment_mandate"]["max_amount_minor"] == 50_000
    assert body["payment_mandate"]["currency"] == "EUR"
    assert "agent_passport" not in body
    assert out["disclosable"]["agent_passport"]["issuer"] == ISSUER
    assert out["disclosable"]["agent_passport"]["key_thumbprint"] == world.agent_thumbprint


def test_ap2_refuses_a_key_other_than_the_grants(world: World) -> None:
    from conftest import p256

    with pytest.raises(ValueError):
        render_ap2_mandate(world.grant_claims(), agent_did=AGENT_DID, agent_jwk=p256().public_jwk)


def test_ap2_refuses_a_private_key(world: World) -> None:
    with pytest.raises(ValueError):
        render_ap2_mandate(world.grant_claims(), agent_did=AGENT_DID, agent_jwk=world.agent.private_jwk)
