from __future__ import annotations

# Commerce V1 is still preview-shaped and returns flexible JSON objects.
# The shared HTTP client returns Any, so this resource intentionally forwards
# decoded JSON dictionaries without schema coercion.
# mypy: disable-error-code=no-any-return

from typing import Any
from urllib.parse import urlencode

from .._http import HttpClient

CommerceRecord = dict[str, Any]


class CommerceClient:
    """Commerce V1/OACP resource client."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def get_profile(self, *, merchant_id: str | None = None) -> CommerceRecord:
        return self._http.get(_path_with_query("/.well-known/grantex-commerce", {"merchant_id": merchant_id}))

    def mcp(self, request: CommerceRecord) -> CommerceRecord:
        return self._http.post("/mcp", request)

    def create_tenant(self, params: CommerceRecord) -> CommerceRecord:
        return self._http.post("/v1/commerce/tenants", params)

    def list_tenants(self) -> CommerceRecord:
        return self._http.get("/v1/commerce/tenants")

    def update_tenant(self, tenant_id: str, params: CommerceRecord) -> CommerceRecord:
        return self._http.patch(f"/v1/commerce/tenants/{_quote(tenant_id)}", params)

    def bind_developer_tenant(self, params: CommerceRecord) -> CommerceRecord:
        return self._http.post("/v1/commerce/developer-tenants", params)

    def create_merchant(self, params: CommerceRecord) -> CommerceRecord:
        return self._http.post("/v1/commerce/merchants", params)

    def get_merchant(self, merchant_id: str) -> CommerceRecord:
        return self._http.get(f"/v1/commerce/merchants/{_quote(merchant_id)}")

    def update_merchant(self, merchant_id: str, params: CommerceRecord) -> CommerceRecord:
        return self._http.patch(f"/v1/commerce/merchants/{_quote(merchant_id)}", params)

    def create_agent(self, params: CommerceRecord) -> CommerceRecord:
        return self._http.post("/v1/commerce/agents", params)

    def list_agents(self, params: CommerceRecord | None = None) -> CommerceRecord:
        return self._http.get(_path_with_query("/v1/commerce/agents", params))

    def get_agent(self, agent_id: str) -> CommerceRecord:
        return self._http.get(f"/v1/commerce/agents/{_quote(agent_id)}")

    def update_agent(self, agent_id: str, params: CommerceRecord) -> CommerceRecord:
        return self._http.patch(f"/v1/commerce/agents/{_quote(agent_id)}", params)

    def create_catalog_product(self, params: CommerceRecord) -> CommerceRecord:
        return self._http.post("/v1/commerce/catalog/products", params)

    def list_catalog_products(self, params: CommerceRecord | None = None) -> CommerceRecord:
        return self._http.get(_path_with_query("/v1/commerce/catalog/products", params))

    def bulk_upsert_catalog_products(self, params: CommerceRecord) -> CommerceRecord:
        return self._http.post("/v1/commerce/catalog/products/bulk", params)

    def get_catalog_product(self, product_id: str, params: CommerceRecord | None = None) -> CommerceRecord:
        return self._http.get(_path_with_query(f"/v1/commerce/catalog/products/{_quote(product_id)}", params))

    def update_catalog_product(
        self,
        product_id: str,
        params: CommerceRecord,
        query: CommerceRecord | None = None,
    ) -> CommerceRecord:
        return self._http.patch(_path_with_query(f"/v1/commerce/catalog/products/{_quote(product_id)}", query), params)

    def delete_catalog_product(self, product_id: str) -> CommerceRecord:
        return self._http.delete(f"/v1/commerce/catalog/products/{_quote(product_id)}")

    def search_catalog(self, params: CommerceRecord) -> CommerceRecord:
        return self._http.post("/v1/commerce/catalog/search", params)

    def list_audit_events(self, params: CommerceRecord | None = None) -> CommerceRecord:
        return self._http.get(_path_with_query("/v1/commerce/audit/events", params))

    def create_cart(self, params: CommerceRecord, *, idempotency_key: str) -> CommerceRecord:
        return self._http.post("/v1/commerce/carts", params, headers=_idempotency_headers(idempotency_key))

    def get_cart(self, cart_id: str) -> CommerceRecord:
        return self._http.get(f"/v1/commerce/carts/{_quote(cart_id)}")

    def create_consent_request(self, params: CommerceRecord) -> CommerceRecord:
        return self._http.post("/v1/commerce/passports/consent-requests", params)

    def exchange_consent_for_passport(self, params: CommerceRecord) -> CommerceRecord:
        return self._http.post("/v1/commerce/passports/exchange", params)

    def list_passports(self) -> CommerceRecord:
        return self._http.get("/v1/commerce/passports")

    def verify_passport(self, params: CommerceRecord) -> CommerceRecord:
        return self._http.post("/v1/commerce/passports/verify", params)

    def revoke_passport(self, params: CommerceRecord) -> CommerceRecord:
        return self._http.post("/v1/commerce/passports/revoke", params)

    def create_policy(self, params: CommerceRecord) -> CommerceRecord:
        return self._http.post("/v1/commerce/policies", params)

    def list_policies(self, params: CommerceRecord | None = None) -> CommerceRecord:
        return self._http.get(_path_with_query("/v1/commerce/policies", params))

    def get_policy(self, policy_id: str) -> CommerceRecord:
        return self._http.get(f"/v1/commerce/policies/{_quote(policy_id)}")

    def activate_policy(self, policy_id: str) -> CommerceRecord:
        return self._http.post(f"/v1/commerce/policies/{_quote(policy_id)}/activate")

    def evaluate_policy(self, params: CommerceRecord) -> CommerceRecord:
        return self._http.post("/v1/commerce/policies/evaluate", params)

    def create_payment_intent(self, params: CommerceRecord, *, idempotency_key: str) -> CommerceRecord:
        return self._http.post("/v1/commerce/payments/intents", params, headers=_idempotency_headers(idempotency_key))

    def list_payment_intents(self, params: CommerceRecord | None = None) -> CommerceRecord:
        return self._http.get(_path_with_query("/v1/commerce/payments/intents", params))

    def get_payment_intent(self, payment_intent_id: str) -> CommerceRecord:
        return self._http.get(f"/v1/commerce/payments/intents/{_quote(payment_intent_id)}")

    def create_checkout_link(
        self,
        payment_intent_id: str,
        params: CommerceRecord,
        *,
        idempotency_key: str,
    ) -> CommerceRecord:
        return self._http.post(
            f"/v1/commerce/payments/intents/{_quote(payment_intent_id)}/checkout-link",
            params,
            headers=_idempotency_headers(idempotency_key),
        )

    def reconcile_payment_intent(self, payment_intent_id: str) -> CommerceRecord:
        return self._http.post(f"/v1/commerce/payments/intents/{_quote(payment_intent_id)}/reconcile")

    def create_provider_credential(self, params: CommerceRecord) -> CommerceRecord:
        return self._http.post("/v1/commerce/provider-credentials", params)

    def list_provider_credentials(self, params: CommerceRecord | None = None) -> CommerceRecord:
        return self._http.get(_path_with_query("/v1/commerce/provider-credentials", params))

    def patch_provider_credential(self, credential_id: str, params: CommerceRecord) -> CommerceRecord:
        return self._http.patch(f"/v1/commerce/provider-credentials/{_quote(credential_id)}", params)

    def validate_provider_credential(self, credential_id: str) -> CommerceRecord:
        return self._http.post(f"/v1/commerce/provider-credentials/{_quote(credential_id)}/validate")

    def create_webhook_source(self, params: CommerceRecord) -> CommerceRecord:
        return self._http.post("/v1/commerce/webhook-sources", params)

    def list_webhook_sources(self, params: CommerceRecord | None = None) -> CommerceRecord:
        return self._http.get(_path_with_query("/v1/commerce/webhook-sources", params))

    def update_webhook_source(self, source_key: str, params: CommerceRecord) -> CommerceRecord:
        return self._http.patch(f"/v1/commerce/webhook-sources/{_quote(source_key)}", params)

    def rotate_webhook_source_secret(self, source_key: str) -> CommerceRecord:
        return self._http.post(f"/v1/commerce/webhook-sources/{_quote(source_key)}/rotate-secret")

    def get_ops_health(self, params: CommerceRecord | None = None) -> CommerceRecord:
        return self._http.get(_path_with_query("/v1/commerce/ops/health", params))

    def list_provider_webhook_events(self, params: CommerceRecord | None = None) -> CommerceRecord:
        return self._http.get(_path_with_query("/v1/commerce/ops/provider-webhook-events", params))

    def replay_provider_webhook_event(self, event_id: str, params: CommerceRecord) -> CommerceRecord:
        return self._http.post(f"/v1/commerce/ops/provider-webhook-events/{_quote(event_id)}/replay", params)

    def handle_provider_webhook(
        self,
        provider_key: str,
        payload: CommerceRecord,
        *,
        headers: dict[str, str] | None = None,
    ) -> CommerceRecord:
        return self._http.post(f"/v1/webhooks/providers/{_quote(provider_key)}", payload, headers=headers)


def _idempotency_headers(idempotency_key: str) -> dict[str, str]:
    return {"Idempotency-Key": idempotency_key}


def _path_with_query(path: str, params: CommerceRecord | None = None) -> str:
    if not params:
        return path
    query = urlencode({k: v for k, v in params.items() if v is not None})
    return f"{path}?{query}" if query else path


def _quote(value: str) -> str:
    from urllib.parse import quote

    return quote(value, safe="")
