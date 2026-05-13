import type { FastifyInstance, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import { getSql, type TxSql } from '../db/client.js';
import { CommerceHttpError } from '../lib/commerce/errors.js';
import { appendCommerceAudit } from '../lib/commerce/audit.js';
import { newCommerceProviderCredentialId } from '../lib/commerce/ids.js';
import { encrypt } from '../lib/vault-crypto.js';
import { sha256hex } from '../lib/hash.js';
import { stableJson } from '../lib/commerce/idempotency.js';
import {
  getPaymentProvider,
  type CommerceEnvironment,
  type NormalizedProviderError,
  type ProviderKey,
} from '../lib/commerce/payment-providers/index.js';
import type { CommerceCaller } from '../lib/commerce/caller.js';

type Sql = ReturnType<typeof postgres>;

interface CredentialCreateBody {
  merchant_id?: unknown;
  provider_key?: unknown;
  environment?: unknown;
  credential_payload?: unknown;
}

interface CredentialPatchBody {
  credential_payload?: unknown;
  status?: unknown;
}

interface CredentialRow {
  id: string;
  tenant_id: string;
  merchant_id: string;
  provider_key: ProviderKey;
  environment: CommerceEnvironment;
  credential_ref: string;
  encrypted_secret_blob?: string;
  secret_version: number;
  status: 'pending' | 'valid' | 'invalid' | 'disabled';
  last_validated_at: Date | string | null;
  last_validation_error: NormalizedProviderError | null;
  capabilities: string[];
  created_at: Date | string;
  updated_at: Date | string;
  rotated_at: Date | string | null;
}

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function tenantIdOrThrow(request: FastifyRequest): string {
  if (!request.commerceTenantId) {
    throw new CommerceHttpError(422, 'tenant_context_required',
      'This commerce endpoint requires a tenant-bound caller', { retryable: false });
  }
  return request.commerceTenantId;
}

function actorId(caller: CommerceCaller): string {
  if (caller.kind === 'operator') return caller.developerId;
  if (caller.kind === 'merchant') return `merchant_key:${caller.apiKeyId}`;
  if (caller.kind === 'agent') return `agent:${caller.agentId}`;
  return `service:${caller.serviceId}`;
}

function requireCredentialManager(request: FastifyRequest, merchantId: string): void {
  const caller = request.commerceCaller;
  if (caller.kind === 'operator') return;
  if (caller.kind === 'merchant' && caller.merchantId === merchantId) return;
  throw new CommerceHttpError(403, 'credential_manager_required',
    'This endpoint requires an operator or the merchant whose credentials are being managed');
}

function merchantIdForCreate(request: FastifyRequest, merchantIdRaw: unknown): string {
  const caller = request.commerceCaller;
  if (caller.kind === 'merchant') {
    if (merchantIdRaw !== undefined && merchantIdRaw !== caller.merchantId) {
      throw new CommerceHttpError(403, 'merchant_scope_violation',
        'Merchant callers may only manage credentials for their own merchant');
    }
    return caller.merchantId;
  }
  if (caller.kind === 'operator') {
    if (!isString(merchantIdRaw)) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
        { details: { fields: { merchant_id: 'required string' } }, retryable: false });
    }
    return merchantIdRaw;
  }
  throw new CommerceHttpError(403, 'credential_manager_required',
    'This endpoint requires an operator or merchant caller');
}

function parseProviderKey(v: unknown, fieldErrors: Record<string, string>): ProviderKey {
  if (v === 'mock' || v === 'plural') return v;
  fieldErrors['provider_key'] = 'must be mock or plural';
  return 'mock';
}

function parseEnvironment(v: unknown, fieldErrors: Record<string, string>): CommerceEnvironment {
  if (v === 'sandbox' || v === 'live') return v;
  fieldErrors['environment'] = 'must be sandbox or live';
  return 'sandbox';
}

function credentialRef(
  providerKey: ProviderKey,
  environment: CommerceEnvironment,
  payload: Record<string, unknown>,
): string {
  return `cref_${sha256hex(`${providerKey}:${environment}:${stableJson(payload)}`).slice(0, 32)}`;
}

