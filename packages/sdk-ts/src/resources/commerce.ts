import type { HttpClient, RequestOptions } from '../http.js';

export type CommerceEnvironment = 'sandbox' | 'live';
export type CommerceProviderKey = 'mock' | 'plural';
export type CommercePassportType = 'browse' | 'checkout';
export type CommercePaymentStatus =
  | 'created'
  | 'authorized'
  | 'checkout_created'
  | 'payment_pending'
  | 'paid'
  | 'failed'
  | 'cancelled'
  | 'expired';

export type CommerceRecord = Record<string, unknown>;

export interface CommerceDataResponse<T = CommerceRecord> {
  data: T;
  audit_event_id?: string;
  [key: string]: unknown;
}

export interface CommerceListResponse<T = CommerceRecord> {
  items: T[];
  next_cursor?: string | null;
  [key: string]: unknown;
}

export interface CommerceProfile extends CommerceRecord {
  version?: string;
  merchant?: CommerceRecord & {
    merchant_id?: string;
    display_name?: string;
    environment?: CommerceEnvironment;
    default_currency?: string;
    country_code?: string;
  };
  supported_tools?: string[];
  capabilities?: unknown[];
}

export interface CommerceIdempotentRequest {
  idempotencyKey: string;
}

export interface CommerceTenantCreateParams extends CommerceRecord {
  tenant_id?: string;
  display_name?: string;
}

export interface CommerceTenantUpdateParams extends CommerceRecord {
  display_name?: string;
  status?: 'active' | 'disabled';
}

export interface CommerceDeveloperTenantBindParams extends CommerceRecord {
  developer_id: string;
  tenant_id: string;
  role?: string;
}

export interface CommerceMerchantCreateParams extends CommerceRecord {
  display_name: string;
  category_preset: string;
  environment?: CommerceEnvironment;
  default_currency?: string;
  country_code?: string;
  agentic_commerce_requested?: boolean;
}

export interface CommerceMerchantUpdateParams extends CommerceRecord {
  display_name?: string;
  category_preset?: string;
  default_currency?: string;
  country_code?: string;
  agentic_commerce_requested?: boolean;
  agentic_commerce_enabled?: boolean;
}

export interface CommerceAgentCreateParams extends CommerceRecord {
  merchant_id: string;
  display_name: string;
  agentic_org_agent_id?: string;
  trust_status?: string;
}

export interface CommerceAgentUpdateParams extends CommerceRecord {
  display_name?: string;
  trust_status?: string;
  disabled?: boolean;
}

export interface CommerceCatalogVariantInput extends CommerceRecord {
  sku: string;
  price_amount: number;
  currency?: string;
  availability_status?: 'in_stock' | 'out_of_stock' | 'pre_order' | 'back_order' | 'unknown';
}

export interface CommerceCatalogProductCreateParams extends CommerceRecord {
  merchant_id: string;
  product_id: string;
  title: string;
  category_preset: string;
  variants: CommerceCatalogVariantInput[];
}

export interface CommerceCatalogProductUpdateParams extends CommerceRecord {
  title?: string;
  brand?: string | null;
  description?: string | null;
  image_url?: string | null;
  category_preset?: string;
  status?: 'active' | 'archived';
  variants?: CommerceRecord[];
}

export interface CommerceCatalogProductListParams {
  merchant_id?: string;
  query?: string;
  category_preset?: string;
  status?: 'active' | 'archived' | 'all';
  limit?: number;
  cursor?: string;
}

export interface CommerceCatalogSearchParams extends CommerceRecord {
  merchant_id?: string;
  query?: string;
  filters?: CommerceRecord;
  limit?: number;
  cursor?: string;
}

export interface CommerceCartCreateParams extends CommerceIdempotentRequest {
  merchant_id: string;
  currency: string;
  line_items: Array<{ variant_id: string; quantity: number }>;
  agent_id?: string;
}

export interface CommerceConsentRequestCreateParams extends CommerceRecord {
  merchant_id: string;
  passport_type: CommercePassportType;
  requested_scopes?: string[];
  max_amount?: number;
  currency?: string;
  user_principal_hint?: string;
  ttl_seconds?: number;
}

export interface CommerceConsentExchangeParams {
  consent_request_id: string;
}

export interface CommercePassportVerifyParams {
  passport_jwt: string;
  mode?: 'read_only' | 'payment_affecting';
  expected_merchant_id?: string;
}

export interface CommercePassportRevokeParams {
  jti: string;
  reason?: string;
}

export interface CommercePolicyCreateParams extends CommerceRecord {
  merchant_id: string;
  rules: CommerceRecord;
}

export interface CommercePolicyEvaluateParams extends CommerceRecord {
  merchant_id: string;
  agent_id: string;
  passport_jwt: string;
  action_scope: string;
  amount_minor_units?: number;
  currency?: string;
}

