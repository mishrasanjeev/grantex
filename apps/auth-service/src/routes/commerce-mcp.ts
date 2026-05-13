import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { InjectOptions, Response as InjectResponse } from 'light-my-request';
import type postgres from 'postgres';
import { getSql } from '../db/client.js';
import { getRedis } from '../redis/client.js';
import {
  readMerchantPublishingProfile,
  searchCatalog,
  readCatalogItem,
  checkInventory,
  V1_COMMERCE_TOOLS,
} from '../lib/commerce/catalog.js';
import { CommerceHttpError, commerceErrorEnvelope, type CommerceErrorBody } from '../lib/commerce/errors.js';
import { resolveCommerceCaller, type CommerceCaller } from '../lib/commerce/caller.js';
import {
  resolveOrCreateTenantForDeveloper,
  isAutoTenantAllowed,
} from '../lib/commerce/tenant.js';
import {
  verifyCommercePassport,
  type VerifiedPassport,
  type VerifyPassportError,
} from '../lib/commerce/passport.js';
import { isCommerceCategoryPreset } from '../lib/commerce/presets.js';
import { isCommercePolicyScope, type CommercePolicyScope } from '../lib/commerce/policy.js';

type Sql = ReturnType<typeof postgres>;

type JsonRpcId = string | number | null;

