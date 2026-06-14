import type { FastifyInstance, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import { getSql, type TxSql } from '../db/client.js';
import { getRedis } from '../redis/client.js';
import { CommerceHttpError } from '../lib/commerce/errors.js';
import { appendCommerceAudit } from '../lib/commerce/audit.js';
import {
  newCommerceCartId,
  newCommercePaymentIntentId,
  newCommercePolicyDecisionId,
} from '../lib/commerce/ids.js';
import type { CommerceCaller } from '../lib/commerce/caller.js';
import { stableJson, beginCommerceIdempotency, commitCommerceIdempotencyResult } from '../lib/commerce/idempotency.js';
import { sha256hex } from '../lib/hash.js';
import {
  evaluateCommercePolicyRules,
  isCommercePolicyScope,
  validateCommercePolicyRules,
  type CommercePolicyDecision,
  type CommercePolicyRules,
} from '../lib/commerce/policy.js';
import {
  verifyCommercePassport,
  type VerifiedPassport,
  type VerifyPassportError,
} from '../lib/commerce/passport.js';
import {
  getPaymentProvider,
  isPaymentProviderError,
  type CommerceEnvironment,
  type ProviderKey,
} from '../lib/commerce/payment-providers/index.js';
import { ensureCommerceLiveMode } from '../lib/commerce/live-mode-guard.js';
import {
  assertPaymentStatusTransition,
  type CommercePaymentStatus,
} from '../lib/commerce/payment-state.js';
import {
  reconcilePaymentIntent,
  type PaymentReconciliationResult,
} from '../lib/commerce/payment-reconciliation.js';
import { commerceCriticalFlowTotal } from '../lib/metrics.js';
import { commerceLogContext, hashedReference } from '../lib/commerce/observability.js';

type Sql = ReturnType<typeof postgres>;

function asJson(value: unknown): postgres.JSONValue {
  return value as postgres.JSONValue;
}

function isLocalPublicBaseUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'localhost'
      || hostname === '127.0.0.1'
      || hostname === '::1'
      || hostname === '[::1]';
  } catch {
    return false;
  }
}

function isLocalLoadTestRuntime(): boolean {
  return process.env['COMMERCE_LOCAL_LOAD_TEST'] === 'true'
    && process.env['COMMERCE_LIVE_MODE_ENABLED'] !== 'true'
    && process.env['PLURAL_LIVE_ENABLED'] !== 'true'
    && isLocalPublicBaseUrl(process.env['PUBLIC_BASE_URL']);
}

function isLocalLoadTestClientAddress(value: string | undefined): boolean {
  return value === '127.0.0.1'
    || value === '::1'
    || value === '::ffff:127.0.0.1'
    || (typeof value === 'string' && /^172\.(1[6-9]|2\d|3[0-1])\./.test(value));
}

function localLoadRateLimitAllowList(request: FastifyRequest, key: string): boolean {
  if (!isLocalLoadTestRuntime()) return false;
  return isLocalLoadTestClientAddress(request.ip) && isLocalLoadTestClientAddress(key);
}

interface CartCreateBody {
  merchant_id?: unknown;
  agent_id?: unknown;
  line_items?: unknown;
  currency?: unknown;
}

interface PaymentIntentCreateBody {
  merchant_id?: unknown;
  agent_id?: unknown;
  cart_id?: unknown;
  passport_jwt?: unknown;
  amount_minor_units?: unknown;
  currency?: unknown;
  provider_key?: unknown;
  metadata?: unknown;
}

interface CheckoutLinkCreateBody {
  success_url?: unknown;
  cancel_url?: unknown;
  passport_jwt?: unknown;
}

interface CartLineItemInput {
  variant_id: string;
  quantity: number;
}

interface MerchantContext {
  id: string;
  tenant_id: string;
  environment: CommerceEnvironment;
  default_currency: string;
  agentic_commerce_enabled: boolean;
  disabled_at: Date | string | null;
  tenant_status: 'active' | 'disabled';
}

interface AgentContext {
  id: string;
  tenant_id: string;
  trust_status: string;
  disabled_at: Date | string | null;
}

interface PolicyRow {
  id: string;
  tenant_id: string;
  merchant_id: string;
  version: string;
  rules: unknown;
  status: 'active';
}

interface VariantRow {
  id: string;
  product_id: string;
  product_ref: string;
  title: string;
  sku: string;
  variant_title: string | null;
  attributes: unknown;
  price_amount: number | string;
  currency: string;
  tax_inclusive: boolean;
  gst_slab: string | null;
  tax_rate: string | number | null;
  hsn_code: string | null;
  availability_status: string;
  warranty_summary: string | null;
  return_policy_summary: string | null;
  last_synced_at: Date | string;
}

interface CartRow {
  id: string;
  tenant_id: string;
  merchant_id: string;
  agent_id: string;
  passport_jti: string | null;
  line_items: unknown;
  line_items_snapshot: unknown;
  currency: string;
  subtotal_amount: number | string;
  tax_amount: number | string;
  total_amount: number | string;
  status: 'draft' | 'payment_intent_created' | 'cancelled' | 'expired';
  expires_at: Date | string;
  line_items_snapshot_hash: string;
  idempotency_key_hash: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PaymentIntentRow {
  id: string;
  tenant_id: string;
  merchant_id: string;
  agent_id: string;
  cart_id: string;
  passport_jti: string;
  amount: number | string;
  currency: string;
  provider: ProviderKey;
  provider_environment: CommerceEnvironment;
  provider_payment_id: string | null;
  provider_order_id: string | null;
  checkout_url: string | null;
  checkout_expires_at?: Date | string | null;
  status: CommercePaymentStatus;
  line_items_snapshot: unknown;
  idempotency_key_hash: string;
  provider_metadata: unknown;
  provider_raw_status: string | null;
  policy_version: string | null;
  decision_id: string | null;
  expires_at: Date | string;
  reconciled_at?: Date | string | null;
  last_reconciliation_attempt_at?: Date | string | null;
  last_reconciliation_error?: string | null;
  last_reconciliation_retryable?: boolean | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number.parseInt(v, 10);
  return null;
}

function rowAmount(v: number | string): number {
  const n = typeof v === 'number' ? v : Number.parseInt(v, 10);
  if (!Number.isSafeInteger(n)) throw new Error(`invalid amount from database: ${v}`);
  return n;
}

function tenantIdOrThrow(request: FastifyRequest): string {
  if (!request.commerceTenantId) {
    throw new CommerceHttpError(422, 'tenant_context_required',
      'This commerce endpoint requires a tenant-bound caller', { retryable: false });
  }
  return request.commerceTenantId;
}

function agentCallerOrThrow(request: FastifyRequest): Extract<CommerceCaller, { kind: 'agent' }> {
  if (request.commerceCaller.kind !== 'agent') {
    throw new CommerceHttpError(403, 'agent_required',
      'This endpoint requires a registered CommerceAgent caller');
  }
  return request.commerceCaller;
}

function readIdempotencyKey(request: FastifyRequest): string {
  const raw = request.headers['idempotency-key'];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!isString(key)) {
    throw new CommerceHttpError(400, 'idempotency_key_required',
      'Idempotency-Key header is required for this endpoint', { retryable: false });
  }
  if (key.length > 256) {
    throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
      { details: { fields: { 'Idempotency-Key': 'must be at most 256 characters' } }, retryable: false });
  }
  return key;
}

function parseProviderKey(v: unknown, fieldErrors: Record<string, string>): ProviderKey {
  if (v === undefined || v === null || v === 'mock') return 'mock';
  if (v === 'plural') return 'plural';
  fieldErrors['provider_key'] = 'must be mock or plural';
  return 'mock';
}

