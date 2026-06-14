from __future__ import annotations

import json

import httpx
import pytest
import respx

from grantex import Grantex, GrantexAuthError

BASE_URL = "http://test.local"
MERCHANT_ID = "mch_shopify_mgx0n6_22"


def test_commerce_client_present() -> None:
    client = Grantex(api_key="test-key", base_url=BASE_URL)
    assert client.commerce is not None


@respx.mock
def test_get_profile_requests_discovery_profile() -> None:
    route = respx.get(
        f"{BASE_URL}/.well-known/grantex-commerce",
        params={"merchant_id": MERCHANT_ID},
    ).mock(
        return_value=httpx.Response(
            200,
            json={
                "version": "grantex-commerce-v1",
                "merchant": {"merchant_id": MERCHANT_ID},
                "supported_tools": ["catalog.search"],
                "capabilities": [{"name": "catalog.search"}],
            },
        )
    )

    client = Grantex(api_key="test-key", base_url=BASE_URL)
    profile = client.commerce.get_profile(merchant_id=MERCHANT_ID)

    assert profile["merchant"]["merchant_id"] == MERCHANT_ID
    assert profile["supported_tools"] == ["catalog.search"]
    assert route.called


@respx.mock
def test_search_catalog_posts_body() -> None:
    route = respx.post(f"{BASE_URL}/v1/commerce/catalog/search").mock(
        return_value=httpx.Response(200, json={"items": [{"product_id": "prod_1"}]})
    )

    client = Grantex(api_key="test-key", base_url=BASE_URL)
    result = client.commerce.search_catalog({"merchant_id": MERCHANT_ID, "query": "lamp", "limit": 1})

    assert result["items"][0]["product_id"] == "prod_1"
    body = json.loads(route.calls[0].request.content)
    assert body["merchant_id"] == MERCHANT_ID
    assert body["query"] == "lamp"


@respx.mock
def test_create_cart_sends_idempotency_header_not_body() -> None:
    route = respx.post(f"{BASE_URL}/v1/commerce/carts").mock(
        return_value=httpx.Response(201, json={"data": {"cart_id": "cart_1"}})
    )

    client = Grantex(api_key="test-key", base_url=BASE_URL)
    client.commerce.create_cart(
        {"merchant_id": MERCHANT_ID, "currency": "INR", "line_items": []},
        idempotency_key="idem-cart-1",
    )

    request = route.calls[0].request
    assert request.headers["idempotency-key"] == "idem-cart-1"
    body = json.loads(request.content)
    assert "idempotency_key" not in body
    assert "idempotencyKey" not in body


@respx.mock
def test_nested_commerce_error_envelope_is_exposed() -> None:
    respx.post(f"{BASE_URL}/v1/webhooks/providers/plural").mock(
        return_value=httpx.Response(
            401,
            json={
                "error": {
                    "code": "webhook_signature_invalid",
                    "message": "Plural webhook signature headers are missing",
                }
            },
        )
    )

    client = Grantex(api_key="test-key", base_url=BASE_URL, max_retries=0)
    with pytest.raises(GrantexAuthError) as exc_info:
        client.commerce.handle_provider_webhook("plural", {})

    assert exc_info.value.status_code == 401
    assert exc_info.value.code == "webhook_signature_invalid"
    assert str(exc_info.value).endswith("Plural webhook signature headers are missing")
