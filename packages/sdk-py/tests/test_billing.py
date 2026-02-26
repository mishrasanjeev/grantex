from __future__ import annotations

import respx
import httpx

from grantex import Grantex
from grantex._types import CreateCheckoutParams, CreatePortalParams

BASE_URL = "http://test.local"

MOCK_SUBSCRIPTION = {
    "plan": "pro",
    "status": "active",
    "currentPeriodEnd": "2026-12-31T00:00:00Z",
}


@respx.mock
def test_get_subscription_returns_status() -> None:
    respx.get(f"{BASE_URL}/v1/billing/subscription").mock(
        return_value=httpx.Response(200, json=MOCK_SUBSCRIPTION)
    )

    client = Grantex(api_key="test_key", base_url=BASE_URL)
    result = client.billing.get_subscription()

    assert result.plan == "pro"
    assert result.status == "active"
    assert result.current_period_end == "2026-12-31T00:00:00Z"


@respx.mock
def test_get_subscription_defaults_to_free() -> None:
    respx.get(f"{BASE_URL}/v1/billing/subscription").mock(
        return_value=httpx.Response(200, json={"plan": "free", "status": "active", "currentPeriodEnd": None})
    )

    client = Grantex(api_key="test_key", base_url=BASE_URL)
    result = client.billing.get_subscription()

    assert result.plan == "free"
    assert result.current_period_end is None


@respx.mock
def test_create_checkout_posts_correct_body() -> None:
    respx.post(f"{BASE_URL}/v1/billing/checkout").mock(
        return_value=httpx.Response(201, json={"checkoutUrl": "https://checkout.stripe.com/test"})
    )

    client = Grantex(api_key="test_key", base_url=BASE_URL)
    params = CreateCheckoutParams(
        plan="pro",
        success_url="https://app.example.com/success",
        cancel_url="https://app.example.com/cancel",
    )
    result = client.billing.create_checkout(params)

    assert result.checkout_url == "https://checkout.stripe.com/test"
    request = respx.calls.last.request
    import json
    body = json.loads(request.content)
    assert body["plan"] == "pro"
    assert body["successUrl"] == "https://app.example.com/success"
    assert body["cancelUrl"] == "https://app.example.com/cancel"


@respx.mock
def test_create_portal_posts_return_url() -> None:
    respx.post(f"{BASE_URL}/v1/billing/portal").mock(
        return_value=httpx.Response(201, json={"portalUrl": "https://billing.stripe.com/test"})
    )

    client = Grantex(api_key="test_key", base_url=BASE_URL)
    params = CreatePortalParams(return_url="https://app.example.com/settings")
    result = client.billing.create_portal(params)

    assert result.portal_url == "https://billing.stripe.com/test"
    request = respx.calls.last.request
    import json
    body = json.loads(request.content)
    assert body["returnUrl"] == "https://app.example.com/settings"