function parseLineItems(value: unknown, fieldErrors: Record<string, string>): CartLineItemInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    fieldErrors['line_items'] = 'required non-empty array';
    return [];
  }
  const out: CartLineItemInput[] = [];
  const seen = new Set<string>();
  value.forEach((item, i) => {
    if (!isPlainObject(item)) {
      fieldErrors[`line_items[${i}]`] = 'must be an object';
      return;
    }
    const variantId = item['variant_id'];
    const quantity = asInt(item['quantity']);
    if (!isString(variantId)) fieldErrors[`line_items[${i}].variant_id`] = 'required string';
    if (quantity === null || quantity <= 0) {
      fieldErrors[`line_items[${i}].quantity`] = 'required positive integer';
    }
    if (isString(variantId) && seen.has(variantId)) {
      fieldErrors[`line_items[${i}].variant_id`] = 'duplicate variant_id';
    }
    if (isString(variantId) && quantity !== null && quantity > 0) {
      seen.add(variantId);
      out.push({ variant_id: variantId, quantity });
    }
  });
  return out;
}

async function loadMerchantContext(
  sql: Sql,
  tenantId: string,
  merchantId: string,
): Promise<MerchantContext | null> {
  const rows = await sql<MerchantContext[]>`
    SELECT m.id, m.tenant_id,
           CASE WHEN m.environment = 'live' THEN 'live' ELSE 'sandbox' END AS environment,
           m.default_currency,
           m.agentic_commerce_enabled,
           m.disabled_at,
           CASE WHEN t.status = 'disabled' THEN 'disabled' ELSE 'active' END AS tenant_status
      FROM commerce_merchants m
      JOIN commerce_tenants t ON t.id = m.tenant_id
     WHERE m.id = ${merchantId}
       AND m.tenant_id = ${tenantId}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

async function loadAgentContext(sql: Sql, tenantId: string, agentId: string): Promise<AgentContext | null> {
  const rows = await sql<AgentContext[]>`
    SELECT id, tenant_id, trust_status, disabled_at
      FROM commerce_agents
     WHERE id = ${agentId}
       AND tenant_id = ${tenantId}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

async function loadActivePolicy(sql: Sql, tenantId: string, merchantId: string): Promise<PolicyRow | null> {
  const rows = await sql<PolicyRow[]>`
    SELECT id, tenant_id, merchant_id, version, rules, status
      FROM commerce_policies
     WHERE tenant_id = ${tenantId}
       AND merchant_id = ${merchantId}
       AND status = 'active'
     LIMIT 1
  `;
  return rows[0] ?? null;
}

function validateRulesOrThrow(rulesInput: unknown): CommercePolicyRules {
  const validation = validateCommercePolicyRules(rulesInput);
  if (!validation.ok) {
    throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
      { details: { fields: validation.fieldErrors }, retryable: false });
  }
  return validation.rules;
}

function passportFailureReason(error: VerifyPassportError): string {
  const map: Record<VerifyPassportError['kind'], string> = {
    malformed: 'passport_malformed',
    kid_required: 'passport_kid_required',
    kid_unknown: 'passport_kid_unknown',
    kid_wrong_namespace: 'passport_kid_wrong_namespace',
    kid_retired_iat_after: 'passport_kid_retired',
    kid_retired_window_exceeded: 'passport_kid_retired',
    algorithm_rejected: 'passport_algorithm_rejected',
    signature_invalid: 'passport_signature_invalid',
    expired: 'passport_expired',
    not_yet_valid: 'passport_not_yet_valid',
    wrong_audience: 'passport_wrong_audience',
    wrong_issuer: 'passport_wrong_issuer',
    missing_claims: 'passport_missing_claims',
    temporal_claim_invalid: 'passport_temporal_claim_invalid',
    lifetime_exceeded: 'passport_lifetime_exceeded',
    invalid_passport_type: 'passport_invalid_type',
    revoked: 'passport_revoked',
    revocation_unavailable: 'revocation_unavailable',
    tenant_mismatch: 'tenant_mismatch',
    merchant_mismatch: 'merchant_mismatch',
  };
  return map[error.kind] ?? 'passport_invalid';
}

function passportTtlExceeded(passport: VerifiedPassport, rules: CommercePolicyRules): boolean {
  const ttlSeconds = passport.expiresAt - passport.issuedAt;
  const maxTtl = passport.passportType === 'checkout'
    ? rules.checkout_passport_max_ttl_seconds
    : rules.browse_passport_max_ttl_seconds;
  return ttlSeconds > maxTtl;
}

async function appendIdempotencyConflictAudit(
  sql: Sql,
  request: FastifyRequest,
  input: {
    tenantId: string;
    merchantId: string;
    agentId: string | null;
    idempotencyKeyHash: string;
    endpoint: string;
    recordId: string;
  },
): Promise<string> {
  const audit = await appendCommerceAudit(sql, {
    tenantId: input.tenantId,
    merchantId: input.merchantId,
    agentId: input.agentId,
    eventType: 'idempotency.conflict',
    resourceType: 'commerce_idempotency_record',
    resourceId: input.recordId,
    idempotencyKeyHash: input.idempotencyKeyHash,
    requestId: request.id,
    metadata: { endpoint: input.endpoint },
  });
  return audit.id;
}

async function appendPolicyDenyAudit(
  sql: Sql,
  request: FastifyRequest,
  input: {
    tenantId: string;
    merchantId: string;
    agentId: string;
    policy: PolicyRow;
    decisionId: string;
    decision: CommercePolicyDecision;
    reason: string;
    passportJti?: string | null;
    resourceType: string;
    resourceId: string;
  },
): Promise<string> {
  const audit = await appendCommerceAudit(sql, {
    tenantId: input.tenantId,
    merchantId: input.merchantId,
    agentId: input.agentId,
    eventType: 'policy.evaluated',
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    passportJti: input.passportJti ?? null,
    policyVersion: input.policy.version,
    decisionId: input.decisionId,
    requestId: request.id,
    metadata: {
      decision: input.decision,
      reason: input.reason,
      policy_id: input.policy.id,
    },
  });
  return audit.id;
}

async function throwPolicyDeny(
  sql: Sql,
  request: FastifyRequest,
  input: {
    tenantId: string;
    merchantId: string;
    agentId: string;
    policy: PolicyRow;
    decisionId: string;
    decision?: CommercePolicyDecision;
    reason: string;
    passportJti?: string | null;
    resourceType: string;
    resourceId: string;
  },
): Promise<never> {
  const decision = input.decision ?? 'deny';
  const auditEventId = await appendPolicyDenyAudit(sql, request, { ...input, decision });
  throw new CommerceHttpError(403, input.reason, `Commerce policy denied this action: ${input.reason}`, {
    retryable: false,
    decisionId: input.decisionId,
    auditEventId,
    details: { decision, policy_id: input.policy.id, policy_version: input.policy.version },
  });
}

