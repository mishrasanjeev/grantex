package grantex

import (
	"context"
	"net/url"
)

// CommerceRecord is a flexible Commerce V1 JSON object.
type CommerceRecord map[string]interface{}

// CommerceProfile is the public Commerce V1/OACP merchant discovery profile.
type CommerceProfile struct {
	Version        string           `json:"version,omitempty"`
	Merchant       CommerceRecord   `json:"merchant,omitempty"`
	SupportedTools []string         `json:"supported_tools,omitempty"`
	Capabilities   []CommerceRecord `json:"capabilities,omitempty"`
}

// CommerceDataResponse is the common Commerce response shape for write/read resources.
type CommerceDataResponse struct {
	Data         CommerceRecord `json:"data,omitempty"`
	AuditEventID string         `json:"audit_event_id,omitempty"`
}

// CommerceListResponse is the common Commerce list response shape.
type CommerceListResponse struct {
	Items      []CommerceRecord `json:"items"`
	NextCursor *string          `json:"next_cursor,omitempty"`
}

// CommerceService handles Commerce V1/OACP operations.
type CommerceService struct {
	http *httpClient
}

func (s *CommerceService) GetProfile(ctx context.Context, merchantID string) (*CommerceProfile, error) {
	return unmarshal[CommerceProfile](s.http.get(ctx, pathWithQuery("/.well-known/grantex-commerce", map[string]string{
		"merchant_id": merchantID,
	})))
}

func (s *CommerceService) MCP(ctx context.Context, request CommerceRecord) (*CommerceRecord, error) {
	return unmarshal[CommerceRecord](s.http.post(ctx, "/mcp", request))
}

func (s *CommerceService) CreateTenant(ctx context.Context, params CommerceRecord) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.post(ctx, "/v1/commerce/tenants", params))
}

func (s *CommerceService) ListTenants(ctx context.Context) (*CommerceListResponse, error) {
	return unmarshal[CommerceListResponse](s.http.get(ctx, "/v1/commerce/tenants"))
}

func (s *CommerceService) UpdateTenant(ctx context.Context, tenantID string, params CommerceRecord) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.patch(ctx, "/v1/commerce/tenants/"+url.PathEscape(tenantID), params))
}

func (s *CommerceService) BindDeveloperTenant(ctx context.Context, params CommerceRecord) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.post(ctx, "/v1/commerce/developer-tenants", params))
}

func (s *CommerceService) CreateMerchant(ctx context.Context, params CommerceRecord) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.post(ctx, "/v1/commerce/merchants", params))
}

func (s *CommerceService) GetMerchant(ctx context.Context, merchantID string) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.get(ctx, "/v1/commerce/merchants/"+url.PathEscape(merchantID)))
}

func (s *CommerceService) UpdateMerchant(ctx context.Context, merchantID string, params CommerceRecord) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.patch(ctx, "/v1/commerce/merchants/"+url.PathEscape(merchantID), params))
}

func (s *CommerceService) CreateAgent(ctx context.Context, params CommerceRecord) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.post(ctx, "/v1/commerce/agents", params))
}

func (s *CommerceService) ListAgents(ctx context.Context, params map[string]string) (*CommerceListResponse, error) {
	return unmarshal[CommerceListResponse](s.http.get(ctx, pathWithQuery("/v1/commerce/agents", params)))
}

func (s *CommerceService) GetAgent(ctx context.Context, agentID string) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.get(ctx, "/v1/commerce/agents/"+url.PathEscape(agentID)))
}

func (s *CommerceService) UpdateAgent(ctx context.Context, agentID string, params CommerceRecord) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.patch(ctx, "/v1/commerce/agents/"+url.PathEscape(agentID), params))
}

func (s *CommerceService) CreateCatalogProduct(ctx context.Context, params CommerceRecord) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.post(ctx, "/v1/commerce/catalog/products", params))
}

func (s *CommerceService) ListCatalogProducts(ctx context.Context, params map[string]string) (*CommerceListResponse, error) {
	return unmarshal[CommerceListResponse](s.http.get(ctx, pathWithQuery("/v1/commerce/catalog/products", params)))
}

