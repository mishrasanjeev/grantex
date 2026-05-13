import type { FastifyInstance, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import { config } from '../config.js';
import { getSql } from '../db/client.js';
import { CommerceHttpError } from '../lib/commerce/errors.js';
import { getPaymentProvider, type CommerceEnvironment, type ProviderKey } from '../lib/commerce/payment-providers/index.js';

type Sql = ReturnType<typeof postgres>;

interface CommerceOpsHealthQuery {
  merchant_id?: string;
  environment?: CommerceEnvironment;
}

type WebhookProcessingStatus = 'received' | 'processed' | 'ignored' | 'failed';

interface CommerceOpsWebhookEventsQuery {
  merchant_id?: string;
  processing_status?: WebhookProcessingStatus;
  provider_key?: ProviderKey;
  limit?: string;
}

interface WebhookHealthRow {
  backlog_count: number | string | null;
  recent_failure_count: number | string | null;
}

interface WebhookEventRow {
  id: string;
  tenant_id: string | null;
  provider_key: string;
  merchant_id: string | null;
  payment_intent_id: string | null;
  provider_payment_id: string | null;
  provider_event_id: string;
  provider_event_type: string;
  signature_validation_status: string;
  replay_status: string;
  processing_status: string;
  payload_hash: string;
  error_code: string | null;
  error_message: string | null;
  attempt_count: number | string;
  received_at: Date | string;
  processed_at: Date | string | null;
  updated_at: Date | string;
}

function requireOperator(request: FastifyRequest): void {
  if (request.commerceCaller.kind !== 'operator') {
    throw new CommerceHttpError(403, 'operator_required',
      'Commerce operations endpoints are only callable by operator callers');
  }
}

function isEnvironment(v: unknown): v is CommerceEnvironment {
  return v === 'sandbox' || v === 'live';
}

function isProviderKey(v: unknown): v is ProviderKey {
  return v === 'mock' || v === 'plural';
}

function isWebhookProcessingStatus(v: unknown): v is WebhookProcessingStatus {
  return v === 'received' || v === 'processed' || v === 'ignored' || v === 'failed';
}

function countFromRow(v: number | string | null | undefined): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number.parseInt(v, 10);
  return 0;
}

function asLimit(v: unknown): number {
  if (typeof v === 'string' && /^\d+$/.test(v)) {
    return Math.min(Math.max(Number.parseInt(v, 10), 1), 100);
  }
  return 50;
}

function normalizeWebhookEvent(row: WebhookEventRow): Record<string, unknown> {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    provider_key: row.provider_key,
    merchant_id: row.merchant_id,
    payment_intent_id: row.payment_intent_id,
    provider_payment_id: row.provider_payment_id,
    provider_event_id: row.provider_event_id,
    provider_event_type: row.provider_event_type,
    signature_validation_status: row.signature_validation_status,
    replay_status: row.replay_status,
    processing_status: row.processing_status,
    payload_hash: row.payload_hash,
    error_code: row.error_code,
    error_message: row.error_message,
    attempt_count: countFromRow(row.attempt_count),
    received_at: row.received_at,
    processed_at: row.processed_at,
    updated_at: row.updated_at,
    replay_available: false,
    replay_blocker: 'webhook_failed_event_replay_requires_safe_raw_payload_storage',
  };
}

async function providerHealth(
  providerKey: ProviderKey,
  input: {
    tenantId: string;
    merchantId: string;
    environment: CommerceEnvironment;
  },
): Promise<Record<string, unknown>> {
  const provider = getPaymentProvider(providerKey);
  try {
    const result = await provider.healthCheck({
      tenant_id: input.tenantId,
      merchant_id: input.merchantId,
      environment: input.environment,
    });
    return {
      ok: result.ok,
      status: result.status,
      checked_at: result.checked_at,
      details: result.details ?? {},
    };
  } catch (err) {
    const normalized = provider.normalizeError(err);
    return {
      ok: false,
      status: 'down',
      checked_at: new Date().toISOString(),
      error_code: normalized.code,
      provider_error_code: normalized.provider_error_code ?? null,
      retryable: normalized.retryable,
      details: normalized.safe_metadata ?? {},
    };
  }
}

async function readWebhookHealth(
  sql: Sql,
  input: {
    tenantId: string;
    merchantId: string | null;
  },
): Promise<{ backlog_count: number; recent_failure_count: number }> {
  const rows = await sql<WebhookHealthRow[]>`
    SELECT
      COUNT(*) FILTER (WHERE processing_status IN ('received', 'failed')) AS backlog_count,
      COUNT(*) FILTER (
        WHERE processing_status = 'failed'
          AND received_at >= NOW() - INTERVAL '1 hour'
      ) AS recent_failure_count
      FROM commerce_provider_webhook_events
     WHERE tenant_id = ${input.tenantId}
       AND (${input.merchantId}::text IS NULL OR merchant_id = ${input.merchantId})
  `;
  const row = rows[0];
  return {
    backlog_count: countFromRow(row?.backlog_count),
    recent_failure_count: countFromRow(row?.recent_failure_count),
  };
}