interface JsonRpcRequestBody {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

interface McpPaymentIntentRow {
  id: string;
  tenant_id: string;
  merchant_id: string;
  agent_id: string;
  cart_id: string;
  passport_jti: string;
  amount: number | string;
  currency: string;
  provider: string;
  provider_environment: 'sandbox' | 'live';
  provider_payment_id: string | null;
  provider_order_id: string | null;
  checkout_url: string | null;
  checkout_expires_at: Date | string | null;
  status: string;
  line_items_snapshot: unknown;
  provider_metadata: unknown;
  provider_raw_status: string | null;
  policy_version: string | null;
  decision_id: string | null;
  expires_at: Date | string;
  reconciled_at: Date | string | null;
  last_reconciliation_attempt_at: Date | string | null;
  last_reconciliation_error: string | null;
  last_reconciliation_retryable: boolean | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const MCP_PROTOCOL_VERSION = '2025-03-26';

const TOOL_DESCRIPTIONS: Record<(typeof V1_COMMERCE_TOOLS)[number], string> = {
  'merchant.get_profile': 'Read a safe Grantex Commerce merchant profile and capability list.',
  'catalog.search': 'Search the authenticated merchant catalog.',
  'catalog.get_item': 'Read an authenticated merchant catalog product and variants.',
  'inventory.check': 'Check variant availability buckets and freshness.',
  'cart.create': 'Create an immutable pre-consent cart draft.',
  'checkout.create': 'Create a hosted checkout handoff for an existing Grantex payment intent.',
  'payment.create_intent': 'Create a provider-neutral payment intent after passport and policy checks.',
  'payment.get_status': 'Read a Grantex payment intent status.',
};

const TOOL_SCHEMAS: Record<(typeof V1_COMMERCE_TOOLS)[number], Record<string, unknown>> = {
  'merchant.get_profile': {
    type: 'object',
    additionalProperties: false,
    properties: { merchant_id: { type: 'string' } },
  },
  'catalog.search': {
    type: 'object',
    additionalProperties: false,
    required: ['merchant_id'],
    properties: {
      merchant_id: { type: 'string' },
      passport_jwt: { type: 'string' },
      query: { type: 'string' },
      filters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          brand: { type: 'string' },
          category_preset: { type: 'string', enum: ['electronics_appliances'] },
          availability_status: {
            type: 'string',
            enum: ['in_stock', 'out_of_stock', 'pre_order', 'back_order', 'unknown'],
          },
          currency: { type: 'string' },
        },
      },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      cursor: { type: 'string' },
    },
  },
  'catalog.get_item': {
    type: 'object',
    additionalProperties: false,
    required: ['merchant_id', 'product_id'],
    properties: {
      merchant_id: { type: 'string' },
      product_id: { type: 'string' },
      passport_jwt: { type: 'string' },
    },
  },
  'inventory.check': {
    type: 'object',
    additionalProperties: false,
    required: ['merchant_id', 'variant_ids'],
    properties: {
      merchant_id: { type: 'string' },
      variant_ids: { type: 'array', minItems: 1, items: { type: 'string' } },
      passport_jwt: { type: 'string' },
    },
  },
  'cart.create': {
    type: 'object',
    additionalProperties: false,
    required: ['merchant_id', 'currency', 'line_items', 'idempotency_key'],
    properties: {
      merchant_id: { type: 'string' },
      currency: { type: 'string' },
      idempotency_key: { type: 'string', maxLength: 256 },
      line_items: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['variant_id', 'quantity'],
          additionalProperties: false,
          properties: {
            variant_id: { type: 'string' },
            quantity: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
  },
  'checkout.create': {
    type: 'object',
    additionalProperties: false,
    required: ['payment_intent_id', 'passport_jwt', 'success_url', 'cancel_url', 'idempotency_key'],
    properties: {
      payment_intent_id: { type: 'string' },
      passport_jwt: { type: 'string' },
      success_url: { type: 'string', format: 'uri' },
      cancel_url: { type: 'string', format: 'uri' },
      idempotency_key: { type: 'string', maxLength: 256 },
    },
  },
  'payment.create_intent': {
    type: 'object',
    additionalProperties: false,
    required: ['merchant_id', 'cart_id', 'passport_jwt', 'amount_minor_units', 'currency', 'idempotency_key'],
    properties: {
      merchant_id: { type: 'string' },
      cart_id: { type: 'string' },
      passport_jwt: { type: 'string' },
      amount_minor_units: { type: 'integer', minimum: 0 },
      currency: { type: 'string' },
      provider_key: { type: 'string', enum: ['mock', 'plural'] },
      metadata: { type: 'object', additionalProperties: { type: 'string' } },
      idempotency_key: { type: 'string', maxLength: 256 },
    },
  },
  'payment.get_status': {
    type: 'object',
    additionalProperties: false,
    required: ['payment_intent_id'],
    properties: {
      payment_intent_id: { type: 'string' },
      passport_jwt: { type: 'string' },
    },
  },
};

function isCommerceV1Enabled(): boolean {
  return process.env['COMMERCE_V1_ENABLED'] === 'true';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function asInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number.parseInt(v, 10);
  return null;
}

function jsonRpcId(value: unknown): JsonRpcId {
  if (typeof value === 'string' || typeof value === 'number' || value === null) return value;
  return null;
}

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

function textResult(payload: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function toolError(payload: CommerceErrorBody): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true };
}

function toolErrorFromHttp(err: CommerceHttpError): McpToolResult {
  return toolError(commerceErrorEnvelope(err.code, err.message, err.options));
}

function toolErrorEnvelope(code: string, message: string, options: Record<string, unknown> = {}): McpToolResult {
  return toolError(commerceErrorEnvelope(code, message, options));
}

function asToolName(v: unknown): (typeof V1_COMMERCE_TOOLS)[number] | null {
  return typeof v === 'string' && (V1_COMMERCE_TOOLS as readonly string[]).includes(v)
    ? v as (typeof V1_COMMERCE_TOOLS)[number]
    : null;
}

function toolsList(): Array<Record<string, unknown>> {
  return V1_COMMERCE_TOOLS.map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    inputSchema: TOOL_SCHEMAS[name],
  }));
}

function bearerHeaders(request: FastifyRequest, idempotencyKey?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const auth = request.headers['authorization'];
  if (typeof auth === 'string') headers['authorization'] = auth;
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  return headers;
}

async function resolveMcpCaller(request: FastifyRequest): Promise<{ caller: CommerceCaller; tenantId: string }> {
  if (!isCommerceV1Enabled()) {
    throw new CommerceHttpError(503, 'commerce_disabled',
      'Grantex Commerce V1 is not enabled in this environment', { retryable: false });
  }
  const sql = getSql();
  let redis: import('ioredis').Redis | null = null;
  try { redis = getRedis(); } catch { redis = null; }
  const resolved = await resolveCommerceCaller(request, sql, redis);
  if (!resolved.ok) {
    throw new CommerceHttpError(resolved.failure.status, resolved.failure.code, resolved.failure.message, {
      retryable: resolved.failure.status === 503,
      ...(('details' in resolved.failure && resolved.failure.details !== undefined)
        ? { details: resolved.failure.details }
        : {}),
    });
  }
  const caller = resolved.caller;
  if (caller.kind === 'operator') {
    if (caller.isPlatformAdmin && !caller.developerId.startsWith('dev_')) {
      return { caller, tenantId: '' };
    }
    if (caller.tenantStatus === 'active') return { caller, tenantId: caller.tenantId };
    if (caller.tenantStatus === 'disabled') {
      throw new CommerceHttpError(403, 'tenant_disabled',
        'The commerce tenant mapped to this developer is disabled', { retryable: false });
    }
    if (isAutoTenantAllowed()) {
      return {
        caller,
        tenantId: await resolveOrCreateTenantForDeveloper(sql, caller.developerId, caller.developerName),
      };
    }
    throw new CommerceHttpError(422, 'tenant_not_provisioned',
      'No commerce tenant is mapped to this developer in this environment', { retryable: false });
  }
  return { caller, tenantId: caller.tenantId };
}

