import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import { getSql, type TxSql } from '../db/client.js';
import { appendCommerceAudit } from '../lib/commerce/audit.js';
import { CommerceHttpError } from '../lib/commerce/errors.js';
import type { CommerceCaller } from '../lib/commerce/caller.js';
import { encrypt } from '../lib/vault-crypto.js';
import { sha256hex } from '../lib/hash.js';

type Sql = ReturnType<typeof postgres>;

interface WebhookSourceCreateBody {
  merchant_id?: unknown;
  source_key?: unknown;
  display_name?: unknown;
}

interface WebhookSourceListQuery {
  merchant_id?: string;
  status?: string;
}

interface WebhookSourcePatchQuery {
  merchant_id?: string;
}

interface WebhookSourcePatchBody {
  display_name?: unknown;
  status?: unknown;
}

interface WebhookSourceRotateBody {
  merchant_id?: unknown;
}

interface WebhookSourceRow {
  tenant_id: string;
  merchant_id: string;
  source_key: string;
  display_name: string;
  status: string;
  secret_last_rotated_at: string | Date;
  created_at: string | Date;
  updated_at: string | Date;
}

const SOURCE_KEY_RE = /^[a-z0-9_-]{3,64}$/;
const WEBHOOK_SOURCE_STATUSES = new Set(['active', 'disabled']);
const WEBHOOK_SOURCE_PATCH_FIELDS = new Set(['display_name', 'status']);

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function generateWebhookSigningSecret(): string {
  return `gxmwh_${randomBytes(32).toString('base64url')}`;
}

function toWebhookSource(row: WebhookSourceRow): Record<string, unknown> {
  return {
    tenant_id: row.tenant_id,
    merchant_id: row.merchant_id,
    source_key: row.source_key,
    display_name: row.display_name,
    status: row.status,
    secret_last_rotated_at: new Date(row.secret_last_rotated_at).toISOString(),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

function merchantIdForWebhookSourceWrite(request: FastifyRequest, rawMerchantId: unknown): string {
  const caller = request.commerceCaller as CommerceCaller;
  if (caller.kind === 'merchant') {
    if (rawMerchantId !== undefined && rawMerchantId !== caller.merchantId) {
      throw new CommerceHttpError(403, 'merchant_scope_violation',
        'Merchant callers may only manage their own webhook sources');
    }
    return caller.merchantId;
  }
  if (caller.kind === 'operator') {
    if (!isString(rawMerchantId)) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: { merchant_id: 'required string' } },
        retryable: false,
      });
    }
    return rawMerchantId;
  }
  throw new CommerceHttpError(403, 'caller_not_authorized',
    'Webhook source management requires operator or merchant caller');
}

function validateSourceKey(sourceKey: unknown, fieldErrors: Record<string, string>): string | null {
  if (!isString(sourceKey)) {
    fieldErrors['source_key'] = 'required string';
    return null;
  }
  if (!SOURCE_KEY_RE.test(sourceKey)) {
    fieldErrors['source_key'] = 'must be 3-64 lowercase letters, numbers, underscores, or hyphens';
    return null;
  }
  return sourceKey;
}

async function assertMerchantInTenant(sql: Sql, tenantId: string, merchantId: string): Promise<void> {
  const rows = await sql<Array<{ id: string }>>`
    SELECT id
      FROM commerce_merchants
     WHERE tenant_id = ${tenantId}
       AND id = ${merchantId}
     LIMIT 1
  `;
  if (!rows[0]) {
    throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
  }
}