function normalizeCart(row: CartRow): Record<string, unknown> {
  return {
    id: row.id,
    cart_id: row.id,
    tenant_id: row.tenant_id,
    merchant_id: row.merchant_id,
    agent_id: row.agent_id,
    passport_jti: row.passport_jti,
    line_items: row.line_items,
    line_items_snapshot: row.line_items_snapshot,
    currency: row.currency,
    subtotal_amount: row.subtotal_amount,
    tax_amount: row.tax_amount,
    total_amount: row.total_amount,
    status: row.status,
    expires_at: row.expires_at,
    line_items_snapshot_hash: row.line_items_snapshot_hash,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizePaymentIntent(row: PaymentIntentRow): Record<string, unknown> {
  return {
    id: row.id,
    payment_intent_id: row.id,
    tenant_id: row.tenant_id,
    merchant_id: row.merchant_id,
    agent_id: row.agent_id,
    cart_id: row.cart_id,
    passport_jti: row.passport_jti,
    amount: row.amount,
    amount_minor_units: row.amount,
    currency: row.currency,
    provider: row.provider,
    provider_environment: row.provider_environment,
    provider_payment_id: row.provider_payment_id,
    provider_order_id: row.provider_order_id,
    checkout_url: row.checkout_url,
    checkout_expires_at: row.checkout_expires_at ?? null,
    status: row.status,
    line_items_snapshot: row.line_items_snapshot,
    provider_metadata: row.provider_metadata,
    provider_raw_status: row.provider_raw_status,
    policy_version: row.policy_version,
    decision_id: row.decision_id,
    expires_at: row.expires_at,
    reconciled_at: row.reconciled_at ?? null,
    last_reconciliation_attempt_at: row.last_reconciliation_attempt_at ?? null,
    last_reconciliation_error: row.last_reconciliation_error ?? null,
    last_reconciliation_retryable: row.last_reconciliation_retryable ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeReconciliationResult(result: PaymentReconciliationResult): Record<string, unknown> {
  if (result.kind === 'transitioned') {
    return {
      status: result.kind,
      from_status: result.fromStatus,
      to_status: result.toStatus,
      provider_status: result.providerStatus,
    };
  }
  if (result.kind === 'no_change') {
    return {
      status: result.kind,
      reason: result.reason,
      payment_status: result.status,
      provider_status: result.providerStatus,
    };
  }
  if (result.kind === 'ignored') {
    return {
      status: result.kind,
      reason: result.reason,
      payment_status: result.status,
    };
  }
  if (result.kind === 'invalid_transition') {
    return {
      status: result.kind,
      from_status: result.fromStatus,
      to_status: result.toStatus,
      provider_status: result.providerStatus,
    };
  }
  return {
    status: result.kind,
    provider_error_code: result.error.provider_error_code ?? null,
    retryable: result.error.retryable,
  };
}

function cartReadScope(request: FastifyRequest): {
  allTenant: boolean;
  merchantId: string | null;
  agentId: string | null;
} {
  const caller = request.commerceCaller;
  if (caller.kind === 'operator') return { allTenant: true, merchantId: null, agentId: null };
  if (caller.kind === 'merchant') return { allTenant: false, merchantId: caller.merchantId, agentId: null };
  if (caller.kind === 'agent') return { allTenant: false, merchantId: null, agentId: caller.agentId };
  throw new CommerceHttpError(403, 'caller_not_authorized',
    'This endpoint requires operator, merchant, or CommerceAgent caller');
}

function metadataForProvider(v: unknown): Record<string, string> {
  if (!isPlainObject(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== 'string') continue;
    switch (k) {
      case 'agent_session_id':
        out.agent_session_id = val;
        break;
      case 'cart_reference':
        out.cart_reference = val;
        break;
      case 'customer_reference':
        out.customer_reference = val;
        break;
      case 'order_reference':
        out.order_reference = val;
        break;
      default:
        break;
    }
  }
  return out;
}

function isLocalhost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

function allowLocalhostCheckoutUrl(): boolean {
  return process.env['NODE_ENV'] === 'test' || process.env['NODE_ENV'] === 'development';
}

function parseCheckoutUrl(v: unknown, field: string, fieldErrors: Record<string, string>): string | null {
  if (!isString(v)) {
    fieldErrors[field] = 'required URL string';
    return null;
  }
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    fieldErrors[field] = 'must be a valid URL';
    return null;
  }
  const secure = url.protocol === 'https:';
  const localAllowed = allowLocalhostCheckoutUrl()
    && isLocalhost(url.hostname)
    && (url.protocol === 'http:' || url.protocol === 'https:');
  if (!secure && !localAllowed) {
    fieldErrors[field] = 'must be HTTPS';
    return null;
  }
  return url.toString();
}

function dateLikeToIso(v: Date | string): string {
  if (v instanceof Date) return v.toISOString();
  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return new Date(Date.now() + 15 * 60_000).toISOString();
}

async function loadCartForPayment(sql: Sql, tenantId: string, merchantId: string, cartId: string): Promise<CartRow | null> {
  const rows = await sql<CartRow[]>`
    SELECT id, tenant_id, merchant_id, agent_id, passport_jti,
           line_items, line_items_snapshot, currency, subtotal_amount,
           tax_amount, total_amount, status, expires_at,
           line_items_snapshot_hash, idempotency_key_hash,
           created_at, updated_at
      FROM commerce_carts
     WHERE id = ${cartId}
       AND tenant_id = ${tenantId}
       AND merchant_id = ${merchantId}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function commerceCartPaymentRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: CartCreateBody }>(
    '/carts',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
    const caller = agentCallerOrThrow(request);
    const tenantId = tenantIdOrThrow(request);
    const idempotencyKey = readIdempotencyKey(request);
    const body = request.body ?? {};
    const fieldErrors: Record<string, string> = {};
    if (!isString(body.merchant_id)) fieldErrors['merchant_id'] = 'required string';
    if (!isString(body.currency)) fieldErrors['currency'] = 'required string';
    if (body.agent_id !== undefined && body.agent_id !== caller.agentId) {
      throw new CommerceHttpError(403, 'agent_scope_violation',
        'Agent callers may only create carts for their own agent identity');
    }
    const lineItems = parseLineItems(body.line_items, fieldErrors);
    if (Object.keys(fieldErrors).length > 0) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
        { details: { fields: fieldErrors }, retryable: false });
    }

    const merchantId = body.merchant_id as string;
    const currency = body.currency as string;
    const sql = getSql();
    const merchant = await loadMerchantContext(sql, tenantId, merchantId);
    if (!merchant) throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
    if (merchant.tenant_status !== 'active') {
      throw new CommerceHttpError(403, 'tenant_disabled', 'Commerce tenant is disabled', { retryable: false });
    }
    if (merchant.disabled_at !== null || merchant.agentic_commerce_enabled !== true) {
      throw new CommerceHttpError(403, 'emergency_disabled',
        'Agentic commerce is disabled for this merchant', { retryable: false });
    }
    if (currency !== merchant.default_currency) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
        { details: { fields: { currency: 'must match merchant default currency' } }, retryable: false });
    }

    const idempotencyScope = {
      tenantId,
      merchantId,
      endpoint: 'POST /v1/commerce/carts',
      environment: merchant.environment,
      idempotencyKey,
      requestBody: body,
    };
    const idempotency = await beginCommerceIdempotency(sql, idempotencyScope);
    if (idempotency.kind === 'replay') {
      return reply.status(idempotency.statusCode).send(idempotency.responseBody);
    }
    if (idempotency.kind === 'conflict') {
      const keyHash = sha256hex(idempotencyKey);
      const auditEventId = await appendIdempotencyConflictAudit(sql, request, {
        tenantId,
        merchantId,
        agentId: caller.agentId,
        idempotencyKeyHash: keyHash,
        endpoint: idempotencyScope.endpoint,
        recordId: idempotency.recordId,
      });
      throw new CommerceHttpError(409, 'idempotency_conflict',
        'Idempotency-Key was already used with a different request body',
        { retryable: false, auditEventId });
    }

    const variantIds = lineItems.map((item) => item.variant_id);
    const variantRows = await sql<VariantRow[]>`
      SELECT v.id, v.product_id, p.product_id AS product_ref, p.title,
             v.sku, v.variant_title, v.attributes, v.price_amount,
             v.currency, v.tax_inclusive, v.gst_slab, v.tax_rate,
             v.hsn_code, v.availability_status, v.warranty_summary,
             v.return_policy_summary, v.last_synced_at
        FROM commerce_product_variants v
        JOIN commerce_products p
          ON p.tenant_id = v.tenant_id AND p.id = v.product_id
       WHERE v.tenant_id = ${tenantId}
         AND v.merchant_id = ${merchantId}
         AND v.id = ANY(${variantIds}::text[])
         AND v.archived_at IS NULL
         AND p.archived_at IS NULL
    `;
    const variantsById = new Map(variantRows.map((row) => [row.id, row]));
    const missing = variantIds.filter((id) => !variantsById.has(id));
    if (missing.length > 0) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
        { details: { fields: { line_items: `unknown or archived variant_id: ${missing.join(', ')}` } }, retryable: false });
    }

    const snapshot = lineItems.map((item) => {
      const variant = variantsById.get(item.variant_id)!;
      if (variant.currency !== currency) {
        throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
          { details: { fields: { currency: `variant ${variant.id} currency is ${variant.currency}` } }, retryable: false });
      }
      const unitAmount = rowAmount(variant.price_amount);
      return {
        variant_id: variant.id,
        product_id: variant.product_id,
        product_ref: variant.product_ref,
        title: variant.title,
        sku: variant.sku,
        variant_title: variant.variant_title,
        attributes: variant.attributes,
        quantity: item.quantity,
        unit_amount: unitAmount,
        line_total_amount: unitAmount * item.quantity,
        currency: variant.currency,
        tax_inclusive: variant.tax_inclusive,
        gst_slab: variant.gst_slab,
        tax_rate: variant.tax_rate,
        hsn_code: variant.hsn_code,
        availability_status: variant.availability_status,
        warranty_summary: variant.warranty_summary,
        return_policy_summary: variant.return_policy_summary,
        price_last_synced_at: variant.last_synced_at,
      };
    });
    const subtotal = snapshot.reduce((sum, item) => sum + item.line_total_amount, 0);
    const taxAmount = 0;
    const total = subtotal + taxAmount;
    const cartId = newCommerceCartId();
    const snapshotHash = sha256hex(stableJson(snapshot));

    const responseBody = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      const rows = await tx<CartRow[]>`
        INSERT INTO commerce_carts (
          id, tenant_id, merchant_id, agent_id, passport_jti,
          line_items, line_items_snapshot, currency,
          subtotal_amount, tax_amount, total_amount, status,
          expires_at, line_items_snapshot_hash, idempotency_key_hash
        ) VALUES (
          ${cartId}, ${tenantId}, ${merchantId}, ${caller.agentId}, NULL,
          ${tx.json(asJson(lineItems))},
          ${tx.json(asJson(snapshot))},
          ${currency},
          ${subtotal}, ${taxAmount}, ${total}, ${'draft'},
          NOW() + INTERVAL '24 hours',
          ${snapshotHash},
          ${idempotency.keyHash}
        )
        RETURNING id, tenant_id, merchant_id, agent_id, passport_jti,
                  line_items, line_items_snapshot, currency, subtotal_amount,
                  tax_amount, total_amount, status, expires_at,
                  line_items_snapshot_hash, idempotency_key_hash,
                  created_at, updated_at
      `;
      const cart = rows[0];
      if (!cart) throw new Error('commerce cart insert returned no row');
      const audit = await appendCommerceAudit(tx as unknown as Sql, {
        tenantId,
        merchantId,
        agentId: caller.agentId,
        eventType: 'cart.created',
        resourceType: 'commerce_cart',
        resourceId: cart.id,
        idempotencyKeyHash: idempotency.keyHash,
        requestId: request.id,
        metadata: {
          total_amount: cart.total_amount,
          currency: cart.currency,
          line_item_count: lineItems.length,
        },
      });
      const response = { data: normalizeCart(cart), audit_event_id: audit.id };
      await commitCommerceIdempotencyResult(tx as unknown as Sql, {
        recordId: idempotency.recordId,
        scope: idempotencyScope,
        keyHash: idempotency.keyHash,
        requestBodyHash: idempotency.requestBodyHash,
        statusCode: 201,
        responseBody: response,
      });
      return response;
    });

    commerceCriticalFlowTotal.labels('cart.create', 'success', '').inc();
    request.log.info({ flow: 'cart.create', status: 'draft' }, 'commerce.cart.created');

    return reply.status(201).send(responseBody);
    },
  );

  app.get<{ Params: { cartId: string } }>('/carts/:cartId', async (request, reply) => {
    const tenantId = tenantIdOrThrow(request);
    const scope = cartReadScope(request);
    const sql = getSql();
    const rows = await sql<CartRow[]>`
      SELECT id, tenant_id, merchant_id, agent_id, passport_jti,
             line_items, line_items_snapshot, currency, subtotal_amount,
             tax_amount, total_amount, status, expires_at,
             line_items_snapshot_hash, idempotency_key_hash,
             created_at, updated_at
        FROM commerce_carts
       WHERE id = ${request.params.cartId}
         AND tenant_id = ${tenantId}
         AND (
           ${scope.allTenant}::boolean
           OR (${scope.merchantId}::text IS NOT NULL AND merchant_id = ${scope.merchantId})
           OR (${scope.agentId}::text IS NOT NULL AND agent_id = ${scope.agentId})
         )
       LIMIT 1
    `;
    if (!rows[0]) throw new CommerceHttpError(404, 'cart_not_found', 'Cart not found in this tenant');
    return reply.status(200).send({ data: normalizeCart(rows[0]) });
  });

  app.post<{ Body: PaymentIntentCreateBody }>(
    '/payments/intents',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute', allowList: localLoadRateLimitAllowList } } },
    async (request, reply) => {
    const caller = agentCallerOrThrow(request);
    const tenantId = tenantIdOrThrow(request);
    const idempotencyKey = readIdempotencyKey(request);
    const body = request.body ?? {};
    const fieldErrors: Record<string, string> = {};
    if (!isString(body.merchant_id)) fieldErrors['merchant_id'] = 'required string';
    if (!isString(body.cart_id)) fieldErrors['cart_id'] = 'required string';
    if (!isString(body.passport_jwt)) fieldErrors['passport_jwt'] = 'required string';
    const amountMinorUnits = asInt(body.amount_minor_units);
    if (amountMinorUnits === null || amountMinorUnits < 0) {
      fieldErrors['amount_minor_units'] = 'required non-negative integer';
    }
    if (!isString(body.currency)) fieldErrors['currency'] = 'required string';
    const providerKey = parseProviderKey(body.provider_key, fieldErrors);
    if (body.agent_id !== undefined && body.agent_id !== caller.agentId) {
      throw new CommerceHttpError(403, 'agent_scope_violation',
        'Agent callers may only create payment intents for their own agent identity');
    }
    if (Object.keys(fieldErrors).length > 0) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
        { details: { fields: fieldErrors }, retryable: false });
    }

    const merchantId = body.merchant_id as string;
    const cartId = body.cart_id as string;
    const currency = body.currency as string;
    const sql = getSql();
    const merchant = await loadMerchantContext(sql, tenantId, merchantId);
    if (!merchant) throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');

    const idempotencyScope = {
      tenantId,
      merchantId,
      endpoint: 'POST /v1/commerce/payments/intents',
      environment: merchant.environment,
      idempotencyKey,
      requestBody: body,
    };
    const idempotency = await beginCommerceIdempotency(sql, idempotencyScope);
    if (idempotency.kind === 'replay') {
      return reply.status(idempotency.statusCode).send(idempotency.responseBody);
    }
    if (idempotency.kind === 'conflict') {
      const keyHash = sha256hex(idempotencyKey);
      const auditEventId = await appendIdempotencyConflictAudit(sql, request, {
        tenantId,
        merchantId,
        agentId: caller.agentId,
        idempotencyKeyHash: keyHash,
        endpoint: idempotencyScope.endpoint,
        recordId: idempotency.recordId,
      });
      throw new CommerceHttpError(409, 'idempotency_conflict',
        'Idempotency-Key was already used with a different request body',
        { retryable: false, auditEventId });
    }

    const cart = await loadCartForPayment(sql, tenantId, merchantId, cartId);
    if (!cart) throw new CommerceHttpError(404, 'cart_not_found', 'Cart not found in this tenant');
    if (cart.agent_id !== caller.agentId) {
      throw new CommerceHttpError(403, 'cart_agent_mismatch',
        'Payment intent agent must match the cart agent', { retryable: false });
    }
    if (cart.status !== 'draft') {
      throw new CommerceHttpError(409, 'cart_not_payable',
        'Only draft carts can create payment intents', { retryable: false });
    }
    if (rowAmount(cart.total_amount) !== amountMinorUnits || cart.currency !== currency) {
      throw new CommerceHttpError(409, 'cart_amount_mismatch',
        'Payment intent amount and currency must match the immutable cart snapshot', { retryable: false });
    }

    const policy = await loadActivePolicy(sql, tenantId, merchantId);
    if (!policy) {
      throw new CommerceHttpError(409, 'policy_not_active',
        'No active commerce policy exists for this merchant', { retryable: false });
    }
    const rules = validateRulesOrThrow(policy.rules);
    const decisionId = newCommercePolicyDecisionId();
    if (merchant.tenant_status !== 'active') {
      await throwPolicyDeny(sql, request, {
        tenantId, merchantId, agentId: caller.agentId, policy, decisionId,
        reason: 'tenant_disabled', resourceType: 'commerce_cart', resourceId: cart.id,
      });
    }
    if (merchant.disabled_at !== null || merchant.agentic_commerce_enabled !== true || rules.emergency_disable) {
      await throwPolicyDeny(sql, request, {
        tenantId, merchantId, agentId: caller.agentId, policy, decisionId,
        reason: 'emergency_disabled', resourceType: 'commerce_cart', resourceId: cart.id,
      });
    }

    const agent = await loadAgentContext(sql, tenantId, caller.agentId);
    if (!agent) {
      await throwPolicyDeny(sql, request, {
        tenantId, merchantId, agentId: caller.agentId, policy, decisionId,
        reason: 'agent_not_found', resourceType: 'commerce_cart', resourceId: cart.id,
      });
      throw new Error('unreachable policy deny');
    }
    if (agent.disabled_at !== null || agent.trust_status === 'disabled') {
      await throwPolicyDeny(sql, request, {
        tenantId, merchantId, agentId: caller.agentId, policy, decisionId,
        reason: 'agent_disabled', resourceType: 'commerce_cart', resourceId: cart.id,
      });
    }
    if (agent.trust_status !== 'trusted') {
      await throwPolicyDeny(sql, request, {
        tenantId, merchantId, agentId: caller.agentId, policy, decisionId,
        reason: 'agent_not_trusted', resourceType: 'commerce_cart', resourceId: cart.id,
      });
    }

    let redis: import('ioredis').Redis | null = null;
    try { redis = getRedis(); } catch { redis = null; }
    const verified = await verifyCommercePassport(sql, redis, body.passport_jwt as string, {
      mode: 'payment_affecting',
      expectedTenantId: tenantId,
      expectedMerchantId: merchantId,
    });
    if (!verified.ok) {
      await throwPolicyDeny(sql, request, {
        tenantId, merchantId, agentId: caller.agentId, policy, decisionId,
        reason: passportFailureReason(verified.error), resourceType: 'commerce_cart', resourceId: cart.id,
      });
      throw new Error('unreachable policy deny');
    }
    const passport: VerifiedPassport = verified.passport;
    if (passport.agentId !== caller.agentId) {
      await throwPolicyDeny(sql, request, {
        tenantId, merchantId, agentId: caller.agentId, policy, decisionId,
        reason: 'agent_mismatch', passportJti: passport.jti, resourceType: 'commerce_cart', resourceId: cart.id,
      });
    }
    if (passport.environment !== merchant.environment) {
      await throwPolicyDeny(sql, request, {
        tenantId, merchantId, agentId: caller.agentId, policy, decisionId,
        reason: 'environment_mismatch', passportJti: passport.jti, resourceType: 'commerce_cart', resourceId: cart.id,
      });
    }
    if (passport.passportType !== 'checkout') {
      await throwPolicyDeny(sql, request, {
        tenantId, merchantId, agentId: caller.agentId, policy, decisionId,
        reason: 'checkout_passport_required', passportJti: passport.jti, resourceType: 'commerce_cart', resourceId: cart.id,
      });
    }
    if (passportTtlExceeded(passport, rules)) {
      await throwPolicyDeny(sql, request, {
        tenantId, merchantId, agentId: caller.agentId, policy, decisionId,
        reason: 'checkout_passport_ttl_exceeded', passportJti: passport.jti, resourceType: 'commerce_cart', resourceId: cart.id,
      });
    }

    const actionScope = 'commerce:payment.initiate';
    if (!isCommercePolicyScope(actionScope)) throw new Error('commerce payment scope is not registered');
    const evaluation = evaluateCommercePolicyRules(rules, {
      actionScope,
      amountMinorUnits,
      currency,
      passportScopes: passport.scopes,
      passportMaxAmount: passport.maxAmount,
      passportCurrency: passport.currency,
    });
    if (evaluation.decision !== 'allow') {
      await throwPolicyDeny(sql, request, {
        tenantId, merchantId, agentId: caller.agentId, policy, decisionId,
        decision: evaluation.decision,
        reason: evaluation.reason,
        passportJti: passport.jti,
        resourceType: 'commerce_cart',
        resourceId: cart.id,
      });
    }

    // P0-23 — central live-mode gate. Fails closed when live commerce
    // side effects are not authorized for this deployment. Runs after
    // policy/passport so the caller still gets the most specific reason
    // for any deny, but before any provider call that could create
    // off-platform state.
    ensureCommerceLiveMode({ environment: merchant.environment, providerKey });

    const paymentIntentId = newCommercePaymentIntentId();
    const provider = getPaymentProvider(providerKey);
    let providerResult: {
      provider_payment_id: string;
      provider_order_id?: string;
      status: 'created' | 'authorized' | 'payment_pending';
      raw_status: string;
      provider_metadata?: Record<string, unknown>;
    };
    try {
      providerResult = await provider.createPaymentIntent({
        tenant_id: tenantId,
        merchant_id: merchantId,
        agent_id: caller.agentId,
        payment_intent_id: paymentIntentId,
        cart_id: cart.id,
        passport_jti: passport.jti,
        amount: { amount_minor_units: amountMinorUnits as number, currency },
        line_items_snapshot: Array.isArray(cart.line_items_snapshot) ? cart.line_items_snapshot : [],
        idempotency_key: idempotencyKey,
        environment: merchant.environment,
        metadata: metadataForProvider(body.metadata),
      });
    } catch (err) {
      if (isPaymentProviderError(err)) {
        commerceCriticalFlowTotal.labels(
          'payment_intent.create',
          'provider_error',
          err.normalized.code,
        ).inc();
        request.log.warn({ flow: 'payment_intent.create', status: 'provider_error' },
          'commerce.payment_intent.provider_error');
        throw new CommerceHttpError(503, err.normalized.code, err.normalized.message, {
          retryable: err.normalized.retryable,
          details: {
            provider_key: err.normalized.provider_key,
            provider_error_code: err.normalized.provider_error_code,
            safe_metadata: err.normalized.safe_metadata,
          },
        });
      }
      throw err;
    }

    const responseBody = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      const rows = await tx<PaymentIntentRow[]>`
        INSERT INTO commerce_payment_intents (
          id, tenant_id, merchant_id, agent_id, cart_id, passport_jti,
          amount, currency, provider, provider_environment,
          provider_payment_id, provider_order_id, checkout_url, status,
          line_items_snapshot, idempotency_key_hash, provider_metadata,
          provider_raw_status, policy_version, decision_id, expires_at
        ) VALUES (
          ${paymentIntentId}, ${tenantId}, ${merchantId}, ${caller.agentId}, ${cart.id}, ${passport.jti},
          ${amountMinorUnits}, ${currency}, ${providerKey}, ${merchant.environment},
          ${providerResult.provider_payment_id},
          ${providerResult.provider_order_id ?? null},
          NULL,
          ${providerResult.status},
          ${tx.json(asJson(cart.line_items_snapshot))},
          ${idempotency.keyHash},
          ${tx.json(asJson(providerResult.provider_metadata ?? {}))},
          ${providerResult.raw_status},
          ${policy.version},
          ${decisionId},
          NOW() + INTERVAL '15 minutes'
        )
        RETURNING id, tenant_id, merchant_id, agent_id, cart_id, passport_jti,
                  amount, currency, provider, provider_environment,
                  provider_payment_id, provider_order_id, checkout_url, checkout_expires_at, status,
                  line_items_snapshot, idempotency_key_hash, provider_metadata,
                  provider_raw_status, policy_version, decision_id,
                  expires_at, reconciled_at, last_reconciliation_attempt_at,
                  last_reconciliation_error, last_reconciliation_retryable,
                  created_at, updated_at
      `;
      const paymentIntent = rows[0];
      if (!paymentIntent) throw new Error('commerce payment intent insert returned no row');
      await tx`
        UPDATE commerce_carts
           SET status = 'payment_intent_created',
               passport_jti = ${passport.jti},
               updated_at = NOW()
         WHERE id = ${cart.id}
           AND tenant_id = ${tenantId}
           AND status = 'draft'
      `;
      const audit = await appendCommerceAudit(tx as unknown as Sql, {
        tenantId,
        merchantId,
        agentId: caller.agentId,
        eventType: 'payment_intent.created',
        resourceType: 'commerce_payment_intent',
        resourceId: paymentIntent.id,
        passportJti: passport.jti,
        policyVersion: policy.version,
        decisionId,
        idempotencyKeyHash: idempotency.keyHash,
        requestId: request.id,
        metadata: {
          cart_id: cart.id,
          provider_key: providerKey,
          provider_environment: merchant.environment,
          provider_payment_id: providerResult.provider_payment_id,
          amount: paymentIntent.amount,
          currency: paymentIntent.currency,
        },
      });
      const meter = await appendCommerceAudit(tx as unknown as Sql, {
        tenantId,
        merchantId,
        agentId: caller.agentId,
        eventType: 'meter.payment_intent_created',
        resourceType: 'commerce_payment_intent',
        resourceId: paymentIntent.id,
        passportJti: passport.jti,
        policyVersion: policy.version,
        decisionId,
        idempotencyKeyHash: idempotency.keyHash,
        requestId: request.id,
        metadata: {
          amount: paymentIntent.amount,
          currency: paymentIntent.currency,
          provider_key: providerKey,
        },
      });
      const response = {
        data: normalizePaymentIntent(paymentIntent),
        decision_id: decisionId,
        audit_event_id: audit.id,
        meter_event_id: meter.id,
      };
      await commitCommerceIdempotencyResult(tx as unknown as Sql, {
        recordId: idempotency.recordId,
        scope: idempotencyScope,
        keyHash: idempotency.keyHash,
        requestBodyHash: idempotency.requestBodyHash,
        statusCode: 201,
        responseBody: response,
      });
      return response;
    });

    commerceCriticalFlowTotal.labels('payment_intent.create', 'success', '').inc();
    request.log.info({ flow: 'payment_intent.create', status: 'created' },
      'commerce.payment_intent.created');

    return reply.status(201).send(responseBody);
    },
  );

  app.post<{ Params: { id: string }; Body: CheckoutLinkCreateBody }>(
    '/payments/intents/:id/checkout-link',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const tenantId = tenantIdOrThrow(request);
      const idempotencyKey = readIdempotencyKey(request);
      const body = request.body ?? {};
      const fieldErrors: Record<string, string> = {};
      const successUrl = parseCheckoutUrl(body.success_url, 'success_url', fieldErrors);
      const cancelUrl = parseCheckoutUrl(body.cancel_url, 'cancel_url', fieldErrors);
      const checkoutPassportJwt = isString(body.passport_jwt) ? body.passport_jwt : null;
      if (!checkoutPassportJwt) fieldErrors['passport_jwt'] = 'required string';
      if (Object.keys(fieldErrors).length > 0) {
        throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
          { details: { fields: fieldErrors }, retryable: false });
      }
      if (!checkoutPassportJwt) {
        throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
          { details: { fields: { passport_jwt: 'required string' } }, retryable: false });
      }

      const scope = cartReadScope(request);
      const sql = getSql();
      const rows = await sql<PaymentIntentRow[]>`
        SELECT id, tenant_id, merchant_id, agent_id, cart_id, passport_jti,
               amount, currency, provider, provider_environment,
               provider_payment_id, provider_order_id, checkout_url, checkout_expires_at, status,
               line_items_snapshot, idempotency_key_hash, provider_metadata,
               provider_raw_status, policy_version, decision_id,
               expires_at, reconciled_at, last_reconciliation_attempt_at,
               last_reconciliation_error, last_reconciliation_retryable,
               created_at, updated_at
          FROM commerce_payment_intents
         WHERE id = ${request.params.id}
           AND tenant_id = ${tenantId}
           AND (
             ${scope.allTenant}::boolean
             OR (${scope.merchantId}::text IS NOT NULL AND merchant_id = ${scope.merchantId})
             OR (${scope.agentId}::text IS NOT NULL AND agent_id = ${scope.agentId})
           )
         LIMIT 1
      `;
      const paymentIntent = rows[0];
      if (!paymentIntent) {
        throw new CommerceHttpError(404, 'payment_intent_not_found',
          'Payment intent not found in this tenant');
      }
      if (!paymentIntent.provider_payment_id) {
        throw new CommerceHttpError(409, 'provider_payment_missing',
          'Checkout links require a provider payment id created through Grantex', { retryable: false });
      }
      if (!paymentIntent.passport_jti || !paymentIntent.policy_version || !paymentIntent.decision_id) {
        throw new CommerceHttpError(409, 'payment_intent_missing_policy_evidence',
          'Checkout links require stored passport and policy decision evidence', { retryable: false });
      }

      // P0-23 — fail-closed live-mode gate. Creating a checkout link
      // hands control to the live provider, so the deployment must be
      // authorized for live commerce side effects on this provider.
      ensureCommerceLiveMode({
        environment: paymentIntent.provider_environment,
        providerKey: paymentIntent.provider,
      });

      const policy = await loadActivePolicy(sql, tenantId, paymentIntent.merchant_id);
      if (!policy) {
        throw new CommerceHttpError(409, 'active_policy_required',
          'Checkout creation requires an active merchant policy', { retryable: false });
      }
      const rules = validateRulesOrThrow(policy.rules);
      const passportResult = await verifyCommercePassport(sql, getRedis(), checkoutPassportJwt, {
        expectedTenantId: tenantId,
        expectedMerchantId: paymentIntent.merchant_id,
        mode: 'payment_affecting',
      });
      if (!passportResult.ok) {
        throw new CommerceHttpError(403, passportFailureReason(passportResult.error),
          `Commerce passport rejected: ${passportFailureReason(passportResult.error)}`, { retryable: false });
      }
      const passport = passportResult.passport;
      if (passport.agentId !== paymentIntent.agent_id) {
        throw new CommerceHttpError(403, 'agent_mismatch',
          'Commerce Passport agent does not match the payment intent agent', { retryable: false });
      }
      if (passport.passportType !== 'checkout') {
        await throwPolicyDeny(sql, request, {
          tenantId,
          merchantId: paymentIntent.merchant_id,
          agentId: paymentIntent.agent_id,
          policy,
          decisionId: newCommercePolicyDecisionId(),
          decision: 'deny',
          reason: 'checkout_passport_required',
          passportJti: passport.jti,
          resourceType: 'commerce_payment_intent',
          resourceId: paymentIntent.id,
        });
      }
      if (passport.environment !== paymentIntent.provider_environment) {
        throw new CommerceHttpError(403, 'environment_mismatch',
          'Commerce Passport environment does not match payment environment', { retryable: false });
      }
      if (passportTtlExceeded(passport, rules)) {
        throw new CommerceHttpError(403, 'passport_ttl_exceeded',
          'Commerce Passport exceeds the active policy TTL cap', { retryable: false });
      }
      const agent = await loadAgentContext(sql, tenantId, paymentIntent.agent_id);
      if (!agent || agent.disabled_at !== null || agent.trust_status !== 'trusted') {
        throw new CommerceHttpError(403, 'agent_not_trusted',
          'CommerceAgent must be trusted and enabled for checkout creation', { retryable: false });
      }
      const decisionId = newCommercePolicyDecisionId();
      const evaluation = evaluateCommercePolicyRules(rules, {
        actionScope: 'commerce:checkout.create',
        amountMinorUnits: rowAmount(paymentIntent.amount),
        currency: paymentIntent.currency,
        passportScopes: passport.scopes,
        passportMaxAmount: passport.maxAmount,
        passportCurrency: passport.currency,
      });
      if (evaluation.decision !== 'allow') {
        await throwPolicyDeny(sql, request, {
          tenantId,
          merchantId: paymentIntent.merchant_id,
          agentId: paymentIntent.agent_id,
          policy,
          decisionId,
          decision: evaluation.decision,
          reason: evaluation.reason,
          passportJti: passport.jti,
          resourceType: 'commerce_payment_intent',
          resourceId: paymentIntent.id,
        });
      }
      const checkoutPolicyVersion = policy.version;
      const checkoutDecisionId = decisionId;
      const checkoutPassportJti = passport.jti;

      try {
        assertPaymentStatusTransition(paymentIntent.status, 'checkout_created');
        assertPaymentStatusTransition('checkout_created', 'payment_pending');
      } catch {
        const audit = await appendCommerceAudit(sql, {
          tenantId,
          merchantId: paymentIntent.merchant_id,
          agentId: paymentIntent.agent_id,
          eventType: 'protected_action.denied',
          resourceType: 'commerce_payment_intent',
          resourceId: paymentIntent.id,
          passportJti: paymentIntent.passport_jti,
          policyVersion: paymentIntent.policy_version,
          decisionId: paymentIntent.decision_id,
          requestId: request.id,
          metadata: {
            action: 'checkout_link.create',
            reason: 'invalid_payment_status_transition',
            from_status: paymentIntent.status,
            to_status: 'checkout_created',
          },
        });
        throw new CommerceHttpError(409, 'invalid_payment_status_transition',
          `Cannot create checkout link from payment status ${paymentIntent.status}`,
          { retryable: false, auditEventId: audit.id });
      }

      const idempotencyScope = {
        tenantId,
        merchantId: paymentIntent.merchant_id,
        endpoint: 'POST /v1/commerce/payments/intents/{id}/checkout-link',
        environment: paymentIntent.provider_environment,
        idempotencyKey,
        requestBody: body,
      };
      const idempotency = await beginCommerceIdempotency(sql, idempotencyScope);
      if (idempotency.kind === 'replay') {
        return reply.status(idempotency.statusCode).send(idempotency.responseBody);
      }
      if (idempotency.kind === 'conflict') {
        const keyHash = sha256hex(idempotencyKey);
        const auditEventId = await appendIdempotencyConflictAudit(sql, request, {
          tenantId,
          merchantId: paymentIntent.merchant_id,
          agentId: paymentIntent.agent_id,
          idempotencyKeyHash: keyHash,
          endpoint: idempotencyScope.endpoint,
          recordId: idempotency.recordId,
        });
        throw new CommerceHttpError(409, 'idempotency_conflict',
          'Idempotency-Key was already used with a different request body',
          { retryable: false, auditEventId });
      }

      const provider = getPaymentProvider(paymentIntent.provider);
      let providerResult: {
        checkout_url: string;
        expires_at: string;
        raw_status: string;
        provider_order_id?: string;
        provider_metadata?: Record<string, unknown>;
      };
      try {
        providerResult = await provider.createCheckoutLink({
          tenant_id: tenantId,
          merchant_id: paymentIntent.merchant_id,
          payment_intent_id: paymentIntent.id,
          provider_payment_id: paymentIntent.provider_payment_id,
          provider_order_id: paymentIntent.provider_order_id,
          provider_metadata: paymentIntent.provider_metadata
            && typeof paymentIntent.provider_metadata === 'object'
            && !Array.isArray(paymentIntent.provider_metadata)
            ? paymentIntent.provider_metadata as Record<string, unknown>
            : {},
          amount: {
            amount_minor_units: rowAmount(paymentIntent.amount),
            currency: paymentIntent.currency,
          },
          environment: paymentIntent.provider_environment,
          success_url: successUrl as string,
          cancel_url: cancelUrl as string,
          expires_at: dateLikeToIso(paymentIntent.expires_at),
          idempotency_key: idempotencyKey,
        });
      } catch (err) {
        if (isPaymentProviderError(err)) {
          commerceCriticalFlowTotal.labels(
            'checkout_link.create',
            'provider_error',
            err.normalized.code,
          ).inc();
          request.log.warn(commerceLogContext({
            requestId: request.id,
            tenantId,
            merchantId: paymentIntent.merchant_id,
            agentId: paymentIntent.agent_id,
            paymentIntentId: paymentIntent.id,
            providerKey: paymentIntent.provider,
            providerPaymentIdRef: hashedReference(paymentIntent.provider_payment_id, 'provider_payment'),
            errorCode: err.normalized.code,
            idempotencyKeyHash: idempotency.keyHash,
          }), 'commerce.checkout_link.provider_error');
          throw new CommerceHttpError(503, err.normalized.code, err.normalized.message, {
            retryable: err.normalized.retryable,
            details: {
              provider_key: err.normalized.provider_key,
              provider_error_code: err.normalized.provider_error_code,
              safe_metadata: err.normalized.safe_metadata,
            },
          });
        }
        throw err;
      }

      const responseBody = await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        const checkoutRows = await tx<PaymentIntentRow[]>`
          UPDATE commerce_payment_intents
             SET checkout_url = ${providerResult.checkout_url},
                 checkout_expires_at = ${providerResult.expires_at}::timestamptz,
                 provider_order_id = COALESCE(${providerResult.provider_order_id ?? null}, provider_order_id),
                 status = ${'checkout_created'},
                 provider_raw_status = ${providerResult.raw_status},
                 provider_metadata = COALESCE(provider_metadata, '{}'::jsonb)
                   || ${tx.json(asJson(providerResult.provider_metadata ?? {}))},
                 updated_at = NOW()
           WHERE id = ${paymentIntent.id}
             AND tenant_id = ${tenantId}
             AND status = ${paymentIntent.status}
          RETURNING id, tenant_id, merchant_id, agent_id, cart_id, passport_jti,
                    amount, currency, provider, provider_environment,
                    provider_payment_id, provider_order_id, checkout_url, checkout_expires_at, status,
                    line_items_snapshot, idempotency_key_hash, provider_metadata,
                    provider_raw_status, policy_version, decision_id,
                    expires_at, reconciled_at, last_reconciliation_attempt_at,
                    last_reconciliation_error, last_reconciliation_retryable,
                    created_at, updated_at
        `;
        const checkoutCreated = checkoutRows[0];
        if (!checkoutCreated) {
          throw new CommerceHttpError(409, 'payment_status_changed',
            'Payment intent status changed before checkout link creation completed', { retryable: true });
        }
        const pendingRows = await tx<PaymentIntentRow[]>`
          UPDATE commerce_payment_intents
             SET status = ${'payment_pending'},
                 provider_metadata = COALESCE(provider_metadata, '{}'::jsonb)
                   || ${tx.json(asJson({ checkout_link_state: 'payment_pending' }))},
                 updated_at = NOW()
           WHERE id = ${checkoutCreated.id}
             AND tenant_id = ${tenantId}
             AND status = ${'checkout_created'}
          RETURNING id, tenant_id, merchant_id, agent_id, cart_id, passport_jti,
                    amount, currency, provider, provider_environment,
                    provider_payment_id, provider_order_id, checkout_url, checkout_expires_at, status,
                    line_items_snapshot, idempotency_key_hash, provider_metadata,
                    provider_raw_status, policy_version, decision_id,
                    expires_at, reconciled_at, last_reconciliation_attempt_at,
                    last_reconciliation_error, last_reconciliation_retryable,
                    created_at, updated_at
        `;
        const updated = pendingRows[0];
        if (!updated) {
          throw new CommerceHttpError(409, 'payment_status_changed',
            'Payment intent status changed before entering payment pending state', { retryable: true });
        }
        const audit = await appendCommerceAudit(tx as unknown as Sql, {
          tenantId,
          merchantId: updated.merchant_id,
          agentId: updated.agent_id,
          eventType: 'checkout_link.created',
          resourceType: 'commerce_payment_intent',
          resourceId: updated.id,
          passportJti: checkoutPassportJti,
          policyVersion: checkoutPolicyVersion,
          decisionId: checkoutDecisionId,
          idempotencyKeyHash: idempotency.keyHash,
          requestId: request.id,
          metadata: {
            provider_key: updated.provider,
            provider_payment_id: updated.provider_payment_id,
            checkout_expires_at: updated.checkout_expires_at ?? null,
            status: updated.status,
            state_transitions: ['authorized->checkout_created', 'checkout_created->payment_pending'],
          },
        });
        const response = {
          data: normalizePaymentIntent(updated),
          audit_event_id: audit.id,
        };
        await commitCommerceIdempotencyResult(tx as unknown as Sql, {
          recordId: idempotency.recordId,
          scope: idempotencyScope,
          keyHash: idempotency.keyHash,
          requestBodyHash: idempotency.requestBodyHash,
          statusCode: 201,
          responseBody: response,
        });
        return response;
      });

      commerceCriticalFlowTotal.labels('checkout_link.create', 'success', '').inc();
      request.log.info(commerceLogContext({
        requestId: request.id,
        tenantId,
        merchantId: paymentIntent.merchant_id,
        agentId: paymentIntent.agent_id,
        cartId: paymentIntent.cart_id,
        paymentIntentId: paymentIntent.id,
        providerKey: paymentIntent.provider,
        providerPaymentIdRef: hashedReference(paymentIntent.provider_payment_id, 'provider_payment'),
        passportJti: checkoutPassportJti,
        policyVersion: checkoutPolicyVersion,
        decisionId: checkoutDecisionId,
        idempotencyKeyHash: idempotency.keyHash,
        status: 'payment_pending',
      }), 'commerce.checkout_link.created');

      return reply.status(201).send(responseBody);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/payments/intents/:id/reconcile',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
    const tenantId = tenantIdOrThrow(request);
    const scope = cartReadScope(request);
    const sql = getSql();
    const rows = await sql<PaymentIntentRow[]>`
      SELECT id, tenant_id, merchant_id, agent_id, cart_id, passport_jti,
             amount, currency, provider, provider_environment,
             provider_payment_id, provider_order_id, checkout_url, checkout_expires_at, status,
             line_items_snapshot, idempotency_key_hash, provider_metadata,
             provider_raw_status, policy_version, decision_id,
             expires_at, reconciled_at, last_reconciliation_attempt_at,
             last_reconciliation_error, last_reconciliation_retryable,
             created_at, updated_at
        FROM commerce_payment_intents
       WHERE id = ${request.params.id}
         AND tenant_id = ${tenantId}
         AND (
           ${scope.allTenant}::boolean
           OR (${scope.merchantId}::text IS NOT NULL AND merchant_id = ${scope.merchantId})
           OR (${scope.agentId}::text IS NOT NULL AND agent_id = ${scope.agentId})
         )
       LIMIT 1
    `;
    const paymentIntent = rows[0];
    if (!paymentIntent) {
      throw new CommerceHttpError(404, 'payment_intent_not_found',
        'Payment intent not found in this tenant');
    }

    // P0-23 — reconciliation pulls fresh status from the live provider
    // and may transition payment state. Gate it on the same live-mode
    // switch that protected the original intent creation.
    ensureCommerceLiveMode({
      environment: paymentIntent.provider_environment,
      providerKey: paymentIntent.provider,
    });

    const result = await reconcilePaymentIntent(sql, paymentIntent, {
      requestId: request.id,
      source: 'manual',
    });

    if (result.kind === 'provider_error') {
      commerceCriticalFlowTotal.labels('payment_intent.reconcile', 'provider_error', result.error.code).inc();
      request.log.warn(commerceLogContext({
        requestId: request.id,
        tenantId,
        merchantId: paymentIntent.merchant_id,
        agentId: paymentIntent.agent_id,
        paymentIntentId: paymentIntent.id,
        providerKey: paymentIntent.provider,
        providerPaymentIdRef: paymentIntent.provider_payment_id
          ? hashedReference(paymentIntent.provider_payment_id, 'provider_payment')
          : undefined,
        errorCode: result.error.code,
      }), 'commerce.payment_intent.reconcile_provider_error');
      const statusCode = result.error.provider_error_code === 'provider_payment_missing' ? 409 : 503;
      throw new CommerceHttpError(statusCode, result.error.code, result.error.message, {
        retryable: result.error.retryable,
        details: {
          provider_key: result.error.provider_key,
          provider_error_code: result.error.provider_error_code,
          safe_metadata: result.error.safe_metadata,
        },
      });
    }
    if (result.kind === 'invalid_transition') {
      throw new CommerceHttpError(409, 'invalid_payment_status_transition',
        `Cannot apply reconciliation transition ${result.fromStatus} -> ${result.toStatus}`,
        { retryable: false, auditEventId: result.auditEventId });
    }

    const response: Record<string, unknown> = {
      data: normalizePaymentIntent(result.paymentIntent),
      reconciliation: normalizeReconciliationResult(result),
    };
    if (result.kind === 'transitioned') response['audit_event_id'] = result.auditEventId;
    commerceCriticalFlowTotal.labels('payment_intent.reconcile', result.kind, '').inc();
    request.log.info(commerceLogContext({
      requestId: request.id,
      tenantId,
      merchantId: result.paymentIntent.merchant_id,
      agentId: result.paymentIntent.agent_id,
      paymentIntentId: result.paymentIntent.id,
      providerKey: result.paymentIntent.provider,
      providerPaymentIdRef: result.paymentIntent.provider_payment_id
        ? hashedReference(result.paymentIntent.provider_payment_id, 'provider_payment')
        : undefined,
      status: result.kind,
    }), 'commerce.payment_intent.reconciled');
    return reply.status(200).send(response);
    },
  );

  app.get<{
    Querystring: { merchant_id?: string; status?: string; limit?: string };
  }>('/payments/intents', async (request, reply) => {
    const tenantId = tenantIdOrThrow(request);
    const scope = cartReadScope(request);
    const merchantFilter = scope.merchantId
      ?? (scope.allTenant && isString(request.query.merchant_id) ? request.query.merchant_id : null);
    const agentFilter = scope.agentId;
    const status = isString(request.query.status) ? request.query.status : null;
    const limit = Math.min(Math.max(asInt(request.query.limit) ?? 50, 1), 100);
    const sql = getSql();
    const rows = await sql<PaymentIntentRow[]>`
      SELECT id, tenant_id, merchant_id, agent_id, cart_id, passport_jti,
             amount, currency, provider, provider_environment,
             provider_payment_id, provider_order_id, checkout_url, checkout_expires_at, status,
             line_items_snapshot, idempotency_key_hash, provider_metadata,
             provider_raw_status, policy_version, decision_id,
             expires_at, reconciled_at, last_reconciliation_attempt_at,
             last_reconciliation_error, last_reconciliation_retryable,
             created_at, updated_at
        FROM commerce_payment_intents
       WHERE tenant_id = ${tenantId}
         AND (${merchantFilter}::text IS NULL OR merchant_id = ${merchantFilter})
         AND (${agentFilter}::text IS NULL OR agent_id = ${agentFilter})
         AND (${status}::text IS NULL OR status = ${status})
       ORDER BY created_at DESC
       LIMIT ${limit}
    `;
    return reply.status(200).send({ items: rows.map(normalizePaymentIntent), next_cursor: null });
  });

  app.get<{ Params: { id: string } }>('/payments/intents/:id', async (request, reply) => {
    const tenantId = tenantIdOrThrow(request);
    const scope = cartReadScope(request);
    const sql = getSql();
    const rows = await sql<PaymentIntentRow[]>`
      SELECT id, tenant_id, merchant_id, agent_id, cart_id, passport_jti,
             amount, currency, provider, provider_environment,
             provider_payment_id, provider_order_id, checkout_url, checkout_expires_at, status,
             line_items_snapshot, idempotency_key_hash, provider_metadata,
             provider_raw_status, policy_version, decision_id,
             expires_at, reconciled_at, last_reconciliation_attempt_at,
             last_reconciliation_error, last_reconciliation_retryable,
             created_at, updated_at
        FROM commerce_payment_intents
       WHERE id = ${request.params.id}
         AND tenant_id = ${tenantId}
         AND (
           ${scope.allTenant}::boolean
           OR (${scope.merchantId}::text IS NOT NULL AND merchant_id = ${scope.merchantId})
           OR (${scope.agentId}::text IS NOT NULL AND agent_id = ${scope.agentId})
         )
       LIMIT 1
    `;
    if (!rows[0]) {
      throw new CommerceHttpError(404, 'payment_intent_not_found',
        'Payment intent not found in this tenant');
    }
    return reply.status(200).send({ data: normalizePaymentIntent(rows[0]) });
  });
}