export interface CommercePaymentIntentCreateParams extends CommerceIdempotentRequest {
  merchant_id: string;
  cart_id: string;
  passport_jwt: string;
  amount_minor_units: number;
  currency: string;
  provider_key?: CommerceProviderKey;
  agent_id?: string;
  metadata?: CommerceRecord;
}

export interface CommercePaymentIntentListParams {
  merchant_id?: string;
  status?: CommercePaymentStatus;
  limit?: number;
}

export interface CommerceCheckoutLinkCreateParams extends CommerceIdempotentRequest {
  passport_jwt: string;
  success_url: string;
  cancel_url: string;
}

export interface CommerceProviderCredentialCreateParams extends CommerceRecord {
  merchant_id: string;
  provider_key: CommerceProviderKey;
  environment: CommerceEnvironment;
  credential_payload: CommerceRecord;
}

export interface CommerceProviderCredentialPatchParams extends CommerceRecord {
  credential_payload?: CommerceRecord;
  status?: 'disabled';
}

export interface CommerceProviderCredentialListParams {
  merchant_id?: string;
  provider_key?: CommerceProviderKey;
  environment?: CommerceEnvironment;
}

export interface CommerceWebhookSourceCreateParams extends CommerceRecord {
  merchant_id: string;
  source_key: string;
  display_name: string;
}

export interface CommerceWebhookSourceListParams {
  merchant_id?: string;
}

export interface CommerceOpsHealthParams {
  merchant_id?: string;
  environment?: CommerceEnvironment;
}

export interface CommerceProviderWebhookEventListParams {
  merchant_id?: string;
  processing_status?: 'received' | 'processed' | 'ignored' | 'failed';
  provider_key?: CommerceProviderKey;
  limit?: number;
}

export interface CommerceProviderWebhookReplayParams {
  reason: string;
  dry_run?: boolean;
}

export interface CommerceMcpJsonRpcRequest extends CommerceRecord {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: CommerceRecord;
}