func (s *CommerceService) BulkUpsertCatalogProducts(ctx context.Context, params CommerceRecord) (*CommerceRecord, error) {
	return unmarshal[CommerceRecord](s.http.post(ctx, "/v1/commerce/catalog/products/bulk", params))
}

func (s *CommerceService) GetCatalogProduct(ctx context.Context, productID string, params map[string]string) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.get(ctx, pathWithQuery("/v1/commerce/catalog/products/"+url.PathEscape(productID), params)))
}

func (s *CommerceService) UpdateCatalogProduct(ctx context.Context, productID string, params CommerceRecord, query map[string]string) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.patch(ctx, pathWithQuery("/v1/commerce/catalog/products/"+url.PathEscape(productID), query), params))
}

func (s *CommerceService) DeleteCatalogProduct(ctx context.Context, productID string) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.del(ctx, "/v1/commerce/catalog/products/"+url.PathEscape(productID)))
}

func (s *CommerceService) SearchCatalog(ctx context.Context, params CommerceRecord) (*CommerceListResponse, error) {
	return unmarshal[CommerceListResponse](s.http.post(ctx, "/v1/commerce/catalog/search", params))
}

func (s *CommerceService) ListAuditEvents(ctx context.Context, params map[string]string) (*CommerceListResponse, error) {
	return unmarshal[CommerceListResponse](s.http.get(ctx, pathWithQuery("/v1/commerce/audit/events", params)))
}

func (s *CommerceService) CreateCart(ctx context.Context, params CommerceRecord, idempotencyKey string) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.postWithHeaders(ctx, "/v1/commerce/carts", params, idempotencyHeaders(idempotencyKey)))
}

func (s *CommerceService) GetCart(ctx context.Context, cartID string) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.get(ctx, "/v1/commerce/carts/"+url.PathEscape(cartID)))
}

func (s *CommerceService) CreateConsentRequest(ctx context.Context, params CommerceRecord) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.post(ctx, "/v1/commerce/passports/consent-requests", params))
}

func (s *CommerceService) ExchangeConsentForPassport(ctx context.Context, params CommerceRecord) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.post(ctx, "/v1/commerce/passports/exchange", params))
}

func (s *CommerceService) ListPassports(ctx context.Context) (*CommerceListResponse, error) {
	return unmarshal[CommerceListResponse](s.http.get(ctx, "/v1/commerce/passports"))
}

func (s *CommerceService) VerifyPassport(ctx context.Context, params CommerceRecord) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.post(ctx, "/v1/commerce/passports/verify", params))
}

func (s *CommerceService) RevokePassport(ctx context.Context, params CommerceRecord) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.post(ctx, "/v1/commerce/passports/revoke", params))
}

func (s *CommerceService) CreatePolicy(ctx context.Context, params CommerceRecord) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.post(ctx, "/v1/commerce/policies", params))
}

func (s *CommerceService) ListPolicies(ctx context.Context, params map[string]string) (*CommerceListResponse, error) {
	return unmarshal[CommerceListResponse](s.http.get(ctx, pathWithQuery("/v1/commerce/policies", params)))
}

func (s *CommerceService) GetPolicy(ctx context.Context, policyID string) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.get(ctx, "/v1/commerce/policies/"+url.PathEscape(policyID)))
}

func (s *CommerceService) ActivatePolicy(ctx context.Context, policyID string) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.post(ctx, "/v1/commerce/policies/"+url.PathEscape(policyID)+"/activate", nil))
}

func (s *CommerceService) EvaluatePolicy(ctx context.Context, params CommerceRecord) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.post(ctx, "/v1/commerce/policies/evaluate", params))
}

func (s *CommerceService) CreatePaymentIntent(ctx context.Context, params CommerceRecord, idempotencyKey string) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.postWithHeaders(ctx, "/v1/commerce/payments/intents", params, idempotencyHeaders(idempotencyKey)))
}

func (s *CommerceService) ListPaymentIntents(ctx context.Context, params map[string]string) (*CommerceListResponse, error) {
	return unmarshal[CommerceListResponse](s.http.get(ctx, pathWithQuery("/v1/commerce/payments/intents", params)))
}

