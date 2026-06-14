import type { FastifyInstance, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import { config } from '../config.js';
import { getSql, type TxSql } from '../db/client.js';
import { appendCommerceAudit } from '../lib/commerce/audit.js';
import { CommerceHttpError } from '../lib/commerce/errors.js';
import { getPaymentProvider, type CommerceEnvironment, type ProviderKey } from '../lib/commerce/payment-providers/index.js';
import { assertPaymentStatusTransition, type CommercePaymentStatus } from '../lib/commerce/payment-state.js';
import { sha256hex } from '../lib/hash.js';
import { decrypt } from '../lib/vault-crypto.js';

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

interface ProviderWebhookReplayParams {
  event_id: string;
}

interface ProviderWebhookReplayBody {
  reason?: unknown;
  dry_run?: unknown;
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
  replay_count: number | string | null;
  last_replayed_at: Date | string | null;
  has_replay_payload?: boolean | null;
  received_at: Date | string;
  processed_at: Date | string | null;
  updated_at: Date | string;
}

interface ProviderWebhookReplayRow extends WebhookEventRow {
  merchant_ref: string | null;
  encrypted_payload: string | null;
  safe_headers_json: unknown;
}

interface PaymentIntentForWebhookRow {
  id: string;
  tenant_id: string;
  merchant_id: string;
  agent_id: string;
  passport_jti: string;
  amount: number | string;
  currency: string;
  provider: ProviderKey;
  provider_payment_id: string;
  status: CommercePaymentStatus;
  provider_raw_status: string | null;
  policy_version: string | null;
  decision_id: string | null;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseReplayPayload(rawBody: string, fallback: ProviderWebhookReplayRow): {
  event_id: string;
  event_type: string;
  merchant_ref?: string;
  provider_payment_id?: string;
  status?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    parsed = {};
  }
  const obj = isPlainObject(parsed) ? parsed : {};
  const out: {
    event_id: string;
    event_type: string;
    merchant_ref?: string;
    provider_payment_id?: string;
    status?: string;
  } = {
    event_id: typeof obj['event_id'] === 'string' ? obj['event_id'] : fallback.provider_event_id,
    event_type: typeof obj['event_type'] === 'string' ? obj['event_type'] : fallback.provider_event_type,
  };
  if (typeof obj['merchant_ref'] === 'string') out.merchant_ref = obj['merchant_ref'];
  else if (fallback.merchant_ref) out.merchant_ref = fallback.merchant_ref;
  if (typeof obj['provider_payment_id'] === 'string') out.provider_payment_id = obj['provider_payment_id'];
  else if (fallback.provider_payment_id) out.provider_payment_id = fallback.provider_payment_id;
  if (typeof obj['status'] === 'string') out.status = obj['status'];
  return out;
}

function targetStatusForWebhook(eventType: string, providerStatus?: string): CommercePaymentStatus | null {
  if (eventType === 'payment.paid') return 'paid';
  if (eventType === 'payment.failed') return 'failed';
  if (eventType === 'payment.expired') return 'expired';
  if (eventType !== 'payment.updated') return null;
  const status = providerStatus?.toLowerCase();
  if (status === 'paid' || status === 'succeeded' || status === 'success' || status === 'mock_paid') return 'paid';
  if (status === 'failed' || status === 'declined' || status === 'mock_failed') return 'failed';
  if (status === 'expired' || status === 'mock_expired') return 'expired';
  return null;
}

function isReplayTerminalStatus(status: CommercePaymentStatus | null): status is 'paid' | 'failed' | 'expired' {
  return status === 'paid' || status === 'failed' || status === 'expired';
}

function replayBlocker(row: WebhookEventRow): string | null {
  if (row.signature_validation_status !== 'valid') return 'original_signature_not_valid';
  if (row.provider_key !== 'mock') return 'provider_replay_not_supported';
  if (row.replay_status !== 'fresh') return 'webhook_event_duplicate_or_stale';
  if (row.processing_status !== 'failed') return 'webhook_event_not_failed';
  if (row.has_replay_payload !== true) return 'encrypted_payload_not_available';
  return null;
}

function normalizeWebhookEvent(row: WebhookEventRow): Record<string, unknown> {
  const blocker = replayBlocker(row);
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
    replay_count: countFromRow(row.replay_count),
    last_replayed_at: row.last_replayed_at,
    received_at: row.received_at,
    processed_at: row.processed_at,
    updated_at: row.updated_at,
    replay_available: blocker === null,
    replay_blocker: blocker,
  };
}

