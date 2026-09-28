# SPDX-License-Identifier: Apache-2.0
"""Rendering a verified grant into payment-protocol objects (PRD section 10).

**Phase 1 preview.** These are pure functions: they read a grant the relying
party has already verified (``VerificationResult.grant_claims``) and return
plain dicts. They make no network call, sign nothing and register nothing;
the caller sends or signs the result with its own ACP or AP2 integration.
Member names follow the public specifications cited on each function, and
may change as those specifications move; check the rendered object against
the current text before relying on it.
"""

from __future__ import annotations

import copy
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Optional

from grantex_agent_passport import jwk_thumbprint

from ._codes import Refusal
from ._jose import PRIVATE_MEMBERS
from ._verify import COMMERCE_TYPE, _parse_constraints


def _commerce(grant_claims: Mapping[str, Any]) -> Mapping[str, Any]:
    details = grant_claims.get("authorization_details")
    entries = [
        d for d in (details if isinstance(details, list) else []) if isinstance(d, Mapping) and d.get("type") == COMMERCE_TYPE
    ]
    if len(entries) != 1:
        raise ValueError("the grant must carry exactly one %s entry" % COMMERCE_TYPE)
    return entries[0]


def _limits(grant_claims: Mapping[str, Any]) -> Dict[str, Any]:
    commerce = _commerce(grant_claims)
    try:
        constraints = _parse_constraints(commerce.get("constraints", {}))
    except Refusal as refusal:
        raise ValueError(refusal.detail) from refusal
    if constraints.amount_max is None or constraints.currency is None:
        raise ValueError("the grant's constraints must carry amount_range.max_minor and currency")
    exp = grant_claims.get("exp")
    if not isinstance(exp, int) or isinstance(exp, bool):
        raise ValueError("the grant has no exp")
    expires = exp if constraints.not_after is None else min(exp, constraints.not_after)
    return {
        "commerce": commerce,
        "max_minor": constraints.amount_max,
        "currency": constraints.currency,
        "expires_at": expires,
        "merchants": list(constraints.merchants or []),
    }


def render_acp_delegate_payment(
    grant_claims: Mapping[str, Any],
    *,
    merchant_id: str,
    checkout_session_id: Optional[str] = None,
) -> Dict[str, Any]:
    """The limits of a per-merchant child grant as an ACP delegated payment
    ``allowance`` and a Stripe Shared Payment Token ``usage_limits``.

    - ``allowance``: the Agentic Commerce Protocol's Delegate Payment request
      (``POST /agentic_commerce/delegate_payment``): ``reason``
      ``one_time``, ``max_amount`` in minor units, ``currency`` as a
      lower-case ISO 4217 code, ``checkout_session_id``, ``merchant_id`` and
      ``expires_at`` as an RFC 3339 timestamp.
    - ``usage_limits``: the same ceiling for a Stripe Shared Payment Token:
      ``currency``, ``max_amount`` and ``expires_at`` (UNIX seconds).

    ``expires_at`` is the earlier of the grant's ``exp`` and the end of its
    constraint window. The grant must be a child grant (it names a
    ``parent_grant_id``) with an amount ceiling and a currency. Phase 1
    preview.
    """
    record = grant_claims.get("urn:grantex:grant")
    if not isinstance(record, Mapping) or not isinstance(record.get("parent_grant_id"), str):
        raise ValueError("render_acp_delegate_payment needs a per-merchant child grant")
    limits = _limits(grant_claims)
    currency = limits["currency"].lower()
    expires_at = int(limits["expires_at"])
    allowance: Dict[str, Any] = {
        "reason": "one_time",
        "max_amount": limits["max_minor"],
        "currency": currency,
        "checkout_session_id": checkout_session_id,
        "merchant_id": merchant_id,
        "expires_at": datetime.fromtimestamp(expires_at, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if checkout_session_id is None:
        del allowance["checkout_session_id"]
    return {
        "allowance": allowance,
        "usage_limits": {"currency": currency, "max_amount": limits["max_minor"], "expires_at": expires_at},
    }


def render_ap2_mandate(
    grant_claims: Mapping[str, Any],
    *,
    agent_did: str,
    agent_jwk: Mapping[str, Any],
) -> Dict[str, Any]:
    """Claims for AP2 (Agent Payments Protocol) v0.2 open Checkout and Payment
    Mandates, bound to the agent's key.

    Returns ``{"claims": ..., "disclosable": ...}``. ``claims`` carries
    ``sub`` (the agent), ``iat`` and ``exp`` (the grant's), ``cnf`` with the
    agent's public key (RFC 7800 section 3.2) and the two open mandates: the
    merchants, the currency and the amount ceiling the grant allows.
    ``disclosable`` holds ``agent_passport``, the passport reference the grant
    is bound to (issuer, attestation id, hash, key thumbprint), which the
    caller issues as a selectively disclosable claim (RFC 9901 section 4.2) so
    a verifier learns it only when the holder discloses it.

    ``agent_jwk`` must be the key the grant is bound to (``cnf.jkt``) and
    public. Phase 1 preview.

    The names of the mandate objects and their members (``checkout_mandate``,
    ``payment_mandate``, ``mode``, ``currency``, ``max_amount_minor``,
    ``expires_at``, ``merchants``, ``payees``) are placeholders chosen here:
    they have not been checked against a section of the AP2 v0.2 text and
    are not its wire format. Map them to AP2's member names before sending a
    mandate to an AP2 party (FINDINGS G-137). ``sub``, ``iat``, ``exp`` and
    ``cnf`` are the registered JWT claims and RFC 7800's.
    """
    if any(member in agent_jwk for member in PRIVATE_MEMBERS):
        raise ValueError("agent_jwk must be a public key")
    cnf = grant_claims.get("cnf")
    jkt = cnf.get("jkt") if isinstance(cnf, Mapping) else None
    if not isinstance(jkt, str) or jwk_thumbprint(agent_jwk) != jkt:
        raise ValueError("agent_jwk is not the key the grant is bound to (cnf.jkt)")
    limits = _limits(grant_claims)
    passport = limits["commerce"].get("passport")
    if not isinstance(passport, Mapping):
        raise ValueError("the grant is not bound to an Agent Passport")
    merchants: List[str] = limits["merchants"]
    mandate = {
        "mode": "open",
        "currency": limits["currency"],
        "max_amount_minor": limits["max_minor"],
        "expires_at": int(limits["expires_at"]),
    }
    return {
        "claims": {
            "sub": agent_did,
            "iat": grant_claims.get("iat"),
            "exp": int(limits["expires_at"]),
            "cnf": {"jwk": copy.deepcopy(dict(agent_jwk))},
            "checkout_mandate": dict(mandate, merchants=merchants),
            "payment_mandate": dict(mandate, payees=merchants),
        },
        "disclosable": {"agent_passport": copy.deepcopy(dict(passport))},
    }