function assertProviderModeAllowed(
  providerKey: ProviderKey,
  environment: CommerceEnvironment,
): void {
  if (providerKey === 'plural' && environment === 'live') {
    const liveAllowed = process.env['COMMERCE_LIVE_MODE_ENABLED'] === 'true'
      && process.env['PLURAL_LIVE_ENABLED'] === 'true';
    if (!liveAllowed) {
      throw new CommerceHttpError(403, 'plural_live_disabled',
        'Plural live mode is disabled pending legal, partner, and production readiness review',
        { retryable: false });
    }
  }
}

function sanitizeCredential(row: CredentialRow): Record<string, unknown> {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    merchant_id: row.merchant_id,
    provider_key: row.provider_key,
    environment: row.environment,
    credential_ref: row.credential_ref,
    secret_version: row.secret_version,
    status: row.status,
    last_validated_at: row.last_validated_at,
    last_validation_error: row.last_validation_error,
    capabilities: row.capabilities ?? [],
    created_at: row.created_at,
    updated_at: row.updated_at,
    rotated_at: row.rotated_at,
  };
}

async function ensureMerchant(sql: Sql, tenantId: string, merchantId: string): Promise<void> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM commerce_merchants
     WHERE id = ${merchantId}
       AND tenant_id = ${tenantId}
       AND disabled_at IS NULL
     LIMIT 1
  `;
  if (!rows[0]) {
    throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
  }
}

export async function commerceProviderCredentialRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: CredentialCreateBody }>('/provider-credentials', async (request, reply) => {
    const tenantId = tenantIdOrThrow(request);
    const body = request.body ?? {};
    const fieldErrors: Record<string, string> = {};
    const merchantId = merchantIdForCreate(request, body.merchant_id);
    const providerKey = parseProviderKey(body.provider_key, fieldErrors);
    const environment = parseEnvironment(body.environment, fieldErrors);
    if (!isPlainObject(body.credential_payload)) {
      fieldErrors['credential_payload'] = 'required object';
    }
    if (Object.keys(fieldErrors).length > 0) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
        { details: { fields: fieldErrors }, retryable: false });
    }
    assertProviderModeAllowed(providerKey, environment);

    const payload = body.credential_payload as Record<string, unknown>;
    const ref = credentialRef(providerKey, environment, payload);
    const encrypted = encrypt(stableJson(payload));
    const sql = getSql();
    await ensureMerchant(sql, tenantId, merchantId);

    const result = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      const rows = await tx<CredentialRow[]>`
        INSERT INTO commerce_provider_credentials (
          id, tenant_id, merchant_id, provider_key, environment,
          credential_ref, encrypted_secret_blob, secret_version, status
        ) VALUES (
          ${newCommerceProviderCredentialId()},
          ${tenantId},
          ${merchantId},
          ${providerKey},
          ${environment},
          ${ref},
          ${encrypted},
          ${1},
          ${'pending'}
        )
        RETURNING id, tenant_id, merchant_id, provider_key, environment,
                  credential_ref, secret_version, status, last_validated_at,
                  last_validation_error, capabilities, created_at, updated_at,
                  rotated_at
      `;
      const credential = rows[0];
      if (!credential) throw new Error('provider credential insert returned no row');
      const audit = await appendCommerceAudit(tx as unknown as Sql, {
        tenantId,
        merchantId,
        eventType: 'merchant.credentials.updated',
        resourceType: 'commerce_provider_credential',
        resourceId: credential.id,
        requestId: request.id,
        metadata: {
          action: 'provider_credential.created',
          provider_key: providerKey,
          environment,
          credential_ref: ref,
          secret_version: 1,
          actor: actorId(request.commerceCaller),
        },
      });
      return { credential, auditEventId: audit.id };
    });

    return reply.status(201).send({
      data: sanitizeCredential(result.credential),
      audit_event_id: result.auditEventId,
    });
  });

  app.get<{
    Querystring: { merchant_id?: string; provider_key?: string; environment?: string };
  }>('/provider-credentials', async (request, reply) => {
    const tenantId = tenantIdOrThrow(request);
    const caller = request.commerceCaller;
    if (caller.kind !== 'operator' && caller.kind !== 'merchant') {
      throw new CommerceHttpError(403, 'credential_manager_required',
        'This endpoint requires an operator or merchant caller');
    }
    const merchantFilter = caller.kind === 'merchant'
      ? caller.merchantId
      : (isString(request.query.merchant_id) ? request.query.merchant_id : null);
    const providerFilter = isString(request.query.provider_key) ? request.query.provider_key : null;
    const environmentFilter = isString(request.query.environment) ? request.query.environment : null;
    const sql = getSql();
    const rows = await sql<CredentialRow[]>`
      SELECT id, tenant_id, merchant_id, provider_key, environment,
             credential_ref, secret_version, status, last_validated_at,
             last_validation_error, capabilities, created_at, updated_at,
             rotated_at
        FROM commerce_provider_credentials
       WHERE tenant_id = ${tenantId}
         AND (${merchantFilter}::text IS NULL OR merchant_id = ${merchantFilter})
         AND (${providerFilter}::text IS NULL OR provider_key = ${providerFilter})
         AND (${environmentFilter}::text IS NULL OR environment = ${environmentFilter})
       ORDER BY created_at DESC
       LIMIT 100
    `;
    return reply.status(200).send({ items: rows.map(sanitizeCredential), next_cursor: null });
  });

  app.patch<{ Params: { credentialId: string }; Body: CredentialPatchBody }>(
    '/provider-credentials/:credentialId',
    async (request, reply) => {
      const tenantId = tenantIdOrThrow(request);
      const body = request.body ?? {};
      const hasPayload = body.credential_payload !== undefined;
      const disable = body.status === 'disabled';
      if (!hasPayload && !disable) {
        throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
          { details: { fields: { credential_payload: 'required when status is not disabled' } }, retryable: false });
      }
      if (body.status !== undefined && body.status !== 'disabled') {
        throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
          { details: { fields: { status: 'only disabled is mutable through PATCH' } }, retryable: false });
      }
      if (hasPayload && !isPlainObject(body.credential_payload)) {
        throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
          { details: { fields: { credential_payload: 'must be an object' } }, retryable: false });
      }
      const sql = getSql();
      const existingRows = await sql<CredentialRow[]>`
        SELECT id, tenant_id, merchant_id, provider_key, environment,
               credential_ref, secret_version, status, last_validated_at,
               last_validation_error, capabilities, created_at, updated_at,
               rotated_at
          FROM commerce_provider_credentials
         WHERE id = ${request.params.credentialId}
           AND tenant_id = ${tenantId}
         LIMIT 1
      `;
      const existing = existingRows[0];
      if (!existing) {
        throw new CommerceHttpError(404, 'provider_credential_not_found',
          'Provider credential not found in this tenant');
      }
      requireCredentialManager(request, existing.merchant_id);

      const nextPayload = hasPayload ? body.credential_payload as Record<string, unknown> : null;
      const nextRef = nextPayload ? credentialRef(existing.provider_key, existing.environment, nextPayload) : existing.credential_ref;
      const nextEncrypted = nextPayload ? encrypt(stableJson(nextPayload)) : null;
      const result = await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        const rows = await tx<CredentialRow[]>`
          UPDATE commerce_provider_credentials
             SET credential_ref = ${nextRef},
                 encrypted_secret_blob = COALESCE(${nextEncrypted}, encrypted_secret_blob),
                 secret_version = CASE WHEN ${nextEncrypted}::text IS NULL THEN secret_version ELSE secret_version + 1 END,
                 status = ${disable ? 'disabled' : 'pending'},
                 last_validated_at = CASE WHEN ${nextEncrypted}::text IS NULL THEN last_validated_at ELSE NULL END,
                 last_validation_error = CASE WHEN ${nextEncrypted}::text IS NULL THEN last_validation_error ELSE NULL END,
                 capabilities = CASE WHEN ${nextEncrypted}::text IS NULL THEN capabilities ELSE ARRAY[]::TEXT[] END,
                 rotated_at = CASE WHEN ${nextEncrypted}::text IS NULL THEN rotated_at ELSE NOW() END,
                 updated_at = NOW()
           WHERE id = ${existing.id}
             AND tenant_id = ${tenantId}
          RETURNING id, tenant_id, merchant_id, provider_key, environment,
                    credential_ref, secret_version, status, last_validated_at,
                    last_validation_error, capabilities, created_at, updated_at,
                    rotated_at
        `;
        const credential = rows[0];
        if (!credential) throw new Error('provider credential update returned no row');
        const audit = await appendCommerceAudit(tx as unknown as Sql, {
          tenantId,
          merchantId: credential.merchant_id,
          eventType: 'merchant.credentials.updated',
          resourceType: 'commerce_provider_credential',
          resourceId: credential.id,
          requestId: request.id,
          metadata: {
            action: nextPayload ? 'provider_credential.rotated' : 'provider_credential.disabled',
            provider_key: credential.provider_key,
            environment: credential.environment,
            credential_ref: credential.credential_ref,
            secret_version: credential.secret_version,
            actor: actorId(request.commerceCaller),
          },
        });
        return { credential, auditEventId: audit.id };
      });
      return reply.status(200).send({
        data: sanitizeCredential(result.credential),
        audit_event_id: result.auditEventId,
      });
    },
  );

  app.post<{ Params: { credentialId: string } }>(
    '/provider-credentials/:credentialId/validate',
    async (request, reply) => {
      const tenantId = tenantIdOrThrow(request);
      const sql = getSql();
      const existingRows = await sql<CredentialRow[]>`
        SELECT id, tenant_id, merchant_id, provider_key, environment,
               credential_ref, encrypted_secret_blob, secret_version, status,
               last_validated_at, last_validation_error, capabilities,
               created_at, updated_at, rotated_at
          FROM commerce_provider_credentials
         WHERE id = ${request.params.credentialId}
           AND tenant_id = ${tenantId}
         LIMIT 1
      `;
      const existing = existingRows[0];
      if (!existing) {
        throw new CommerceHttpError(404, 'provider_credential_not_found',
          'Provider credential not found in this tenant');
      }
      requireCredentialManager(request, existing.merchant_id);
      if (existing.status === 'disabled') {
        throw new CommerceHttpError(409, 'provider_credential_disabled',
          'Disabled provider credentials cannot be validated');
      }

      const provider = getPaymentProvider(existing.provider_key);
      const validation = await provider.validateCredentials({
        tenant_id: tenantId,
        merchant_id: existing.merchant_id,
        environment: existing.environment,
        credential_ref: existing.credential_ref,
      });
      const nextStatus = validation.valid ? 'valid' : 'invalid';
      const errorJson = validation.error ? JSON.stringify(validation.error) : null;

      const result = await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        const rows = await tx<CredentialRow[]>`
          UPDATE commerce_provider_credentials
             SET status = ${nextStatus},
                 last_validated_at = NOW(),
                 last_validation_error = ${errorJson}::jsonb,
                 capabilities = ${validation.capabilities},
                 updated_at = NOW()
           WHERE id = ${existing.id}
             AND tenant_id = ${tenantId}
          RETURNING id, tenant_id, merchant_id, provider_key, environment,
                    credential_ref, secret_version, status, last_validated_at,
                    last_validation_error, capabilities, created_at, updated_at,
                    rotated_at
        `;
        const credential = rows[0];
        if (!credential) throw new Error('provider credential validation update returned no row');
        const audit = await appendCommerceAudit(tx as unknown as Sql, {
          tenantId,
          merchantId: credential.merchant_id,
          eventType: 'merchant.provider_credentials.validated',
          resourceType: 'commerce_provider_credential',
          resourceId: credential.id,
          requestId: request.id,
          metadata: {
            provider_key: credential.provider_key,
            environment: credential.environment,
            credential_ref: credential.credential_ref,
            status: credential.status,
            capabilities: credential.capabilities,
            error_code: validation.error?.code ?? null,
            provider_error_code: validation.error?.provider_error_code ?? null,
          },
        });
        return { credential, auditEventId: audit.id };
      });

      return reply.status(200).send({
        data: {
          ...sanitizeCredential(result.credential),
          validation: {
            valid: validation.valid,
            capabilities: validation.capabilities,
            checked_at: validation.checked_at,
            ...(validation.merchant_account_ref
              ? { merchant_account_ref: validation.merchant_account_ref } : {}),
            ...(validation.error ? { error: validation.error } : {}),
          },
        },
        audit_event_id: result.auditEventId,
      });
    },
  );
}