function merchantIdForCaller(caller: CommerceCaller, rawMerchantId: unknown): string {
  if (caller.kind === 'merchant') {
    if (rawMerchantId !== undefined && rawMerchantId !== caller.merchantId) {
      throw new CommerceHttpError(403, 'merchant_scope_violation',
        'Merchant callers may only access their own merchant');
    }
    return caller.merchantId;
  }
  if (caller.kind === 'operator' || caller.kind === 'agent') {
    if (!isString(rawMerchantId)) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
        { details: { fields: { merchant_id: 'required string' } }, retryable: false });
    }
    return rawMerchantId;
  }
  throw new CommerceHttpError(403, 'caller_not_authorized',
    'This MCP tool requires operator, merchant, or CommerceAgent caller');
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

async function requireAgentPassportScope(
  sql: Sql,
  input: {
    tenantId: string;
    merchantId: string;
    caller: Extract<CommerceCaller, { kind: 'agent' }>;
    token: unknown;
    scope: CommercePolicyScope;
    mode: 'read_only' | 'payment_affecting';
    checkoutRequired?: boolean;
  },
): Promise<VerifiedPassport> {
  if (!isString(input.token)) {
    throw new CommerceHttpError(403, 'passport_required',
      `Commerce Passport with ${input.scope} is required for this tool`, { retryable: false });
  }
  let redis: import('ioredis').Redis | null = null;
  try { redis = getRedis(); } catch { redis = null; }
  const result = await verifyCommercePassport(sql, redis, input.token, {
    expectedTenantId: input.tenantId,
    expectedMerchantId: input.merchantId,
    mode: input.mode,
  });
  if (!result.ok) {
    const reason = passportFailureReason(result.error);
    throw new CommerceHttpError(403, reason, `Commerce passport rejected: ${reason}`, { retryable: false });
  }
  const passport = result.passport;
  if (passport.agentId !== input.caller.agentId) {
    throw new CommerceHttpError(403, 'agent_mismatch',
      'Commerce Passport agent does not match authenticated agent', { retryable: false });
  }
  if (input.checkoutRequired === true && passport.passportType !== 'checkout') {
    throw new CommerceHttpError(403, 'checkout_passport_required',
      'A checkout Commerce Passport is required for this tool', { retryable: false });
  }
  if (!passport.scopes.includes(input.scope)) {
    throw new CommerceHttpError(403, 'passport_scope_missing',
      `Commerce Passport does not include ${input.scope}`, { retryable: false });
  }
  return passport;
}

function parseCatalogFilters(value: unknown, fieldErrors: Record<string, string>): {
  brand?: string;
  category_preset?: string;
  availability_status?: string;
  currency?: string;
} {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    fieldErrors['filters'] = 'must be an object';
    return {};
  }
  const allowed = new Set(['brand', 'category_preset', 'availability_status', 'currency']);
  const filters: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!allowed.has(key)) {
      fieldErrors[`filters.${key}`] = 'unknown filter';
    } else if (!isString(raw)) {
      fieldErrors[`filters.${key}`] = 'must be a string';
    } else {
      filters[key] = raw;
    }
  }
  if (filters['category_preset'] && !isCommerceCategoryPreset(filters['category_preset'])) {
    fieldErrors['filters.category_preset'] = 'must be a known commerce category preset';
  }
  if (filters['availability_status']
    && !['in_stock', 'out_of_stock', 'pre_order', 'back_order', 'unknown'].includes(filters['availability_status'])) {
    fieldErrors['filters.availability_status'] =
      'must be one of: in_stock, out_of_stock, pre_order, back_order, unknown';
  }
  if (filters['currency'] && !/^[A-Z]{3}$/.test(filters['currency'])) {
    fieldErrors['filters.currency'] = 'must be an ISO 4217 uppercase currency code';
  }
  return filters;
}