export class CommerceClient {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  getProfile(params?: { merchantId?: string }): Promise<CommerceProfile> {
    return this.#http.get<CommerceProfile>(
      pathWithQuery('/.well-known/grantex-commerce', { merchant_id: params?.merchantId }),
    );
  }

  mcp(request: CommerceMcpJsonRpcRequest): Promise<CommerceRecord> {
    return this.#http.post<CommerceRecord>('/mcp', request);
  }

  createTenant(params: CommerceTenantCreateParams): Promise<CommerceDataResponse> {
    return this.#http.post<CommerceDataResponse>('/v1/commerce/tenants', params);
  }

  listTenants(): Promise<CommerceListResponse> {
    return this.#http.get<CommerceListResponse>('/v1/commerce/tenants');
  }

  updateTenant(tenantId: string, params: CommerceTenantUpdateParams): Promise<CommerceDataResponse> {
    return this.#http.patch<CommerceDataResponse>(
      `/v1/commerce/tenants/${encodeURIComponent(tenantId)}`,
      params,
    );
  }

  bindDeveloperTenant(params: CommerceDeveloperTenantBindParams): Promise<CommerceDataResponse> {
    return this.#http.post<CommerceDataResponse>('/v1/commerce/developer-tenants', params);
  }

  createMerchant(params: CommerceMerchantCreateParams): Promise<CommerceDataResponse> {
    return this.#http.post<CommerceDataResponse>('/v1/commerce/merchants', params);
  }

  getMerchant(merchantId: string): Promise<CommerceDataResponse> {
    return this.#http.get<CommerceDataResponse>(
      `/v1/commerce/merchants/${encodeURIComponent(merchantId)}`,
    );
  }

  updateMerchant(merchantId: string, params: CommerceMerchantUpdateParams): Promise<CommerceDataResponse> {
    return this.#http.patch<CommerceDataResponse>(
      `/v1/commerce/merchants/${encodeURIComponent(merchantId)}`,
      params,
    );
  }

  createAgent(params: CommerceAgentCreateParams): Promise<CommerceDataResponse> {
    return this.#http.post<CommerceDataResponse>('/v1/commerce/agents', params);
  }

  listAgents(params?: { merchant_id?: string; limit?: number; cursor?: string }): Promise<CommerceListResponse> {
    return this.#http.get<CommerceListResponse>(pathWithQuery('/v1/commerce/agents', params));
  }

  getAgent(agentId: string): Promise<CommerceDataResponse> {
    return this.#http.get<CommerceDataResponse>(
      `/v1/commerce/agents/${encodeURIComponent(agentId)}`,
    );
  }

  updateAgent(agentId: string, params: CommerceAgentUpdateParams): Promise<CommerceDataResponse> {
    return this.#http.patch<CommerceDataResponse>(
      `/v1/commerce/agents/${encodeURIComponent(agentId)}`,
      params,
    );
  }

  createCatalogProduct(params: CommerceCatalogProductCreateParams): Promise<CommerceDataResponse> {
    return this.#http.post<CommerceDataResponse>('/v1/commerce/catalog/products', params);
  }

  listCatalogProducts(params: CommerceCatalogProductListParams): Promise<CommerceListResponse> {
    return this.#http.get<CommerceListResponse>(pathWithQuery('/v1/commerce/catalog/products', params));
  }

  bulkUpsertCatalogProducts(params: CommerceRecord): Promise<CommerceRecord> {
    return this.#http.post<CommerceRecord>('/v1/commerce/catalog/products/bulk', params);
  }

  getCatalogProduct(productId: string, params?: { merchant_id?: string }): Promise<CommerceDataResponse> {
    return this.#http.get<CommerceDataResponse>(
      pathWithQuery(`/v1/commerce/catalog/products/${encodeURIComponent(productId)}`, params),
    );
  }

  updateCatalogProduct(
    productId: string,
    params: CommerceCatalogProductUpdateParams,
    query?: { merchant_id?: string },
  ): Promise<CommerceDataResponse> {
    return this.#http.patch<CommerceDataResponse>(
      pathWithQuery(`/v1/commerce/catalog/products/${encodeURIComponent(productId)}`, query),
      params,
    );
  }

  deleteCatalogProduct(productId: string): Promise<CommerceDataResponse> {
    return this.#http.delete<CommerceDataResponse>(
      `/v1/commerce/catalog/products/${encodeURIComponent(productId)}`,
    );
  }

  searchCatalog(params: CommerceCatalogSearchParams): Promise<CommerceListResponse> {
    return this.#http.post<CommerceListResponse>('/v1/commerce/catalog/search', params);
  }

  listAuditEvents(params?: CommerceRecord): Promise<CommerceListResponse> {
    return this.#http.get<CommerceListResponse>(pathWithQuery('/v1/commerce/audit/events', params));
  }

  createCart(params: CommerceCartCreateParams): Promise<CommerceDataResponse> {
    const { idempotencyKey, ...body } = params;
    return this.#http.post<CommerceDataResponse>(
      '/v1/commerce/carts',
      body,
      idempotencyOptions(idempotencyKey),
    );
  }

  getCart(cartId: string): Promise<CommerceDataResponse> {
    return this.#http.get<CommerceDataResponse>(`/v1/commerce/carts/${encodeURIComponent(cartId)}`);
  }

  createConsentRequest(params: CommerceConsentRequestCreateParams): Promise<CommerceDataResponse> {
    return this.#http.post<CommerceDataResponse>('/v1/commerce/passports/consent-requests', params);
  }

  exchangeConsentForPassport(params: CommerceConsentExchangeParams): Promise<CommerceDataResponse> {
    return this.#http.post<CommerceDataResponse>('/v1/commerce/passports/exchange', params);
  }

  listPassports(): Promise<CommerceListResponse> {
    return this.#http.get<CommerceListResponse>('/v1/commerce/passports');
  }

  verifyPassport(params: CommercePassportVerifyParams): Promise<CommerceDataResponse> {
    return this.#http.post<CommerceDataResponse>('/v1/commerce/passports/verify', params);
  }

  revokePassport(params: CommercePassportRevokeParams): Promise<CommerceDataResponse> {
    return this.#http.post<CommerceDataResponse>('/v1/commerce/passports/revoke', params);
  }

  createPolicy(params: CommercePolicyCreateParams): Promise<CommerceDataResponse> {
    return this.#http.post<CommerceDataResponse>('/v1/commerce/policies', params);
  }

  listPolicies(params?: { merchant_id?: string; status?: string; limit?: number }): Promise<CommerceListResponse> {
    return this.#http.get<CommerceListResponse>(pathWithQuery('/v1/commerce/policies', params));
  }

  getPolicy(policyId: string): Promise<CommerceDataResponse> {
    return this.#http.get<CommerceDataResponse>(`/v1/commerce/policies/${encodeURIComponent(policyId)}`);
  }

  activatePolicy(policyId: string): Promise<CommerceDataResponse> {
    return this.#http.post<CommerceDataResponse>(
      `/v1/commerce/policies/${encodeURIComponent(policyId)}/activate`,
    );
  }

  evaluatePolicy(params: CommercePolicyEvaluateParams): Promise<CommerceDataResponse> {
    return this.#http.post<CommerceDataResponse>('/v1/commerce/policies/evaluate', params);
  }

  createPaymentIntent(params: CommercePaymentIntentCreateParams): Promise<CommerceDataResponse> {
    const { idempotencyKey, ...body } = params;
    return this.#http.post<CommerceDataResponse>(
      '/v1/commerce/payments/intents',
      body,
      idempotencyOptions(idempotencyKey),
    );
  }

  listPaymentIntents(params?: CommercePaymentIntentListParams): Promise<CommerceListResponse> {
    return this.#http.get<CommerceListResponse>(pathWithQuery('/v1/commerce/payments/intents', params));
  }

  getPaymentIntent(paymentIntentId: string): Promise<CommerceDataResponse> {
    return this.#http.get<CommerceDataResponse>(
      `/v1/commerce/payments/intents/${encodeURIComponent(paymentIntentId)}`,
    );
  }

  createCheckoutLink(
    paymentIntentId: string,
    params: CommerceCheckoutLinkCreateParams,
  ): Promise<CommerceDataResponse> {
    const { idempotencyKey, ...body } = params;
    return this.#http.post<CommerceDataResponse>(
      `/v1/commerce/payments/intents/${encodeURIComponent(paymentIntentId)}/checkout-link`,
      body,
      idempotencyOptions(idempotencyKey),
    );
  }

  reconcilePaymentIntent(paymentIntentId: string): Promise<CommerceDataResponse> {
    return this.#http.post<CommerceDataResponse>(
      `/v1/commerce/payments/intents/${encodeURIComponent(paymentIntentId)}/reconcile`,
    );
  }

  createProviderCredential(params: CommerceProviderCredentialCreateParams): Promise<CommerceDataResponse> {
    return this.#http.post<CommerceDataResponse>('/v1/commerce/provider-credentials', params);
  }

  listProviderCredentials(params?: CommerceProviderCredentialListParams): Promise<CommerceListResponse> {
    return this.#http.get<CommerceListResponse>(
      pathWithQuery('/v1/commerce/provider-credentials', params),
    );
  }

  patchProviderCredential(
    credentialId: string,
    params: CommerceProviderCredentialPatchParams,
  ): Promise<CommerceDataResponse> {
    return this.#http.patch<CommerceDataResponse>(
      `/v1/commerce/provider-credentials/${encodeURIComponent(credentialId)}`,
      params,
    );
  }

  validateProviderCredential(credentialId: string): Promise<CommerceDataResponse> {
    return this.#http.post<CommerceDataResponse>(
      `/v1/commerce/provider-credentials/${encodeURIComponent(credentialId)}/validate`,
    );
  }

  createWebhookSource(params: CommerceWebhookSourceCreateParams): Promise<CommerceDataResponse> {
    return this.#http.post<CommerceDataResponse>('/v1/commerce/webhook-sources', params);
  }

  listWebhookSources(params?: CommerceWebhookSourceListParams): Promise<CommerceListResponse> {
    return this.#http.get<CommerceListResponse>(pathWithQuery('/v1/commerce/webhook-sources', params));
  }

  updateWebhookSource(sourceKey: string, params: CommerceRecord): Promise<CommerceDataResponse> {
    return this.#http.patch<CommerceDataResponse>(
      `/v1/commerce/webhook-sources/${encodeURIComponent(sourceKey)}`,
      params,
    );
  }

  rotateWebhookSourceSecret(sourceKey: string): Promise<CommerceDataResponse> {
    return this.#http.post<CommerceDataResponse>(
      `/v1/commerce/webhook-sources/${encodeURIComponent(sourceKey)}/rotate-secret`,
    );
  }

  getOpsHealth(params?: CommerceOpsHealthParams): Promise<CommerceRecord> {
    return this.#http.get<CommerceRecord>(pathWithQuery('/v1/commerce/ops/health', params));
  }

  listProviderWebhookEvents(params?: CommerceProviderWebhookEventListParams): Promise<CommerceListResponse> {
    return this.#http.get<CommerceListResponse>(
      pathWithQuery('/v1/commerce/ops/provider-webhook-events', params),
    );
  }

  replayProviderWebhookEvent(
    eventId: string,
    params: CommerceProviderWebhookReplayParams,
  ): Promise<CommerceDataResponse> {
    return this.#http.post<CommerceDataResponse>(
      `/v1/commerce/ops/provider-webhook-events/${encodeURIComponent(eventId)}/replay`,
      params,
    );
  }

  handleProviderWebhook(
    providerKey: CommerceProviderKey,
    payload: CommerceRecord,
    options?: { headers?: Record<string, string> },
  ): Promise<CommerceDataResponse> {
    return this.#http.post<CommerceDataResponse>(
      `/v1/webhooks/providers/${encodeURIComponent(providerKey)}`,
      payload,
      options,
    );
  }
}

function idempotencyOptions(idempotencyKey: string): RequestOptions {
  return { headers: { 'Idempotency-Key': idempotencyKey } };
}

function pathWithQuery(path: string, params?: object): string {
  const query = buildQuery(params);
  return query ? `${path}?${query}` : path;
}

function buildQuery(params?: object): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params) as Array<[string, unknown]>) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  return search.toString();
}
