from __future__ import annotations

import json
from typing import Any

import httpx
import jwt
import pytest

from grantex import (
    AgentPrepaidWalletClient,
    PrincipalPrepaidWalletClient,
    generate_dpop_key,
)
from grantex.prepaid_wallets import WalletSpendPoliciesClient


def _client(handler: Any) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_agent_client_sends_dpop_and_preserves_approval_context() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            202,
            json={
                "status": "approval_required",
                "approvalRequestId": "wapr_1",
                "walletId": "pwal_1",
            },
        )

    client = AgentPrepaidWalletClient(
        access_token="access-token",
        private_key=generate_dpop_key(),
        resource_url="https://api.grantex.dev/v1/prepaid-wallets",
        client=_client(handler),
    )
    params = {
        "walletId": "pwal_1",
        "amount": "2500",
        "asset": "USDC",
        "network": "grantex:prepaid",
        "recipient": "merchant:one",
        "resource": "https://merchant.example/pay",
        "scope": "commerce:pay",
        "maxTimeoutSeconds": 300,
        "idempotencyKey": "payment-000000000001",
        "merchantId": "org_merchant",
        "purpose": "software",
        "projectId": "project-7",
        "costCenter": "engineering",
    }
    assert client.authorize_payment(params)["status"] == "approval_required"
    request = requests[0]
    assert request.headers["Authorization"] == "DPoP access-token"
    header = jwt.get_unverified_header(request.headers["DPoP"])
    claims = jwt.decode(
        request.headers["DPoP"],
        options={"verify_signature": False},
        algorithms=["ES256"],
    )
    assert header["typ"] == "dpop+jwt"
    assert header["jwk"]["crv"] == "P-256"
    assert claims["htm"] == "POST"
    assert claims["htu"].endswith("/v1/prepaid-wallets/authorizations")
    assert claims["ath"]
    assert json.loads(request.content) == params


def test_principal_client_covers_policy_approval_and_safe_assignment() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("prepaid-wallet-spend-policies"):
            return httpx.Response(200, json={"policies": []})
        if request.url.path.endswith("prepaid-wallet-payment-approvals"):
            return httpx.Response(200, json={"approvals": []})
        return httpx.Response(200, json={"ok": True})

    client = PrincipalPrepaidWalletClient(
        base_url="https://api.grantex.dev",
        session_token="principal-session",
        client=_client(handler),
    )
    assignment = {
        "agentId": "agt_1",
        "perTransactionLimit": "1000",
        "cumulativeLimit": "10000",
        "cumulativePeriodSeconds": 86400,
        "allowedRecipients": ["merchant:one"],
        "allowedScopes": ["commerce:pay"],
        "allowedResourceOrigins": ["https://merchant.example"],
    }
    client.assign("pwal/1", assignment)
    client.create_spend_policy(
        {
            "name": "Daily team cap",
            "scopeType": "group",
            "scopeId": "engineering",
            "effect": "limit",
            "maxAmount": "50000",
            "windowType": "calendar_day",
            "onExceed": "require_approval",
        }
    )
    assert client.list_spend_policies() == []
    assert client.list_payment_approvals() == []
    client.decide_payment_approval("wapr_1", "approved", "Owner approved")
    assert all(
        request.headers["Authorization"] == "Bearer principal-session"
        for request in requests
    )
    assert requests[0].url.raw_path.endswith(b"/pwal%2F1/assignments")
    assert json.loads(requests[0].content) == assignment


def test_developer_policy_resource_uses_shared_http_client(mocker: Any) -> None:
    http = mocker.Mock()
    http.post.return_value = {"policyId": "wspol_1"}
    http.get.return_value = {"policies": [{"policyId": "wspol_1"}]}
    http.patch.return_value = {"policyId": "wspol_1", "status": "disabled"}
    policies = WalletSpendPoliciesClient(http)
    assert (
        policies.create(
            {"name": "Org deny", "scopeType": "developer", "effect": "deny"}
        )["policyId"]
        == "wspol_1"
    )
    assert len(policies.list()) == 1
    assert policies.set_status("wspol_1", "disabled")["status"] == "disabled"


def test_wallet_clients_reject_insecure_remote_or_credentialed_urls() -> None:
    with pytest.raises(ValueError, match="must use HTTPS"):
        PrincipalPrepaidWalletClient(
            base_url="http://api.example", session_token="principal-session"
        )
    with pytest.raises(ValueError, match="must not contain credentials"):
        PrincipalPrepaidWalletClient(
            base_url="https://user:password@api.example",
            session_token="principal-session",
        )
    with pytest.raises(ValueError, match="must use HTTPS"):
        AgentPrepaidWalletClient(
            access_token="token",
            private_key=generate_dpop_key(),
            resource_url="http://api.example/v1/prepaid-wallets",
        )