func (s *CommerceService) GetPaymentIntent(ctx context.Context, paymentIntentID string) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.get(ctx, "/v1/commerce/payments/intents/"+url.PathEscape(paymentIntentID)))
}

func (s *CommerceService) CreateCheckoutLink(ctx context.Context, paymentIntentID string, params CommerceRecord, idempotencyKey string) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.postWithHeaders(ctx, "/v1/commerce/payments/intents/"+url.PathEscape(paymentIntentID)+"/checkout-link", params, idempotencyHeaders(idempotencyKey)))
}

func (s *CommerceService) ReconcilePaymentIntent(ctx context.Context, paymentIntentID string) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.post(ctx, "/v1/commerce/payments/intents/"+url.PathEscape(paymentIntentID)+"/reconcile", nil))
}

func (s *CommerceService) CreateProviderCredential(ctx context.Context, params CommerceRecord) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.post(ctx, "/v1/commerce/provider-credentials", params))
}

func (s *CommerceService) ListProviderCredentials(ctx context.Context, params map[string]string) (*CommerceListResponse, error) {
	return unmarshal[CommerceListResponse](s.http.get(ctx, pathWithQuery("/v1/commerce/provider-credentials", params)))
}

func (s *CommerceService) PatchProviderCredential(ctx context.Context, credentialID string, params CommerceRecord) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.patch(ctx, "/v1/commerce/provider-credentials/"+url.PathEscape(credentialID), params))
}

func (s *CommerceService) ValidateProviderCredential(ctx context.Context, credentialID string) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.post(ctx, "/v1/commerce/provider-credentials/"+url.PathEscape(credentialID)+"/validate", nil))
}

func (s *CommerceService) CreateWebhookSource(ctx context.Context, params CommerceRecord) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.post(ctx, "/v1/commerce/webhook-sources", params))
}

func (s *CommerceService) ListWebhookSources(ctx context.Context, params map[string]string) (*CommerceListResponse, error) {
	return unmarshal[CommerceListResponse](s.http.get(ctx, pathWithQuery("/v1/commerce/webhook-sources", params)))
}

func (s *CommerceService) UpdateWebhookSource(ctx context.Context, sourceKey string, params CommerceRecord) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.patch(ctx, "/v1/commerce/webhook-sources/"+url.PathEscape(sourceKey), params))
}

func (s *CommerceService) RotateWebhookSourceSecret(ctx context.Context, sourceKey string) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.post(ctx, "/v1/commerce/webhook-sources/"+url.PathEscape(sourceKey)+"/rotate-secret", nil))
}

func (s *CommerceService) GetOpsHealth(ctx context.Context, params map[string]string) (*CommerceRecord, error) {
	return unmarshal[CommerceRecord](s.http.get(ctx, pathWithQuery("/v1/commerce/ops/health", params)))
}

func (s *CommerceService) ListProviderWebhookEvents(ctx context.Context, params map[string]string) (*CommerceListResponse, error) {
	return unmarshal[CommerceListResponse](s.http.get(ctx, pathWithQuery("/v1/commerce/ops/provider-webhook-events", params)))
}

func (s *CommerceService) ReplayProviderWebhookEvent(ctx context.Context, eventID string, params CommerceRecord) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.post(ctx, "/v1/commerce/ops/provider-webhook-events/"+url.PathEscape(eventID)+"/replay", params))
}

func (s *CommerceService) HandleProviderWebhook(ctx context.Context, providerKey string, payload CommerceRecord, headers map[string]string) (*CommerceDataResponse, error) {
	return unmarshal[CommerceDataResponse](s.http.postWithHeaders(ctx, "/v1/webhooks/providers/"+url.PathEscape(providerKey), payload, headers))
}

func idempotencyHeaders(idempotencyKey string) map[string]string {
	return map[string]string{"Idempotency-Key": idempotencyKey}
}

func pathWithQuery(path string, params map[string]string) string {
	if len(params) == 0 {
		return path
	}
	values := url.Values{}
	for key, value := range params {
		if value != "" {
			values.Set(key, value)
		}
	}
	if encoded := values.Encode(); encoded != "" {
		return path + "?" + encoded
	}
	return path
}