function validationError(fields: Record<string, string>): CommerceHttpError {
  return new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
    { details: { fields }, retryable: false });
}

function validateToolArguments(
  name: (typeof V1_COMMERCE_TOOLS)[number],
  args: Record<string, unknown>,
): void {
  const properties = TOOL_SCHEMAS[name]['properties'];
  if (!isPlainObject(properties)) return;
  const allowed = new Set(Object.keys(properties));
  const fields: Record<string, string> = {};
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) fields[key] = 'unknown argument';
  }
  if (Object.keys(fields).length > 0) throw validationError(fields);
}

function normalizePaymentIntent(row: McpPaymentIntentRow): Record<string, unknown> {
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
    checkout_expires_at: row.checkout_expires_at,
    status: row.status,
    line_items_snapshot: row.line_items_snapshot,
    provider_metadata: row.provider_metadata,
    provider_raw_status: row.provider_raw_status,
    policy_version: row.policy_version,
    decision_id: row.decision_id,
    expires_at: row.expires_at,
    reconciled_at: row.reconciled_at,
    last_reconciliation_attempt_at: row.last_reconciliation_attempt_at,
    last_reconciliation_error: row.last_reconciliation_error,
    last_reconciliation_retryable: row.last_reconciliation_retryable,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function loadPaymentIntentForStatus(
  sql: Sql,
  tenantId: string,
  caller: CommerceCaller,
  paymentIntentId: string,
): Promise<McpPaymentIntentRow | null> {
  if (caller.kind !== 'merchant' && caller.kind !== 'agent') {
    throw new CommerceHttpError(403, 'caller_not_authorized',
      'payment.get_status requires merchant or CommerceAgent caller');
  }
  const merchantId = caller.kind === 'merchant' ? caller.merchantId : null;
  const agentId = caller.kind === 'agent' ? caller.agentId : null;
  const rows = await sql<McpPaymentIntentRow[]>`
    SELECT id, tenant_id, merchant_id, agent_id, cart_id, passport_jti,
           amount, currency, provider, provider_environment,
           provider_payment_id, provider_order_id, checkout_url, checkout_expires_at, status,
           line_items_snapshot, provider_metadata, provider_raw_status,
           policy_version, decision_id, expires_at, reconciled_at,
           last_reconciliation_attempt_at, last_reconciliation_error,
           last_reconciliation_retryable, created_at, updated_at
      FROM commerce_payment_intents
     WHERE id = ${paymentIntentId}
       AND tenant_id = ${tenantId}
       AND (${merchantId}::text IS NULL OR merchant_id = ${merchantId})
       AND (${agentId}::text IS NULL OR agent_id = ${agentId})
     LIMIT 1
  `;
  return rows[0] ?? null;
}

async function callRestTool(
  app: FastifyInstance,
  request: FastifyRequest,
  input: {
    method: 'GET' | 'POST';
    url: string;
    payload?: unknown;
    idempotencyKey?: string;
  },
): Promise<McpToolResult> {
  const injectOptions: InjectOptions = {
    method: input.method,
    url: input.url,
    headers: bearerHeaders(request, input.idempotencyKey),
  };
  if (input.payload !== undefined) injectOptions.payload = input.payload as NonNullable<InjectOptions['payload']>;
  const res = await app.inject(injectOptions) as InjectResponse;
  const body = res.json<unknown>();
  if (res.statusCode >= 400) return toolError(body as CommerceErrorBody);
  return textResult(body);
}

async function handleMerchantProfile(request: FastifyRequest, args: Record<string, unknown>): Promise<McpToolResult> {
  const { caller, tenantId } = await resolveMcpCaller(request);
  const merchantId = merchantIdForCaller(caller, args['merchant_id']);
  const result = await readMerchantPublishingProfile(getSql(), { merchantId, tenantId });
  if (result.kind === 'not_found') {
    throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant publishing profile was not found');
  }
  if (result.kind === 'selector_required') {
    throw new CommerceHttpError(422, 'merchant_selector_required',
      'Multiple commerce merchants are available; pass merchant_id');
  }
  return textResult({ data: result.profile });
}

async function handleCatalogSearch(request: FastifyRequest, args: Record<string, unknown>): Promise<McpToolResult> {
  const { caller, tenantId } = await resolveMcpCaller(request);
  const merchantId = merchantIdForCaller(caller, args['merchant_id']);
  const fieldErrors: Record<string, string> = {};
  const filters = parseCatalogFilters(args['filters'], fieldErrors);
  if (args['query'] !== undefined && args['query'] !== null && typeof args['query'] !== 'string') {
    fieldErrors['query'] = 'must be a string';
  }
  if (args['cursor'] !== undefined && args['cursor'] !== null && typeof args['cursor'] !== 'string') {
    fieldErrors['cursor'] = 'must be a string';
  }
  const limit = args['limit'] === undefined ? 25 : asInt(args['limit']);
  if (limit === null || limit < 1 || limit > 100) {
    fieldErrors['limit'] = 'must be an integer between 1 and 100';
  }
  if (Object.keys(fieldErrors).length > 0) throw validationError(fieldErrors);
  if (caller.kind === 'agent') {
    await requireAgentPassportScope(getSql(), {
      tenantId,
      merchantId,
      caller,
      token: args['passport_jwt'],
      scope: 'commerce:catalog.read',
      mode: 'read_only',
    });
  }
  return textResult(await searchCatalog(getSql(), {
    tenantId,
    merchantId,
    query: typeof args['query'] === 'string' ? args['query'] : null,
    filters,
    limit: limit ?? 25,
    cursor: typeof args['cursor'] === 'string' ? args['cursor'] : null,
  }));
}

async function handleCatalogGetItem(request: FastifyRequest, args: Record<string, unknown>): Promise<McpToolResult> {
  const { caller, tenantId } = await resolveMcpCaller(request);
  const merchantId = merchantIdForCaller(caller, args['merchant_id']);
  if (!isString(args['product_id'])) {
    throw validationError({ product_id: 'required string' });
  }
  if (caller.kind === 'agent') {
    await requireAgentPassportScope(getSql(), {
      tenantId,
      merchantId,
      caller,
      token: args['passport_jwt'],
      scope: 'commerce:catalog.read',
      mode: 'read_only',
    });
  }
  const item = await readCatalogItem(getSql(), {
    tenantId,
    merchantId,
    productRef: args['product_id'],
  });
  if (!item) throw new CommerceHttpError(404, 'product_not_found', 'Product not found in this tenant');
  return textResult({ data: item });
}

async function handleInventoryCheck(request: FastifyRequest, args: Record<string, unknown>): Promise<McpToolResult> {
  const { caller, tenantId } = await resolveMcpCaller(request);
  const merchantId = merchantIdForCaller(caller, args['merchant_id']);
  if (!Array.isArray(args['variant_ids'])
    || args['variant_ids'].length === 0
    || args['variant_ids'].some((v) => !isString(v))) {
    throw validationError({ variant_ids: 'required non-empty string array' });
  }
  if (caller.kind === 'agent') {
    await requireAgentPassportScope(getSql(), {
      tenantId,
      merchantId,
      caller,
      token: args['passport_jwt'],
      scope: 'commerce:inventory.read',
      mode: 'read_only',
    });
  }
  return textResult({
    items: await checkInventory(getSql(), {
      tenantId,
      merchantId,
      variantIds: args['variant_ids'] as string[],
    }),
  });
}

function requireIdempotencyArg(args: Record<string, unknown>): string {
  if (!isString(args['idempotency_key'])) {
    throw new CommerceHttpError(400, 'idempotency_key_required',
      'idempotency_key is required for this MCP tool', { retryable: false });
  }
  if (args['idempotency_key'].length > 256) {
    throw validationError({ idempotency_key: 'must be at most 256 characters' });
  }
  return args['idempotency_key'];
}

async function handlePaymentStatus(request: FastifyRequest, args: Record<string, unknown>): Promise<McpToolResult> {
  const { caller, tenantId } = await resolveMcpCaller(request);
  if (!isString(args['payment_intent_id'])) {
    throw validationError({ payment_intent_id: 'required string' });
  }
  const paymentIntent = await loadPaymentIntentForStatus(getSql(), tenantId, caller, args['payment_intent_id']);
  if (!paymentIntent) {
    throw new CommerceHttpError(404, 'payment_intent_not_found',
      'Payment intent not found in this tenant');
  }
  if (caller.kind === 'agent') {
    await requireAgentPassportScope(getSql(), {
      tenantId,
      merchantId: paymentIntent.merchant_id,
      caller,
      token: args['passport_jwt'],
      scope: 'commerce:payment.status.read',
      mode: 'read_only',
    });
  }
  return textResult({ data: normalizePaymentIntent(paymentIntent) });
}

async function callTool(
  app: FastifyInstance,
  request: FastifyRequest,
  name: (typeof V1_COMMERCE_TOOLS)[number],
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  if (name === 'merchant.get_profile') return handleMerchantProfile(request, args);
  if (name === 'catalog.search') return handleCatalogSearch(request, args);
  if (name === 'catalog.get_item') return handleCatalogGetItem(request, args);
  if (name === 'inventory.check') return handleInventoryCheck(request, args);
  if (name === 'payment.get_status') return handlePaymentStatus(request, args);

  if (name === 'cart.create') {
    const idempotencyKey = requireIdempotencyArg(args);
    const { idempotency_key: _key, ...payload } = args;
    return callRestTool(app, request, {
      method: 'POST',
      url: '/v1/commerce/carts',
      payload,
      idempotencyKey,
    });
  }

  if (name === 'payment.create_intent') {
    const idempotencyKey = requireIdempotencyArg(args);
    const { idempotency_key: _key, ...payload } = args;
    return callRestTool(app, request, {
      method: 'POST',
      url: '/v1/commerce/payments/intents',
      payload,
      idempotencyKey,
    });
  }

  if (name === 'checkout.create') {
    const idempotencyKey = requireIdempotencyArg(args);
    if (!isString(args['payment_intent_id'])) {
      throw validationError({ payment_intent_id: 'required string' });
    }
    if (!isString(args['passport_jwt'])) {
      throw validationError({ passport_jwt: 'required string' });
    }
    return callRestTool(app, request, {
      method: 'POST',
      url: `/v1/commerce/payments/intents/${encodeURIComponent(args['payment_intent_id'])}/checkout-link`,
      payload: {
        success_url: args['success_url'],
        cancel_url: args['cancel_url'],
        passport_jwt: args['passport_jwt'],
      },
      idempotencyKey,
    });
  }

  return toolErrorEnvelope('tool_not_implemented', `Tool ${name} is not implemented`);
}

function initializeResult(): Record<string, unknown> {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'grantex-commerce', version: '0.1.0' },
  };
}