export async function commerceOpsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: CommerceOpsHealthQuery }>(
    '/ops/health',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
    requireOperator(request);
    const tenantId = request.commerceTenantId;
    if (!tenantId) {
      throw new CommerceHttpError(422, 'tenant_context_required',
        'Commerce operations health requires a tenant-bound operator', { retryable: false });
    }
    const environment = isEnvironment(request.query.environment) ? request.query.environment : 'sandbox';
    const merchantId = typeof request.query.merchant_id === 'string' && request.query.merchant_id.length > 0
      ? request.query.merchant_id
      : 'mch_healthcheck';

    const sql = getSql();
    const checkedAt = new Date().toISOString();
    let database: Record<string, unknown>;
    let webhookBacklog: Record<string, unknown>;
    try {
      await sql`SELECT 1`;
      database = { ok: true, status: 'healthy' };
      webhookBacklog = await readWebhookHealth(sql, {
        tenantId,
        merchantId: request.query.merchant_id ?? null,
      });
    } catch (err) {
      database = {
        ok: false,
        status: 'down',
        error_code: 'database_unavailable',
      };
      webhookBacklog = {
        backlog_count: null,
        recent_failure_count: null,
        error_code: 'webhook_backlog_unavailable',
      };
      request.log.warn({
        request_id: request.id,
        tenant_id: tenantId,
        error_code: 'commerce_ops_health_database_unavailable',
      }, 'commerce.ops.health.database_unavailable');
    }

    const providers = {
      mock: await providerHealth('mock', { tenantId, merchantId, environment }),
      plural: await providerHealth('plural', { tenantId, merchantId, environment }),
    };
    const reconciliationWorker = {
      status: config.commerceReconciliationWorkerEnabled ? 'enabled' : 'disabled',
      enabled: config.commerceReconciliationWorkerEnabled,
      interval_ms: config.commerceReconciliationIntervalMs,
      limit: config.commerceReconciliationLimit,
    };
    const blockers: string[] = [];
    if (!config.commerceReconciliationWorkerEnabled) {
      blockers.push('reconciliation_worker_not_enabled_for_runtime');
    }
    blockers.push('plural_api_and_webhook_contract_unconfirmed');
    blockers.push('webhook_failed_event_list_and_replay_api_contract_deferred');
    const dbOk = database['ok'] === true;

    const body = {
      status: dbOk ? 'degraded' : 'down',
      checked_at: checkedAt,
      tenant_id: tenantId,
      merchant_id: request.query.merchant_id ?? null,
      environment,
      checks: {
        api: { ok: true, status: 'healthy' },
        database,
        provider_adapters: providers,
        reconciliation_worker: reconciliationWorker,
        webhook_backlog: webhookBacklog,
      },
      blockers,
    };

    return reply.status(dbOk ? 200 : 503).send(body);
    },
  );

  app.get<{ Querystring: CommerceOpsWebhookEventsQuery }>(
    '/ops/provider-webhook-events',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      requireOperator(request);
      const tenantId = request.commerceTenantId;
      if (!tenantId) {
        throw new CommerceHttpError(422, 'tenant_context_required',
          'Commerce provider webhook event listing requires a tenant-bound operator',
          { retryable: false });
      }
      const merchantId = typeof request.query.merchant_id === 'string' && request.query.merchant_id.length > 0
        ? request.query.merchant_id
        : null;
      const processingStatus: WebhookProcessingStatus = isWebhookProcessingStatus(request.query.processing_status)
        ? request.query.processing_status
        : 'failed';
      const providerKey = isProviderKey(request.query.provider_key) ? request.query.provider_key : null;
      const limit = asLimit(request.query.limit);
      const sql = getSql();
      const rows = await sql<WebhookEventRow[]>`
        SELECT id, tenant_id, provider_key, merchant_id, payment_intent_id,
               provider_payment_id, provider_event_id, provider_event_type,
               signature_validation_status, replay_status, processing_status,
               payload_hash, error_code, error_message, attempt_count,
               received_at, processed_at, updated_at
          FROM commerce_provider_webhook_events
         WHERE tenant_id = ${tenantId}
           AND (${merchantId}::text IS NULL OR merchant_id = ${merchantId})
           AND (${providerKey}::text IS NULL OR provider_key = ${providerKey})
           AND processing_status = ${processingStatus}
         ORDER BY received_at DESC
         LIMIT ${limit}
      `;
      return reply.status(200).send({
        items: rows.map(normalizeWebhookEvent),
        next_cursor: null,
        replay_available: false,
        replay_blocker: 'webhook_failed_event_replay_requires_safe_raw_payload_storage',
      });
    },
  );
}