export async function commerceWebhookSourceRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: WebhookSourceCreateBody }>('/webhook-sources', async (request, reply) => {
    if (request.body !== undefined && !isPlainObject(request.body)) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: { body: 'must be a JSON object' } },
        retryable: false,
      });
    }
    const body = (request.body ?? {}) as WebhookSourceCreateBody;
    const fieldErrors: Record<string, string> = {};
    const merchantId = merchantIdForWebhookSourceWrite(request, body.merchant_id);
    const sourceKey = validateSourceKey(body.source_key, fieldErrors);
    if (!isString(body.display_name)) {
      fieldErrors['display_name'] = 'required string';
    }
    if (Object.keys(fieldErrors).length > 0 || !sourceKey) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: fieldErrors },
        retryable: false,
      });
    }

    const sql = getSql();
    const tenantId = request.commerceTenantId;
    await assertMerchantInTenant(sql, tenantId, merchantId);
    const existing = await sql<Array<{ source_key: string }>>`
      SELECT source_key
        FROM commerce_webhook_sources
       WHERE tenant_id = ${tenantId}
         AND merchant_id = ${merchantId}
         AND source_key = ${sourceKey}
       LIMIT 1
    `;
    if (existing[0]) {
      throw new CommerceHttpError(409, 'webhook_source_exists',
        'Webhook source already exists for this merchant and source_key');
    }

    const signingSecret = generateWebhookSigningSecret();
    const secretHash = sha256hex(signingSecret);
    const encryptedSecret = encrypt(signingSecret);
    const result = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      const rows = await tx<WebhookSourceRow[]>`
        INSERT INTO commerce_webhook_sources (
          tenant_id, merchant_id, source_key, display_name, status,
          secret_hash, encrypted_secret, secret_last_rotated_at
        ) VALUES (
          ${tenantId}, ${merchantId}, ${sourceKey}, ${body.display_name as string},
          'active', ${secretHash}, ${encryptedSecret}, NOW()
        )
        RETURNING tenant_id, merchant_id, source_key, display_name, status,
                  secret_last_rotated_at, created_at, updated_at
      `;
      const row = rows[0];
      if (!row) {
        throw new CommerceHttpError(500, 'webhook_source_create_failed',
          'Webhook source could not be created', { retryable: true });
      }
      const audit = await appendCommerceAudit(tx as unknown as Sql, {
        tenantId,
        merchantId,
        eventType: 'webhook_source.created',
        resourceType: 'commerce_webhook_source',
        resourceId: sourceKey,
        requestId: request.id,
        metadata: {
          source_key: sourceKey,
          display_name: body.display_name as string,
          status: 'active',
        },
      });
      return { row, auditEventId: audit.id };
    });

    return reply.status(201).send({
      data: {
        ...toWebhookSource(result.row),
        webhook_secret: signingSecret,
      },
      audit_event_id: result.auditEventId,
    });
  });

  app.get<{ Querystring: WebhookSourceListQuery }>('/webhook-sources', async (request, reply) => {
    const fieldErrors: Record<string, string> = {};
    const merchantId = merchantIdForWebhookSourceWrite(request, request.query.merchant_id);
    if (request.query.status !== undefined && !WEBHOOK_SOURCE_STATUSES.has(request.query.status)) {
      fieldErrors['status'] = 'must be one of: active, disabled';
    }
    if (Object.keys(fieldErrors).length > 0) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: fieldErrors },
        retryable: false,
      });
    }

    const sql = getSql();
    const tenantId = request.commerceTenantId;
    await assertMerchantInTenant(sql, tenantId, merchantId);
    const rows = await sql<WebhookSourceRow[]>`
      SELECT tenant_id, merchant_id, source_key, display_name, status,
             secret_last_rotated_at, created_at, updated_at
        FROM commerce_webhook_sources
       WHERE tenant_id = ${tenantId}
         AND merchant_id = ${merchantId}
         AND (${request.query.status ?? null}::text IS NULL OR status = ${request.query.status ?? null})
       ORDER BY created_at DESC, source_key ASC
    `;
    return reply.status(200).send({ items: rows.map(toWebhookSource) });
  });

  app.patch<{
    Params: { source_key: string };
    Querystring: WebhookSourcePatchQuery;
    Body: WebhookSourcePatchBody;
  }>('/webhook-sources/:source_key', async (request, reply) => {
    if (request.body !== undefined && !isPlainObject(request.body)) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: { body: 'must be a JSON object' } },
        retryable: false,
      });
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const fieldErrors: Record<string, string> = {};
    const sourceKey = validateSourceKey(request.params.source_key, fieldErrors);
    const merchantId = merchantIdForWebhookSourceWrite(request, request.query.merchant_id);
    const changedFields = Object.keys(body);
    for (const key of changedFields) {
      if (!WEBHOOK_SOURCE_PATCH_FIELDS.has(key)) {
        fieldErrors[key] = 'field is immutable or unsupported';
      }
    }
    const mutableFields = changedFields.filter((key) => WEBHOOK_SOURCE_PATCH_FIELDS.has(key));
    if (mutableFields.length === 0 && Object.keys(fieldErrors).length === 0) {
      fieldErrors['body'] = 'at least one mutable field is required';
    }
    if (body['display_name'] !== undefined && !isString(body['display_name'])) {
      fieldErrors['display_name'] = 'must be a non-empty string';
    }
    if (body['status'] !== undefined
      && (typeof body['status'] !== 'string' || !WEBHOOK_SOURCE_STATUSES.has(body['status']))) {
      fieldErrors['status'] = 'must be one of: active, disabled';
    }
    if (Object.keys(fieldErrors).length > 0 || !sourceKey) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: fieldErrors },
        retryable: false,
      });
    }

    const sql = getSql();
    const tenantId = request.commerceTenantId;
    const hasDisplayName = Object.prototype.hasOwnProperty.call(body, 'display_name');
    const hasStatus = Object.prototype.hasOwnProperty.call(body, 'status');
    const result = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      const rows = await tx<WebhookSourceRow[]>`
        UPDATE commerce_webhook_sources
           SET display_name = CASE WHEN ${hasDisplayName}::boolean THEN ${hasDisplayName ? body['display_name'] as string : null}::text ELSE display_name END,
               status = CASE WHEN ${hasStatus}::boolean THEN ${hasStatus ? body['status'] as string : null}::text ELSE status END,
               updated_at = NOW()
         WHERE tenant_id = ${tenantId}
           AND merchant_id = ${merchantId}
           AND source_key = ${sourceKey}
        RETURNING tenant_id, merchant_id, source_key, display_name, status,
                  secret_last_rotated_at, created_at, updated_at
      `;
      const row = rows[0];
      if (!row) return null;
      const audit = await appendCommerceAudit(tx as unknown as Sql, {
        tenantId,
        merchantId,
        eventType: 'webhook_source.updated',
        resourceType: 'commerce_webhook_source',
        resourceId: sourceKey,
        requestId: request.id,
        metadata: {
          source_key: sourceKey,
          changed_fields: mutableFields,
        },
      });
      return { row, auditEventId: audit.id };
    });
    if (!result) {
      throw new CommerceHttpError(404, 'webhook_source_not_found',
        'Webhook source not found in this tenant and merchant');
    }
    return reply.status(200).send({ data: toWebhookSource(result.row), audit_event_id: result.auditEventId });
  });

  app.post<{
    Params: { source_key: string };
    Body: WebhookSourceRotateBody;
  }>('/webhook-sources/:source_key/rotate-secret', async (request, reply) => {
    if (request.body !== undefined && !isPlainObject(request.body)) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: { body: 'must be a JSON object' } },
        retryable: false,
      });
    }
    const body = (request.body ?? {}) as WebhookSourceRotateBody;
    const fieldErrors: Record<string, string> = {};
    const sourceKey = validateSourceKey(request.params.source_key, fieldErrors);
    const merchantId = merchantIdForWebhookSourceWrite(request, body.merchant_id);
    if (Object.keys(fieldErrors).length > 0 || !sourceKey) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: fieldErrors },
        retryable: false,
      });
    }

    const signingSecret = generateWebhookSigningSecret();
    const secretHash = sha256hex(signingSecret);
    const encryptedSecret = encrypt(signingSecret);
    const sql = getSql();
    const tenantId = request.commerceTenantId;
    const result = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      const rows = await tx<WebhookSourceRow[]>`
        UPDATE commerce_webhook_sources
           SET secret_hash = ${secretHash},
               encrypted_secret = ${encryptedSecret},
               secret_last_rotated_at = NOW(),
               updated_at = NOW()
         WHERE tenant_id = ${tenantId}
           AND merchant_id = ${merchantId}
           AND source_key = ${sourceKey}
        RETURNING tenant_id, merchant_id, source_key, display_name, status,
                  secret_last_rotated_at, created_at, updated_at
      `;
      const row = rows[0];
      if (!row) return null;
      const audit = await appendCommerceAudit(tx as unknown as Sql, {
        tenantId,
        merchantId,
        eventType: 'webhook_source.secret_rotated',
        resourceType: 'commerce_webhook_source',
        resourceId: sourceKey,
        requestId: request.id,
        metadata: {
          source_key: sourceKey,
          changed_fields: ['secret_last_rotated_at'],
        },
      });
      return { row, auditEventId: audit.id };
    });
    if (!result) {
      throw new CommerceHttpError(404, 'webhook_source_not_found',
        'Webhook source not found in this tenant and merchant');
    }
    return reply.status(200).send({
      data: {
        ...toWebhookSource(result.row),
        webhook_secret: signingSecret,
      },
      audit_event_id: result.auditEventId,
    });
  });
}