export async function commerceMcpRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: JsonRpcRequestBody }>(
    '/mcp',
    { config: { skipAuth: true, rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const id = jsonRpcId(request.body?.id);
      if (!isPlainObject(request.body) || request.body.jsonrpc !== '2.0' || typeof request.body.method !== 'string') {
        return reply.status(400).send(rpcError(id, -32600, 'Invalid Request'));
      }

      if (!isCommerceV1Enabled()) {
        return reply.status(503).send(rpcError(
          id,
          -32000,
          'Commerce disabled',
          commerceErrorEnvelope(
            'commerce_disabled',
            'Grantex Commerce V1 is not enabled in this environment',
            { retryable: false },
          ),
        ));
      }

      if (request.body.method === 'initialize') {
        return reply.status(200).send(rpcResult(id, initializeResult()));
      }

      if (request.body.method === 'tools/list') {
        return reply.status(200).send(rpcResult(id, { tools: toolsList() }));
      }

      if (request.body.method !== 'tools/call') {
        return reply.status(200).send(rpcError(id, -32601, 'Method not found'));
      }

      const params = isPlainObject(request.body.params) ? request.body.params : {};
      const name = asToolName(params['name']);
      const args = isPlainObject(params['arguments']) ? params['arguments'] : {};
      if (!name) {
        return reply.status(200).send(rpcResult(id, toolErrorEnvelope(
          'tool_not_found',
          'Requested Grantex Commerce MCP tool is not available',
        )));
      }

      try {
        validateToolArguments(name, args);
        const result = await callTool(app, request, name, args);
        return reply.status(200).send(rpcResult(id, result));
      } catch (err) {
        if (err instanceof CommerceHttpError) {
          return reply.status(200).send(rpcResult(id, toolErrorFromHttp(err)));
        }
        request.log.error({ err, requestId: request.id }, 'Unhandled commerce MCP tool error');
        return reply.status(200).send(rpcResult(id, toolErrorEnvelope(
          'internal_error',
          'An unexpected error occurred',
          { retryable: true },
        )));
      }
    },
  );
}
