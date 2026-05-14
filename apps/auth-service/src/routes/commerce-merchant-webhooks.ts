import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import { getSql, type TxSql } from '../db/client.js';
import { appendCommerceAudit, type CommerceAuditEventType } from '../lib/commerce/audit.js';
import { commerceErrorHandler, CommerceHttpError } from '../lib/commerce/errors.js';
import { newCommerceProductId, newCommerceVariantId, newCommerceWebhookEventId } from '../lib/commerce/ids.js';
import { stableJson } from '../lib/commerce/idempotency.js';
import { isCommerceCategoryPreset } from '../lib/commerce/presets.js';
import { sha256hex } from '../lib/hash.js';
import { decrypt } from '../lib/vault-crypto.js';

type Sql = ReturnType<typeof postgres>;

interface MerchantWebhookParams {
  merchant_id: string;
  source_key: string;
}

interface MerchantWebhookSourceRow {
  tenant_id: string;
  merchant_id: string;
  source_key: string;
  status: 'active' | 'disabled';
  secret_hash: string;
  encrypted_secret: string;
}

interface MerchantWebhookEventRow {
  id: string;
  processing_status: string;
}

interface ParsedMerchantWebhookPayload {
  event_id: string;
  event_type: string;
  occurred_at: string | null;
  body: Record<string, unknown>;
}

interface ValidCatalogProductUpdated {
  eventId: string;
  eventType: 'catalog.product.updated';
  occurredAt: string;
  product: ProductInput;
}

interface ProductInput {
  product_id?: unknown;
  title?: unknown;
  brand?: unknown;
  description?: unknown;
  image_url?: unknown;
  category_preset?: unknown;
  source_system?: unknown;
  manually_maintained?: unknown;
  variants?: unknown;
}

interface VariantInput {
  sku?: unknown;
  parent_sku?: unknown;
  model?: unknown;
  variant_title?: unknown;
  attributes?: unknown;
  price_amount?: unknown;
  currency?: unknown;
  tax_inclusive?: unknown;
  gst_slab?: unknown;
  tax_rate?: unknown;
  hsn_code?: unknown;
  availability_status?: unknown;
  warranty_summary?: unknown;
  return_policy_summary?: unknown;
  source_system?: unknown;
  last_synced_at?: unknown;
}

const SUPPORTED_EVENT_TYPE = 'catalog.product.updated';
const TIMESTAMP_HEADER = 'x-grantex-merchant-timestamp';
const SIGNATURE_HEADER = 'x-grantex-merchant-signature';
const SIGNATURE_PREFIX = 'v1=';
const REPLAY_WINDOW_MS = 5 * 60 * 1000;
const SOURCE_KEY_RE = /^[a-z0-9_-]{3,64}$/;
const AVAILABILITY = new Set(['in_stock', 'out_of_stock', 'pre_order', 'back_order', 'unknown']);
const PRODUCT_FIELDS = new Set([
  'product_id',
  'title',
  'brand',
  'description',
  'image_url',
  'category_preset',
  'source_system',
  'manually_maintained',
  'variants',
]);
const VARIANT_FIELDS = new Set([
  'sku',
  'parent_sku',
  'model',
  'variant_title',
  'attributes',
  'price_amount',
  'currency',
  'tax_inclusive',
  'gst_slab',
  'tax_rate',
  'hsn_code',
  'availability_status',
  'warranty_summary',
  'return_policy_summary',
  'source_system',
  'last_synced_at',
]);

function isCommerceV1Enabled(): boolean {
  return process.env['COMMERCE_V1_ENABLED'] === 'true';
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && Math.trunc(value) === value) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function isValidCurrency(value: unknown): value is string {
  return isString(value) && /^[A-Z]{3}$/.test(value);
}

function isValidIsoDate(value: unknown): value is string {
  return isString(value) && !Number.isNaN(new Date(value).getTime());
}

function nullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function requestBodyToRaw(body: unknown): string {
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (typeof body === 'string') return body;
  return stableJson(body ?? {});
}

function parseMerchantWebhookPayload(rawBody: string, payloadHash: string): ParsedMerchantWebhookPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    parsed = {};
  }
  const body = isPlainObject(parsed) ? parsed : {};
  return {
    event_id: isString(body['event_id']) ? body['event_id'] : `unknown_${payloadHash.slice(0, 24)}`,
    event_type: isString(body['event_type']) ? body['event_type'] : 'unknown',
    occurred_at: isValidIsoDate(body['occurred_at']) ? body['occurred_at'] : null,
    body,
  };
}

function headerValue(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

function parseUnixTimestamp(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const seconds = Number.parseInt(value, 10);
  if (!Number.isFinite(seconds)) return null;
  return seconds * 1000;
}

function signatureHex(value: string | null): string | null {
  if (!value || !value.startsWith(SIGNATURE_PREFIX)) return null;
  const hex = value.slice(SIGNATURE_PREFIX.length);
  return /^[0-9a-f]{64}$/i.test(hex) ? hex.toLowerCase() : null;
}

function timingSafeHexEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function verifySignature(secret: string, timestamp: string, rawBody: string, signature: string): boolean {
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return timingSafeHexEqual(expected, signature);
}

function validateCatalogProductUpdated(parsed: ParsedMerchantWebhookPayload): {
  ok: true;
  value: ValidCatalogProductUpdated;
} | {
  ok: false;
  fields: Record<string, string>;
} {
  const fields: Record<string, string> = {};
  if (parsed.event_type !== SUPPORTED_EVENT_TYPE) {
    fields['event_type'] = `must be ${SUPPORTED_EVENT_TYPE}`;
  }
  if (!isString(parsed.body['event_id'])) fields['event_id'] = 'required string';
  if (!isValidIsoDate(parsed.body['occurred_at'])) fields['occurred_at'] = 'required ISO date-time string';
  if (!isPlainObject(parsed.body['product'])) {
    fields['product'] = 'required object';
  }
  const product = isPlainObject(parsed.body['product']) ? parsed.body['product'] as ProductInput : {};
  for (const key of Object.keys(product)) {
    if (!PRODUCT_FIELDS.has(key)) fields[`product.${key}`] = 'field is immutable or unsupported';
  }
  if (!isString(product.product_id)) fields['product.product_id'] = 'required string';
  if (!isString(product.title)) fields['product.title'] = 'required string';
  if (!isCommerceCategoryPreset(product.category_preset)) {
    fields['product.category_preset'] = 'must be a known commerce category preset';
  }
  for (const key of ['brand', 'description', 'image_url', 'source_system']) {
    if (product[key as keyof ProductInput] !== undefined && !nullableString(product[key as keyof ProductInput])) {
      fields[`product.${key}`] = 'must be a non-empty string or null';
    }
  }
  if (product.manually_maintained !== undefined && typeof product.manually_maintained !== 'boolean') {
    fields['product.manually_maintained'] = 'must be a boolean';
  }
  if (!Array.isArray(product.variants) || product.variants.length === 0) {
    fields['product.variants'] = 'at least one complete variant is required';
  } else {
    const seenSkus = new Set<string>();
    const currencies = new Set<string>();
    product.variants.forEach((raw, index) => {
      if (!isPlainObject(raw)) {
        fields[`product.variants[${index}]`] = 'must be an object';
        return;
      }
      const variant = raw as VariantInput;
      for (const key of Object.keys(variant)) {
        if (!VARIANT_FIELDS.has(key)) {
          fields[`product.variants[${index}].${key}`] = 'field is immutable or unsupported';
        }
      }
      if (!isString(variant.sku)) {
        fields[`product.variants[${index}].sku`] = 'required string';
      } else if (seenSkus.has(variant.sku)) {
        fields[`product.variants[${index}].sku`] = 'duplicate SKU in event payload';
      } else {
        seenSkus.add(variant.sku);
      }
      if (asInt(variant.price_amount) === null || (asInt(variant.price_amount) as number) < 0) {
        fields[`product.variants[${index}].price_amount`] = 'required non-negative integer (minor units)';
      }
      if (variant.currency !== undefined) {
        if (!isValidCurrency(variant.currency)) {
          fields[`product.variants[${index}].currency`] = 'must be an ISO 4217 uppercase currency code';
        } else {
          currencies.add(variant.currency);
        }
      }
      for (const key of ['parent_sku', 'model', 'variant_title', 'gst_slab', 'hsn_code',
        'warranty_summary', 'return_policy_summary', 'source_system']) {
        if (variant[key as keyof VariantInput] !== undefined && !nullableString(variant[key as keyof VariantInput])) {
          fields[`product.variants[${index}].${key}`] = 'must be a non-empty string or null';
        }
      }
      if (variant.attributes !== undefined && !isPlainObject(variant.attributes)) {
        fields[`product.variants[${index}].attributes`] = 'must be an object';
      }
      if (variant.tax_inclusive !== undefined && typeof variant.tax_inclusive !== 'boolean') {
        fields[`product.variants[${index}].tax_inclusive`] = 'must be a boolean';
      }
      if (variant.tax_rate !== undefined && variant.tax_rate !== null
        && (typeof variant.tax_rate !== 'number' || !Number.isFinite(variant.tax_rate))) {
        fields[`product.variants[${index}].tax_rate`] = 'must be a finite number or null';
      }
      if (variant.availability_status !== undefined
        && (!isString(variant.availability_status) || !AVAILABILITY.has(variant.availability_status))) {
        fields[`product.variants[${index}].availability_status`] =
          'must be one of: in_stock, out_of_stock, pre_order, back_order, unknown';
      }
      if (variant.last_synced_at !== undefined && !isValidIsoDate(variant.last_synced_at)) {
        fields[`product.variants[${index}].last_synced_at`] = 'must be an ISO date-time string';
      }
    });
    if (currencies.size > 1) {
      fields['product.variants.currency'] = 'all variants in one product event must use one currency';
    }
  }
  if (Object.keys(fields).length > 0) {
    return { ok: false, fields };
  }
  return {
    ok: true,
    value: {
      eventId: parsed.event_id,
      eventType: SUPPORTED_EVENT_TYPE,
      occurredAt: parsed.body['occurred_at'] as string,
      product,
    },
  };
}

async function loadWebhookSource(
  sql: Sql,
  merchantId: string,
  sourceKey: string,
): Promise<MerchantWebhookSourceRow | null> {
  const rows = await sql<MerchantWebhookSourceRow[]>`
    SELECT tenant_id, merchant_id, source_key, status, secret_hash, encrypted_secret
      FROM commerce_webhook_sources
     WHERE merchant_id = ${merchantId}
       AND source_key = ${sourceKey}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

async function insertMerchantWebhookEvent(
  tx: TxSql,
  input: {
    source: MerchantWebhookSourceRow;
    parsed: ParsedMerchantWebhookPayload;
    payloadHash: string;
    receivedAt: string;
    signatureStatus: 'valid' | 'invalid' | 'blocked';
    replayStatus: 'fresh' | 'stale';
    processingStatus: 'received' | 'processed' | 'ignored' | 'failed';
    processingError?: string;
  },
): Promise<string> {
  const id = newCommerceWebhookEventId();
  const rows = await tx<Array<{ id: string }>>`
    INSERT INTO commerce_merchant_webhook_events (
      id, tenant_id, merchant_id, source_key, provider_event_id, event_type,
      payload_hash, signature_validation_status, replay_status,
      processing_status, processing_error, occurred_at, received_at,
      processed_at
    ) VALUES (
      ${id}, ${input.source.tenant_id}, ${input.source.merchant_id},
      ${input.source.source_key}, ${input.parsed.event_id}, ${input.parsed.event_type},
      ${input.payloadHash}, ${input.signatureStatus}, ${input.replayStatus},
      ${input.processingStatus}, ${input.processingError ?? null},
      ${input.parsed.occurred_at}, ${input.receivedAt},
      ${input.processingStatus === 'received' ? null : input.receivedAt}
    )
    ON CONFLICT (tenant_id, merchant_id, source_key, provider_event_id) DO NOTHING
    RETURNING id
  `;
  return rows[0]?.id ?? id;
}

async function recordRejectedMerchantWebhook(
  sql: Sql,
  request: FastifyRequest,
  input: {
    source: MerchantWebhookSourceRow;
    parsed: ParsedMerchantWebhookPayload;
    payloadHash: string;
    receivedAt: string;
    signatureStatus: 'valid' | 'invalid' | 'blocked';
    replayStatus: 'fresh' | 'stale';
    processingStatus: 'ignored' | 'failed';
    errorCode: string;
    auditEventType: CommerceAuditEventType;
  },
): Promise<string> {
  return sql.begin(async (_tx) => {
    const tx = _tx as unknown as TxSql;
    const eventId = await insertMerchantWebhookEvent(tx, {
      source: input.source,
      parsed: input.parsed,
      payloadHash: input.payloadHash,
      receivedAt: input.receivedAt,
      signatureStatus: input.signatureStatus,
      replayStatus: input.replayStatus,
      processingStatus: input.processingStatus,
      processingError: input.errorCode,
    });
    const audit = await appendCommerceAudit(tx as unknown as Sql, {
      tenantId: input.source.tenant_id,
      merchantId: input.source.merchant_id,
      eventType: input.auditEventType,
      resourceType: 'commerce_merchant_webhook_event',
      resourceId: eventId,
      requestId: request.id,
      metadata: {
        source_key: input.source.source_key,
        event_id: input.parsed.event_id,
        event_type: input.parsed.event_type,
        payload_hash: input.payloadHash,
        reason: input.errorCode,
      },
    });
    return audit.id;
  });
}

async function upsertCatalogProductFromWebhook(
  tx: TxSql,
  input: {
    tenantId: string;
    merchantId: string;
    occurredAt: string;
    product: ProductInput;
  },
): Promise<{ productInternalId: string; productRef: string; variantCount: number }> {
  const product = input.product;
  const productRows = await tx<Array<{ id: string }>>`
    INSERT INTO commerce_products (
      id, tenant_id, merchant_id, product_id, title, brand, description,
      image_url, category_preset, source_system, manually_maintained
    ) VALUES (
      ${newCommerceProductId()}, ${input.tenantId}, ${input.merchantId},
      ${product.product_id as string},
      ${product.title as string},
      ${isString(product.brand) ? product.brand as string : null},
      ${isString(product.description) ? product.description as string : null},
      ${isString(product.image_url) ? product.image_url as string : null},
      ${product.category_preset as string},
      ${isString(product.source_system) ? product.source_system as string : 'webhook'},
      ${typeof product.manually_maintained === 'boolean' ? product.manually_maintained : false}
    )
    ON CONFLICT (tenant_id, merchant_id, product_id) WHERE archived_at IS NULL
    DO UPDATE SET
      title = EXCLUDED.title,
      brand = EXCLUDED.brand,
      description = EXCLUDED.description,
      image_url = EXCLUDED.image_url,
      category_preset = EXCLUDED.category_preset,
      source_system = EXCLUDED.source_system,
      manually_maintained = EXCLUDED.manually_maintained,
      updated_at = NOW()
    RETURNING id
  `;
  const productInternalId = productRows[0]?.id;
  if (!productInternalId) {
    throw new CommerceHttpError(409, 'merchant_webhook_catalog_conflict',
      'Merchant webhook could not create or update product row');
  }

  let variantCount = 0;
  for (const rawVariant of product.variants as VariantInput[]) {
    const variantRows = await tx<Array<{ id: string }>>`
      INSERT INTO commerce_product_variants (
        id, tenant_id, merchant_id, product_id, sku, parent_sku, model,
        variant_title, attributes, price_amount, currency, tax_inclusive,
        gst_slab, tax_rate, hsn_code, availability_status,
        warranty_summary, return_policy_summary, source_system, last_synced_at
      ) VALUES (
        ${newCommerceVariantId()}, ${input.tenantId}, ${input.merchantId}, ${productInternalId},
        ${rawVariant.sku as string},
        ${isString(rawVariant.parent_sku) ? rawVariant.parent_sku as string : null},
        ${isString(rawVariant.model) ? rawVariant.model as string : null},
        ${isString(rawVariant.variant_title) ? rawVariant.variant_title as string : null},
        ${JSON.stringify(isPlainObject(rawVariant.attributes) ? rawVariant.attributes : {})}::jsonb,
        ${asInt(rawVariant.price_amount) as number},
        ${isString(rawVariant.currency) ? rawVariant.currency as string : 'INR'},
        ${typeof rawVariant.tax_inclusive === 'boolean' ? rawVariant.tax_inclusive : true},
        ${isString(rawVariant.gst_slab) ? rawVariant.gst_slab as string : null},
        ${typeof rawVariant.tax_rate === 'number' ? rawVariant.tax_rate : null},
        ${isString(rawVariant.hsn_code) ? rawVariant.hsn_code as string : null},
        ${isString(rawVariant.availability_status) ? rawVariant.availability_status as string : 'unknown'},
        ${isString(rawVariant.warranty_summary) ? rawVariant.warranty_summary as string : null},
        ${isString(rawVariant.return_policy_summary) ? rawVariant.return_policy_summary as string : null},
        ${isString(rawVariant.source_system) ? rawVariant.source_system as string : 'webhook'},
        ${isValidIsoDate(rawVariant.last_synced_at) ? rawVariant.last_synced_at : input.occurredAt}
      )
      ON CONFLICT (tenant_id, merchant_id, sku) WHERE archived_at IS NULL
      DO UPDATE SET
        parent_sku = EXCLUDED.parent_sku,
        model = EXCLUDED.model,
        variant_title = EXCLUDED.variant_title,
        attributes = EXCLUDED.attributes,
        price_amount = EXCLUDED.price_amount,
        currency = EXCLUDED.currency,
        tax_inclusive = EXCLUDED.tax_inclusive,
        gst_slab = EXCLUDED.gst_slab,
        tax_rate = EXCLUDED.tax_rate,
        hsn_code = EXCLUDED.hsn_code,
        availability_status = EXCLUDED.availability_status,
        warranty_summary = EXCLUDED.warranty_summary,
        return_policy_summary = EXCLUDED.return_policy_summary,
        source_system = EXCLUDED.source_system,
        last_synced_at = EXCLUDED.last_synced_at,
        updated_at = NOW()
      WHERE commerce_product_variants.product_id = ${productInternalId}
      RETURNING id
    `;
    if (!variantRows[0]) {
      throw new CommerceHttpError(409, 'merchant_webhook_catalog_conflict',
        'Merchant webhook found an active SKU assigned to another product');
    }
    variantCount += 1;
  }
  return {
    productInternalId,
    productRef: product.product_id as string,
    variantCount,
  };
}

export async function commerceMerchantWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.setErrorHandler(commerceErrorHandler);

  app.addHook('onRoute', (routeOptions) => {
    if (!routeOptions.config) {
      (routeOptions as unknown as { config: Record<string, unknown> }).config = {};
    }
    (routeOptions.config as unknown as Record<string, unknown>)['skipAuth'] = true;
  });

  app.addHook('preHandler', async () => {
    if (!isCommerceV1Enabled()) {
      throw new CommerceHttpError(
        503,
        'commerce_disabled',
        'Grantex Commerce V1 is not enabled in this environment',
        { retryable: false },
      );
    }
  });

  app.post<{ Params: MerchantWebhookParams }>(
    '/:merchant_id/:source_key',
    { config: { skipAuth: true, rateLimit: { max: 1000, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!isString(request.params.merchant_id) || !SOURCE_KEY_RE.test(request.params.source_key)) {
        throw new CommerceHttpError(404, 'webhook_source_not_found',
          'Webhook source not found for this merchant');
      }
      const receivedAt = new Date().toISOString();
      const rawBody = requestBodyToRaw(request.body);
      const payloadHash = sha256hex(rawBody);
      const parsed = parseMerchantWebhookPayload(rawBody, payloadHash);
      const sql = getSql();
      const source = await loadWebhookSource(sql, request.params.merchant_id, request.params.source_key);
      if (!source) {
        throw new CommerceHttpError(404, 'webhook_source_not_found',
          'Webhook source not found for this merchant');
      }

      if (source.status !== 'active') {
        const auditEventId = await recordRejectedMerchantWebhook(sql, request, {
          source,
          parsed,
          payloadHash,
          receivedAt,
          signatureStatus: 'blocked',
          replayStatus: 'fresh',
          processingStatus: 'ignored',
          errorCode: 'webhook_source_disabled',
          auditEventType: 'protected_action.denied',
        });
        throw new CommerceHttpError(403, 'webhook_source_disabled',
          'Webhook source is disabled', { auditEventId, retryable: false });
      }

      const timestampHeader = headerValue(request, TIMESTAMP_HEADER);
      const timestampMs = parseUnixTimestamp(timestampHeader);
      const signature = signatureHex(headerValue(request, SIGNATURE_HEADER));
      if (!timestampHeader || timestampMs === null || !signature) {
        const auditEventId = await recordRejectedMerchantWebhook(sql, request, {
          source,
          parsed,
          payloadHash,
          receivedAt,
          signatureStatus: 'invalid',
          replayStatus: 'fresh',
          processingStatus: 'failed',
          errorCode: 'webhook_signature_invalid',
          auditEventType: 'merchant_webhook.signature_failed',
        });
        throw new CommerceHttpError(401, 'webhook_signature_invalid',
          'Missing or malformed merchant webhook signature headers',
          { auditEventId, retryable: false });
      }
      if (Math.abs(Date.now() - timestampMs) > REPLAY_WINDOW_MS) {
        const auditEventId = await recordRejectedMerchantWebhook(sql, request, {
          source,
          parsed,
          payloadHash,
          receivedAt,
          signatureStatus: 'blocked',
          replayStatus: 'stale',
          processingStatus: 'failed',
          errorCode: 'webhook_replay_detected',
          auditEventType: 'merchant_webhook.signature_failed',
        });
        throw new CommerceHttpError(409, 'webhook_replay_detected',
          'Merchant webhook timestamp is outside the replay window',
          { auditEventId, retryable: false });
      }
      const signingSecret = decrypt(source.encrypted_secret);
      if (sha256hex(signingSecret) !== source.secret_hash
        || !verifySignature(signingSecret, timestampHeader, rawBody, signature)) {
        const auditEventId = await recordRejectedMerchantWebhook(sql, request, {
          source,
          parsed,
          payloadHash,
          receivedAt,
          signatureStatus: 'invalid',
          replayStatus: 'fresh',
          processingStatus: 'failed',
          errorCode: 'webhook_signature_invalid',
          auditEventType: 'merchant_webhook.signature_failed',
        });
        throw new CommerceHttpError(401, 'webhook_signature_invalid',
          'Merchant webhook signature verification failed',
          { auditEventId, retryable: false });
      }

      const duplicate = await sql<MerchantWebhookEventRow[]>`
        SELECT id, processing_status
          FROM commerce_merchant_webhook_events
         WHERE tenant_id = ${source.tenant_id}
           AND merchant_id = ${source.merchant_id}
           AND source_key = ${source.source_key}
           AND provider_event_id = ${parsed.event_id}
         LIMIT 1
      `;
      if (duplicate[0]) {
        return reply.status(200).send({
          data: {
            status: 'duplicate',
            event_id: parsed.event_id,
            processing_status: duplicate[0].processing_status,
          },
          audit_event_id: null,
        });
      }

      if (parsed.event_type !== SUPPORTED_EVENT_TYPE) {
        const auditEventId = await recordRejectedMerchantWebhook(sql, request, {
          source,
          parsed,
          payloadHash,
          receivedAt,
          signatureStatus: 'valid',
          replayStatus: 'fresh',
          processingStatus: 'ignored',
          errorCode: 'unsupported_merchant_webhook_event',
          auditEventType: 'merchant_webhook.received',
        });
        throw new CommerceHttpError(422, 'unsupported_merchant_webhook_event',
          `Only ${SUPPORTED_EVENT_TYPE} is accepted by this endpoint`,
          { auditEventId, retryable: false });
      }

      const validated = validateCatalogProductUpdated(parsed);
      if (!validated.ok) {
        const auditEventId = await recordRejectedMerchantWebhook(sql, request, {
          source,
          parsed,
          payloadHash,
          receivedAt,
          signatureStatus: 'valid',
          replayStatus: 'fresh',
          processingStatus: 'failed',
          errorCode: 'validation_failed',
          auditEventType: 'merchant_webhook.received',
        });
        throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
          auditEventId,
          details: { fields: validated.fields },
          retryable: false,
        });
      }

      const result = await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        const webhookEventId = await insertMerchantWebhookEvent(tx, {
          source,
          parsed,
          payloadHash,
          receivedAt,
          signatureStatus: 'valid',
          replayStatus: 'fresh',
          processingStatus: 'received',
        });
        const receivedAudit = await appendCommerceAudit(tx as unknown as Sql, {
          tenantId: source.tenant_id,
          merchantId: source.merchant_id,
          eventType: 'merchant_webhook.received',
          resourceType: 'commerce_merchant_webhook_event',
          resourceId: webhookEventId,
          requestId: request.id,
          metadata: {
            source_key: source.source_key,
            event_id: validated.value.eventId,
            event_type: validated.value.eventType,
            payload_hash: payloadHash,
          },
        });
        const catalog = await upsertCatalogProductFromWebhook(tx, {
          tenantId: source.tenant_id,
          merchantId: source.merchant_id,
          occurredAt: validated.value.occurredAt,
          product: validated.value.product,
        });
        await tx`
          UPDATE commerce_merchant_webhook_events
             SET processing_status = 'processed',
                 processed_at = NOW(),
                 updated_at = NOW()
           WHERE id = ${webhookEventId}
        `;
        const catalogAudit = await appendCommerceAudit(tx as unknown as Sql, {
          tenantId: source.tenant_id,
          merchantId: source.merchant_id,
          eventType: 'catalog.product.updated',
          resourceType: 'product',
          resourceId: catalog.productInternalId,
          requestId: request.id,
          metadata: {
            source_key: source.source_key,
            event_id: validated.value.eventId,
            payload_hash: payloadHash,
            product_id: catalog.productRef,
            variant_count: catalog.variantCount,
            changed_fields: ['product', 'variants'],
          },
        });
        return {
          webhookEventId,
          receivedAuditEventId: receivedAudit.id,
          catalogAuditEventId: catalogAudit.id,
          catalog,
        };
      });

      return reply.status(200).send({
        data: {
          status: 'processed',
          event_id: validated.value.eventId,
          product_id: result.catalog.productRef,
          product_internal_id: result.catalog.productInternalId,
          variant_count: result.catalog.variantCount,
        },
        received_audit_event_id: result.receivedAuditEventId,
        audit_event_id: result.catalogAuditEventId,
      });
    },
  );
}