async function findPaymentIntentForReplay(
  sql: Sql,
  input: {
    providerKey: ProviderKey;
    providerPaymentId?: string;
    merchantRef?: string;
  },
): Promise<PaymentIntentForWebhookRow | null> {
  if (!input.providerPaymentId || !input.merchantRef) return null;
  const rows = await sql<PaymentIntentForWebhookRow[]>`
    SELECT pi.id, pi.tenant_id, pi.merchant_id, pi.agent_id, pi.passport_jti,
           pi.amount, pi.currency, pi.provider, pi.provider_payment_id,
           pi.status, pi.provider_raw_status, pi.policy_version, pi.decision_id,
           pi.updated_at
      FROM commerce_payment_intents pi
      JOIN commerce_merchants m
        ON m.tenant_id = pi.tenant_id
       AND m.id = pi.merchant_id
     WHERE pi.provider = ${input.providerKey}
       AND pi.provider_payment_id = ${input.providerPaymentId}
       AND pi.merchant_id = ${input.merchantRef}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

function paymentAuditEventForTarget(status: 'paid' | 'failed' | 'expired') {
  if (status === 'paid') return 'payment_intent.paid';
  if (status === 'failed') return 'payment_intent.failed';
  return 'payment_intent.expired';
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
    blockers.push('plural_live_readiness_blocked');
    blockers.push('provider_webhook_replay_non_mock_not_approved');
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
        SELECT e.id, e.tenant_id, e.provider_key, e.merchant_id, e.payment_intent_id,
               e.provider_payment_id, e.provider_event_id, e.provider_event_type,
               e.signature_validation_status, e.replay_status, e.processing_status,
               e.payload_hash, e.error_code, e.error_message, e.attempt_count,
               e.replay_count, e.last_replayed_at,
               (p.webhook_event_id IS NOT NULL) AS has_replay_payload,
               e.received_at, e.processed_at, e.updated_at
          FROM commerce_provider_webhook_events e
          LEFT JOIN commerce_provider_webhook_event_payloads p
            ON p.tenant_id = e.tenant_id
           AND p.webhook_event_id = e.id
         WHERE e.tenant_id = ${tenantId}
           AND (${merchantId}::text IS NULL OR e.merchant_id = ${merchantId})
           AND (${providerKey}::text IS NULL OR e.provider_key = ${providerKey})
           AND e.processing_status = ${processingStatus}
         ORDER BY e.received_at DESC
         LIMIT ${limit}
      `;
      return reply.status(200).send({
        items: rows.map(normalizeWebhookEvent),
        next_cursor: null,
        replay_available: rows.some((row) => replayBlocker(row) === null),
        replay_blocker: rows.some((row) => replayBlocker(row) === null) ? null : 'no_replayable_failed_provider_webhook_events',
      });
    },
  );

  app.post<{
    Params: ProviderWebhookReplayParams;
    Body: ProviderWebhookReplayBody;
  }>(
    '/ops/provider-webhook-events/:event_id/replay',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      requireOperator(request);
      const tenantId = request.commerceTenantId;
      if (!tenantId) {
        throw new CommerceHttpError(422, 'tenant_context_required',
          'Commerce provider webhook replay requires a tenant-bound operator',
          { retryable: false });
      }
      if (request.body !== undefined && !isPlainObject(request.body)) {
        throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
          { details: { fields: { body: 'must be a JSON object' } }, retryable: false });
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const fieldErrors: Record<string, string> = {};
      const unsupportedFields = Object.keys(body).filter((key) => key !== 'reason' && key !== 'dry_run');
      if (unsupportedFields.length > 0) {
        fieldErrors['unsupported_fields'] =
          `unsupported fields: ${unsupportedFields.map((key) => key.replace(/[\r\n\t]/g, '_')).join(', ')}`;
      }
      if (!nonEmptyString(body['reason'])) fieldErrors['reason'] = 'required non-empty string';
      if (body['dry_run'] !== undefined && typeof body['dry_run'] !== 'boolean') {
        fieldErrors['dry_run'] = 'must be a boolean';
      }
      if (Object.keys(fieldErrors).length > 0) {
        throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
          { details: { fields: fieldErrors }, retryable: false });
      }
      const reason = (body['reason'] as string).trim();
      const dryRun = body['dry_run'] === true;
      const sql = getSql();
      const rows = await sql<ProviderWebhookReplayRow[]>`
        SELECT e.id, e.tenant_id, e.provider_key, e.merchant_id, e.payment_intent_id,
               e.provider_payment_id, e.merchant_ref, e.provider_event_id,
               e.provider_event_type, e.signature_validation_status,
               e.replay_status, e.processing_status, e.payload_hash,
               e.error_code, e.error_message, e.attempt_count,
               e.replay_count, e.last_replayed_at,
               (p.webhook_event_id IS NOT NULL) AS has_replay_payload,
               p.encrypted_payload, p.safe_headers_json,
               e.received_at, e.processed_at, e.updated_at
          FROM commerce_provider_webhook_events e
          LEFT JOIN commerce_provider_webhook_event_payloads p
            ON p.tenant_id = e.tenant_id
           AND p.webhook_event_id = e.id
         WHERE e.tenant_id = ${tenantId}
           AND e.id = ${request.params.event_id}
         LIMIT 1
      `;
      const event = rows[0];
      if (!event) {
        throw new CommerceHttpError(404, 'provider_webhook_event_not_found',
          'Provider webhook event not found in this tenant');
      }
      let blocker = replayBlocker(event);
      let rawBody: string | null = null;
      if (!blocker && event.encrypted_payload) {
        rawBody = decrypt(event.encrypted_payload);
        if (sha256hex(rawBody) !== event.payload_hash) {
          blocker = 'payload_hash_mismatch';
        }
      }
      if (blocker || !rawBody || !isProviderKey(event.provider_key)) {
        const audit = await appendCommerceAudit(sql, {
          tenantId,
          merchantId: event.merchant_id,
          eventType: 'provider_webhook.replay_denied',
          resourceType: 'commerce_provider_webhook_event',
          resourceId: event.id,
          requestId: request.id,
          metadata: {
            provider_key: event.provider_key,
            provider_event_id: event.provider_event_id,
            provider_event_type: event.provider_event_type,
            reason,
            blocker: blocker ?? 'provider_replay_not_supported',
            dry_run: dryRun,
          },
        });
        throw new CommerceHttpError(409, 'provider_webhook_replay_denied',
          'Provider webhook event is not eligible for replay',
          { retryable: false, auditEventId: audit.id, details: { blocker: blocker ?? 'provider_replay_not_supported' } });
      }

      const parsed = parseReplayPayload(rawBody, event);
      const targetStatus = targetStatusForWebhook(parsed.event_type, parsed.status);
      const paymentIntentLookup: {
        providerKey: ProviderKey;
        providerPaymentId?: string;
        merchantRef?: string;
      } = { providerKey: event.provider_key };
      if (parsed.provider_payment_id !== undefined) {
        paymentIntentLookup.providerPaymentId = parsed.provider_payment_id;
      }
      if (parsed.merchant_ref !== undefined) {
        paymentIntentLookup.merchantRef = parsed.merchant_ref;
      }
      const paymentIntent = await findPaymentIntentForReplay(sql, paymentIntentLookup);
      if (!paymentIntent || paymentIntent.tenant_id !== tenantId || paymentIntent.id !== event.payment_intent_id) {
        const audit = await appendCommerceAudit(sql, {
          tenantId,
          merchantId: event.merchant_id,
          eventType: 'provider_webhook.replay_denied',
          resourceType: 'commerce_provider_webhook_event',
          resourceId: event.id,
          requestId: request.id,
          metadata: {
            provider_key: event.provider_key,
            provider_event_id: event.provider_event_id,
            provider_event_type: event.provider_event_type,
            reason,
            blocker: 'payment_intent_not_found',
            dry_run: dryRun,
          },
        });
        throw new CommerceHttpError(409, 'provider_webhook_replay_denied',
          'Provider webhook event cannot be replayed without its tenant-bound payment intent',
          { retryable: false, auditEventId: audit.id, details: { blocker: 'payment_intent_not_found' } });
      }
      if (!isReplayTerminalStatus(targetStatus)) {
        const audit = await appendCommerceAudit(sql, {
          tenantId,
          merchantId: paymentIntent.merchant_id,
          agentId: paymentIntent.agent_id,
          eventType: 'provider_webhook.replay_denied',
          resourceType: 'commerce_provider_webhook_event',
          resourceId: event.id,
          passportJti: paymentIntent.passport_jti,
          policyVersion: paymentIntent.policy_version,
          decisionId: paymentIntent.decision_id,
          requestId: request.id,
          metadata: {
            provider_key: event.provider_key,
            provider_event_id: event.provider_event_id,
            provider_event_type: event.provider_event_type,
            reason,
            blocker: 'unsupported_provider_event',
            dry_run: dryRun,
          },
        });
        throw new CommerceHttpError(409, 'provider_webhook_replay_denied',
          'Provider webhook event type or status is not replayable',
          { retryable: false, auditEventId: audit.id, details: { blocker: 'unsupported_provider_event' } });
      }
      if (dryRun) {
        return reply.status(200).send({
          data: {
            status: 'eligible',
            dry_run: true,
            event_id: event.id,
            provider_key: event.provider_key,
            provider_event_id: event.provider_event_id,
            provider_event_type: event.provider_event_type,
            payment_intent_id: paymentIntent.id,
            current_payment_status: paymentIntent.status,
            target_payment_status: targetStatus,
            replay_count: countFromRow(event.replay_count),
          },
        });
      }

      const result = await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        const requestedAudit = await appendCommerceAudit(tx as unknown as Sql, {
          tenantId,
          merchantId: paymentIntent.merchant_id,
          agentId: paymentIntent.agent_id,
          eventType: 'provider_webhook.replay_requested',
          resourceType: 'commerce_provider_webhook_event',
          resourceId: event.id,
          passportJti: paymentIntent.passport_jti,
          policyVersion: paymentIntent.policy_version,
          decisionId: paymentIntent.decision_id,
          requestId: request.id,
          metadata: {
            provider_key: event.provider_key,
            provider_event_id: event.provider_event_id,
            provider_event_type: event.provider_event_type,
            reason,
          },
        });

        if (paymentIntent.status === targetStatus) {
          await tx`
            UPDATE commerce_provider_webhook_events
               SET processing_status = 'ignored',
                   error_code = 'transition_already_applied',
                   error_message = 'Payment intent is already in the provider webhook target state',
                   replay_count = replay_count + 1,
                   last_replayed_at = NOW(),
                   processed_at = NOW(),
                   updated_at = NOW()
             WHERE id = ${event.id}
               AND tenant_id = ${tenantId}
          `;
          const replayedAudit = await appendCommerceAudit(tx as unknown as Sql, {
            tenantId,
            merchantId: paymentIntent.merchant_id,
            agentId: paymentIntent.agent_id,
            eventType: 'provider_webhook.replayed',
            resourceType: 'commerce_provider_webhook_event',
            resourceId: event.id,
            passportJti: paymentIntent.passport_jti,
            policyVersion: paymentIntent.policy_version,
            decisionId: paymentIntent.decision_id,
            requestId: request.id,
            metadata: {
              provider_key: event.provider_key,
              provider_event_id: event.provider_event_id,
              provider_event_type: event.provider_event_type,
              result: 'duplicate',
              from_status: paymentIntent.status,
              to_status: targetStatus,
              reason,
            },
          });
          return {
            data: {
              status: 'duplicate',
              event_id: event.id,
              provider_event_id: event.provider_event_id,
              payment_intent_id: paymentIntent.id,
              payment_status: paymentIntent.status,
            },
            requested_audit_event_id: requestedAudit.id,
            audit_event_id: replayedAudit.id,
          };
        }

        try {
          assertPaymentStatusTransition(paymentIntent.status, targetStatus);
        } catch {
          const deniedAudit = await appendCommerceAudit(tx as unknown as Sql, {
            tenantId,
            merchantId: paymentIntent.merchant_id,
            agentId: paymentIntent.agent_id,
            eventType: 'provider_webhook.replay_denied',
            resourceType: 'commerce_provider_webhook_event',
            resourceId: event.id,
            passportJti: paymentIntent.passport_jti,
            policyVersion: paymentIntent.policy_version,
            decisionId: paymentIntent.decision_id,
            requestId: request.id,
            metadata: {
              provider_key: event.provider_key,
              provider_event_id: event.provider_event_id,
              provider_event_type: event.provider_event_type,
              reason,
              blocker: 'invalid_payment_status_transition',
              from_status: paymentIntent.status,
              to_status: targetStatus,
            },
          });
          return {
            error: {
              statusCode: 409,
              code: 'invalid_payment_status_transition',
              message: `Cannot replay provider webhook transition ${paymentIntent.status} -> ${targetStatus}`,
              auditEventId: deniedAudit.id,
            },
            requested_audit_event_id: requestedAudit.id,
          };
        }

        const updatedRows = await tx<PaymentIntentForWebhookRow[]>`
          UPDATE commerce_payment_intents
             SET status = ${targetStatus},
                 provider_raw_status = ${parsed.status ?? parsed.event_type},
                 provider_metadata = COALESCE(provider_metadata, '{}'::jsonb)
                   || ${JSON.stringify({
                     last_webhook_event_id: parsed.event_id,
                     last_webhook_event_type: parsed.event_type,
                     replayed_webhook_event_id: event.id,
                   })}::jsonb,
                 updated_at = NOW()
           WHERE id = ${paymentIntent.id}
             AND tenant_id = ${paymentIntent.tenant_id}
             AND merchant_id = ${paymentIntent.merchant_id}
             AND provider = ${event.provider_key}
             AND provider_payment_id = ${parsed.provider_payment_id ?? null}
             AND status = ${paymentIntent.status}
          RETURNING id, tenant_id, merchant_id, agent_id, passport_jti,
                    amount, currency, provider, provider_payment_id,
                    status, provider_raw_status, policy_version, decision_id,
                    updated_at
        `;
        const updated = updatedRows[0];
        if (!updated) {
          const deniedAudit = await appendCommerceAudit(tx as unknown as Sql, {
            tenantId,
            merchantId: paymentIntent.merchant_id,
            agentId: paymentIntent.agent_id,
            eventType: 'provider_webhook.replay_denied',
            resourceType: 'commerce_provider_webhook_event',
            resourceId: event.id,
            passportJti: paymentIntent.passport_jti,
            policyVersion: paymentIntent.policy_version,
            decisionId: paymentIntent.decision_id,
            requestId: request.id,
            metadata: {
              provider_key: event.provider_key,
              provider_event_id: event.provider_event_id,
              provider_event_type: event.provider_event_type,
              reason,
              blocker: 'payment_status_changed',
            },
          });
          return {
            error: {
              statusCode: 409,
              code: 'payment_status_changed',
              message: 'Payment intent status changed before provider webhook replay completed',
              auditEventId: deniedAudit.id,
            },
            requested_audit_event_id: requestedAudit.id,
          };
        }

        await tx`
          UPDATE commerce_provider_webhook_events
             SET processing_status = 'processed',
                 error_code = NULL,
                 error_message = NULL,
                 replay_count = replay_count + 1,
                 attempt_count = attempt_count + 1,
                 last_replayed_at = NOW(),
                 processed_at = NOW(),
                 updated_at = NOW()
           WHERE id = ${event.id}
             AND tenant_id = ${tenantId}
        `;
        const paymentAudit = await appendCommerceAudit(tx as unknown as Sql, {
          tenantId: updated.tenant_id,
          merchantId: updated.merchant_id,
          agentId: updated.agent_id,
          eventType: paymentAuditEventForTarget(targetStatus),
          resourceType: 'commerce_payment_intent',
          resourceId: updated.id,
          passportJti: updated.passport_jti,
          policyVersion: updated.policy_version,
          decisionId: updated.decision_id,
          requestId: request.id,
          metadata: {
            provider_key: event.provider_key,
            provider_event_id: parsed.event_id,
            provider_event_type: parsed.event_type,
            provider_payment_id: parsed.provider_payment_id ?? null,
            webhook_event_id: event.id,
            replay: true,
            from_status: paymentIntent.status,
            to_status: updated.status,
          },
        });
        const replayedAudit = await appendCommerceAudit(tx as unknown as Sql, {
          tenantId: updated.tenant_id,
          merchantId: updated.merchant_id,
          agentId: updated.agent_id,
          eventType: 'provider_webhook.replayed',
          resourceType: 'commerce_provider_webhook_event',
          resourceId: event.id,
          passportJti: updated.passport_jti,
          policyVersion: updated.policy_version,
          decisionId: updated.decision_id,
          requestId: request.id,
          metadata: {
            provider_key: event.provider_key,
            provider_event_id: parsed.event_id,
            provider_event_type: parsed.event_type,
            provider_payment_id: parsed.provider_payment_id ?? null,
            payment_audit_event_id: paymentAudit.id,
            result: 'processed',
            from_status: paymentIntent.status,
            to_status: updated.status,
            reason,
          },
        });
        return {
          data: {
            status: 'processed',
            event_id: event.id,
            provider_event_id: parsed.event_id,
            payment_intent_id: updated.id,
            payment_status: updated.status,
          },
          requested_audit_event_id: requestedAudit.id,
          audit_event_id: replayedAudit.id,
          payment_audit_event_id: paymentAudit.id,
        };
      });

      if ('error' in result) {
        const error = result.error as {
          statusCode: number;
          code: string;
          message: string;
          auditEventId?: string;
        };
        throw new CommerceHttpError(error.statusCode, error.code, error.message, {
          retryable: false,
          ...(error.auditEventId ? { auditEventId: error.auditEventId } : {}),
        });
      }

      return reply.status(200).send(result);
    },
  );
}
