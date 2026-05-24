import type { FastifyInstance, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import { getSql, type TxSql } from '../db/client.js';
import {
  commerceErrorHandler,
  CommerceHttpError,
} from '../lib/commerce/errors.js';
import { appendCommerceAudit } from '../lib/commerce/audit.js';
import { newCommerceWebhookEventId } from '../lib/commerce/ids.js';
import { stableJson } from '../lib/commerce/idempotency.js';
import { sha256hex } from '../lib/hash.js';
import { encrypt } from '../lib/vault-crypto.js';
import {
  getPaymentProvider,
  isPaymentProviderError,
  type ProviderKey,
} from '../lib/commerce/payment-providers/index.js';
import { ensureCommerceLiveMode } from '../lib/commerce/live-mode-guard.js';
import {
  assertPaymentStatusTransition,
  type CommercePaymentStatus,
} from '../lib/commerce/payment-state.js';
import { commerceCriticalFlowTotal } from '../lib/metrics.js';
import { commerceLogContext, hashedReference } from '../lib/commerce/observability.js';

type Sql = ReturnType<typeof postgres>;

interface ProviderWebhookParams {
  provider_key: string;
}

interface ParsedWebhookPayload {
  event_id: string;
  event_type: string;
  merchant_ref?: string;
  provider_payment_id?: string;
  status?: string;
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

interface ExistingWebhookRow {
  id: string;
  payment_intent_id: string | null;
  processing_status: string;
}

interface ProviderWebhookRouteError {
  statusCode: number;
  code: string;
  message: string;
  retryable: boolean;
  auditEventId?: string;
}

const providerKeys = new Set<string>(['mock', 'plural']);
const supportedEventTypes = new Set([
  'payment.updated',
  'payment.paid',
  'payment.failed',
  'payment.expired',
]);

function isCommerceV1Enabled(): boolean {
  return process.env['COMMERCE_V1_ENABLED'] === 'true';
}

function isProviderKey(v: string): v is ProviderKey {
  return providerKeys.has(v);
}

function headersToRecord(headers: FastifyRequest['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') out[key.toLowerCase()] = value;
    else if (Array.isArray(value) && typeof value[0] === 'string') out[key.toLowerCase()] = value[0];
  }
  return out;
}

function requestBodyToRaw(body: unknown): string {
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (typeof body === 'string') return body;
  return stableJson(body ?? {});
}

function safeHeaderMetadata(
  providerKey: ProviderKey,
  headers: FastifyRequest['headers'],
): Record<string, unknown> {
  if (providerKey === 'mock') {
    return {
      signature_scheme: 'mock-hmac-sha256-v1',
      timestamp_header_present: headers['x-mock-timestamp'] !== undefined,
      signature_header_present: headers['x-mock-signature'] !== undefined,
    };
  }
  return { signature_scheme: 'unsupported_provider_replay_contract' };
}

function parseWebhookPayload(rawBody: string, payloadHash: string): ParsedWebhookPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    parsed = {};
  }
  const obj = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  const eventId = typeof obj['event_id'] === 'string' && obj['event_id'].length > 0
    ? obj['event_id']
    : `unknown_${payloadHash.slice(0, 24)}`;
  const eventType = typeof obj['event_type'] === 'string' && obj['event_type'].length > 0
    ? obj['event_type']
    : 'unknown';
  const out: ParsedWebhookPayload = {
    event_id: eventId,
    event_type: eventType,
  };
  if (typeof obj['merchant_ref'] === 'string' && obj['merchant_ref'].length > 0) {
    out.merchant_ref = obj['merchant_ref'];
  }
  if (typeof obj['provider_payment_id'] === 'string' && obj['provider_payment_id'].length > 0) {
    out.provider_payment_id = obj['provider_payment_id'];
  }
  if (typeof obj['status'] === 'string' && obj['status'].length > 0) {
    out.status = obj['status'];
  }
  return out;
}

function targetStatusForWebhook(eventType: string, providerStatus?: string): CommercePaymentStatus | null {
  if (!supportedEventTypes.has(eventType)) return null;
  if (eventType === 'payment.paid') return 'paid';
  if (eventType === 'payment.failed') return 'failed';
  if (eventType === 'payment.expired') return 'expired';
  const status = providerStatus?.toLowerCase();
  if (status === 'paid' || status === 'succeeded' || status === 'success' || status === 'mock_paid') return 'paid';
  if (status === 'failed' || status === 'declined' || status === 'mock_failed') return 'failed';
  if (status === 'expired' || status === 'mock_expired') return 'expired';
  return null;
}

async function findPaymentIntentForWebhook(
  sql: Sql,
  input: {
    providerKey: ProviderKey;
    providerPaymentId?: string | undefined;
    merchantRef?: string | undefined;
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

async function insertWebhookEvent(
  sql: TxSql,
  input: {
    providerKey: ProviderKey;
    payloadHash: string;
    receivedAt: string;
    parsed: ParsedWebhookPayload;
    paymentIntent: PaymentIntentForWebhookRow | null;
    signatureStatus: 'valid' | 'invalid' | 'blocked';
    replayStatus: 'fresh' | 'duplicate' | 'stale';
    processingStatus: 'received' | 'processed' | 'ignored' | 'failed';
    errorCode?: string;
    errorMessage?: string;
    providerMetadata?: Record<string, unknown> | undefined;
  },
): Promise<string | null> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO commerce_provider_webhook_events (
      id, tenant_id, source_type, source_key, provider_key,
      merchant_id, payment_intent_id, provider_payment_id, merchant_ref,
      provider_event_id, provider_event_type,
      signature_validation_status, replay_status, processing_status,
      payload_hash, raw_payload_ref, provider_metadata,
      error_code, error_message, received_at, processed_at
    ) VALUES (
      ${newCommerceWebhookEventId()},
      ${input.paymentIntent?.tenant_id ?? null},
      ${'provider'},
      ${input.providerKey},
      ${input.providerKey},
      ${input.paymentIntent?.merchant_id ?? null},
      ${input.paymentIntent?.id ?? null},
      ${input.parsed.provider_payment_id ?? null},
      ${input.parsed.merchant_ref ?? null},
      ${input.parsed.event_id},
      ${input.parsed.event_type},
      ${input.signatureStatus},
      ${input.replayStatus},
      ${input.processingStatus},
      ${input.payloadHash},
      NULL,
      ${JSON.stringify(input.providerMetadata ?? {})}::jsonb,
      ${input.errorCode ?? null},
      ${input.errorMessage ?? null},
      ${input.receivedAt}::timestamptz,
      ${input.processingStatus === 'received' ? null : input.receivedAt}::timestamptz
    )
    ON CONFLICT (provider_key, provider_event_id) DO NOTHING
    RETURNING id
  `;
  return rows[0]?.id ?? null;
}

async function updateWebhookEventStatus(
  sql: TxSql,
  input: {
    id: string | null;
    processingStatus: 'processed' | 'ignored' | 'failed';
    errorCode?: string;
    errorMessage?: string;
  },
): Promise<void> {
  if (!input.id) return;
  await sql`
    UPDATE commerce_provider_webhook_events
       SET processing_status = ${input.processingStatus},
           error_code = ${input.errorCode ?? null},
           error_message = ${input.errorMessage ?? null},
           processed_at = NOW(),
           updated_at = NOW()
     WHERE id = ${input.id}
  `;
}

async function storeProviderWebhookReplayPayload(
  sql: TxSql,
  input: {
    tenantId: string;
    webhookEventId: string | null;
    providerKey: ProviderKey;
    signatureValid: boolean;
    payloadHash: string;
    rawBody: string;
    safeHeaders: Record<string, unknown>;
  },
): Promise<void> {
  if (!input.webhookEventId || !input.signatureValid || input.providerKey !== 'mock') {
    return;
  }
  await sql`
    INSERT INTO commerce_provider_webhook_event_payloads (
      tenant_id, webhook_event_id, provider_key, payload_hash,
      encrypted_payload, safe_headers_json
    ) VALUES (
      ${input.tenantId}, ${input.webhookEventId}, ${input.providerKey},
      ${input.payloadHash}, ${encrypt(input.rawBody)},
      ${JSON.stringify(input.safeHeaders)}::jsonb
    )
    ON CONFLICT (webhook_event_id) DO NOTHING
  `;
}

async function appendProviderWebhookReceivedAudit(
  sql: Sql,
  request: FastifyRequest,
  input: {
    paymentIntent: PaymentIntentForWebhookRow;
    webhookEventId: string;
    parsed: ParsedWebhookPayload;
    providerKey: ProviderKey;
  },
): Promise<string> {
  const audit = await appendCommerceAudit(sql, {
    tenantId: input.paymentIntent.tenant_id,
    merchantId: input.paymentIntent.merchant_id,
    agentId: input.paymentIntent.agent_id,
    eventType: 'provider.webhook.received',
    resourceType: 'commerce_provider_webhook_event',
    resourceId: input.webhookEventId,
    passportJti: input.paymentIntent.passport_jti,
    policyVersion: input.paymentIntent.policy_version,
    decisionId: input.paymentIntent.decision_id,
    requestId: request.id,
    metadata: {
      provider_key: input.providerKey,
      provider_event_id: input.parsed.event_id,
      provider_event_type: input.parsed.event_type,
      provider_payment_id: input.parsed.provider_payment_id ?? null,
    },
  });
  return audit.id;
}

async function appendWebhookDeniedAudit(
  sql: Sql,
  request: FastifyRequest,
  input: {
    paymentIntent: PaymentIntentForWebhookRow;
    webhookEventId: string | null;
    parsed: ParsedWebhookPayload;
    providerKey: ProviderKey;
    reason: string;
    fromStatus?: string;
    toStatus?: string;
  },
): Promise<string> {
  const audit = await appendCommerceAudit(sql, {
    tenantId: input.paymentIntent.tenant_id,
    merchantId: input.paymentIntent.merchant_id,
    agentId: input.paymentIntent.agent_id,
    eventType: 'protected_action.denied',
    resourceType: 'commerce_payment_intent',
    resourceId: input.paymentIntent.id,
    passportJti: input.paymentIntent.passport_jti,
    policyVersion: input.paymentIntent.policy_version,
    decisionId: input.paymentIntent.decision_id,
    requestId: request.id,
    metadata: {
      action: 'provider_webhook.process',
      reason: input.reason,
      webhook_event_id: input.webhookEventId,
      provider_key: input.providerKey,
      provider_event_id: input.parsed.event_id,
      provider_event_type: input.parsed.event_type,
      provider_payment_id: input.parsed.provider_payment_id ?? null,
      from_status: input.fromStatus ?? null,
      to_status: input.toStatus ?? null,
    },
  });
  return audit.id;
}

async function recordRejectedWebhook(
  sql: Sql,
  request: FastifyRequest,
  input: {
    providerKey: ProviderKey;
    parsed: ParsedWebhookPayload;
    payloadHash: string;
    receivedAt: string;
    signatureStatus: 'valid' | 'invalid' | 'blocked';
    replayStatus: 'fresh' | 'stale';
    errorCode: string;
    errorMessage: string;
    auditEventType: 'provider.webhook.signature_failed' | 'protected_action.denied';
  },
): Promise<string | null> {
  const paymentIntent = await findPaymentIntentForWebhook(sql, {
    providerKey: input.providerKey,
    providerPaymentId: input.parsed.provider_payment_id,
    merchantRef: input.parsed.merchant_ref,
  });
  return sql.begin(async (_tx) => {
    const tx = _tx as unknown as TxSql;
    const webhookEventId = await insertWebhookEvent(tx, {
      providerKey: input.providerKey,
      payloadHash: input.payloadHash,
      receivedAt: input.receivedAt,
      parsed: input.parsed,
      paymentIntent,
      signatureStatus: input.signatureStatus,
      replayStatus: input.replayStatus,
      processingStatus: 'failed',
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
    });
    if (!paymentIntent) return null;
    const audit = await appendCommerceAudit(tx as unknown as Sql, {
      tenantId: paymentIntent.tenant_id,
      merchantId: paymentIntent.merchant_id,
      agentId: paymentIntent.agent_id,
      eventType: input.auditEventType,
      resourceType: 'commerce_provider_webhook_event',
      resourceId: webhookEventId,
      passportJti: paymentIntent.passport_jti,
      policyVersion: paymentIntent.policy_version,
      decisionId: paymentIntent.decision_id,
      requestId: request.id,
      metadata: {
        action: 'provider_webhook.verify',
        reason: input.errorCode,
        provider_key: input.providerKey,
        provider_event_id: input.parsed.event_id,
        provider_event_type: input.parsed.event_type,
        provider_payment_id: input.parsed.provider_payment_id ?? null,
      },
    });
    return audit.id;
  });
}

export async function commerceProviderWebhookRoutes(app: FastifyInstance): Promise<void> {
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

  app.post<{ Params: ProviderWebhookParams }>(
    '/:provider_key',
    { config: { skipAuth: true, rateLimit: { max: 1000, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const providerKeyParam = request.params.provider_key;
      if (!isProviderKey(providerKeyParam)) {
        throw new CommerceHttpError(404, 'provider_not_found',
          'Provider webhook route is not registered for this provider', { retryable: false });
      }
      const providerKey = providerKeyParam;
      // P0-23 — incoming provider webhooks advance payment state for
      // their issuing provider. Gate on the same live-mode flag used
      // by the outbound provider calls so that, for example, a Plural
      // event arriving at a deployment without PLURAL_LIVE_ENABLED is
      // rejected before any state transition runs. The environment is
      // not on the URL; pass providerKey alone — mock is permitted in
      // every deployment, plural falls under the plural-specific gate.
      ensureCommerceLiveMode({ providerKey });
      const receivedAt = new Date().toISOString();
      const rawBody = requestBodyToRaw(request.body);
      const payloadHash = sha256hex(rawBody);
      const parsedFallback = parseWebhookPayload(rawBody, payloadHash);
      const provider = getPaymentProvider(providerKey);
      let providerEvent: ParsedWebhookPayload & {
        signature_valid: boolean;
        replay: boolean;
        provider_metadata?: Record<string, unknown>;
      };

      try {
        const handled = await provider.handleWebhook({
          provider_key: providerKey,
          headers: headersToRecord(request.headers),
          raw_body: rawBody,
          received_at: receivedAt,
        });
        providerEvent = {
          event_id: handled.event_id,
          event_type: handled.event_type,
          signature_valid: handled.signature_valid,
          replay: handled.replay,
        };
        if (handled.merchant_ref !== undefined) providerEvent.merchant_ref = handled.merchant_ref;
        if (handled.provider_payment_id !== undefined) providerEvent.provider_payment_id = handled.provider_payment_id;
        if (handled.status !== undefined) providerEvent.status = handled.status;
        if (handled.provider_metadata !== undefined) providerEvent.provider_metadata = handled.provider_metadata;
      } catch (err) {
        if (isPaymentProviderError(err)) {
          if (err.normalized.code === 'webhook_signature_invalid') {
            const auditEventId = await recordRejectedWebhook(getSql(), request, {
              providerKey,
              parsed: parsedFallback,
              payloadHash,
              receivedAt,
              signatureStatus: 'invalid',
              replayStatus: 'fresh',
              errorCode: err.normalized.code,
              errorMessage: err.normalized.message,
              auditEventType: 'provider.webhook.signature_failed',
            });
            const errorOptions = {
              retryable: err.normalized.retryable,
              details: {
                provider_key: err.normalized.provider_key,
                provider_error_code: err.normalized.provider_error_code,
              },
              ...(auditEventId ? { auditEventId } : {}),
            };
            commerceCriticalFlowTotal.labels('provider_webhook.process', 'signature_failed', err.normalized.code).inc();
            request.log.warn(commerceLogContext({
              requestId: request.id,
              providerKey,
              webhookProviderEventIdRef: hashedReference(parsedFallback.event_id, 'provider_event'),
              providerPaymentIdRef: parsedFallback.provider_payment_id
                ? hashedReference(parsedFallback.provider_payment_id, 'provider_payment')
                : undefined,
              errorCode: err.normalized.code,
            }), 'commerce.provider_webhook.signature_failed');
            throw new CommerceHttpError(401, err.normalized.code, err.normalized.message, errorOptions);
          }
          if (err.normalized.code === 'webhook_replay_detected') {
            const auditEventId = await recordRejectedWebhook(getSql(), request, {
              providerKey,
              parsed: parsedFallback,
              payloadHash,
              receivedAt,
              signatureStatus: 'valid',
              replayStatus: 'stale',
              errorCode: err.normalized.code,
              errorMessage: err.normalized.message,
              auditEventType: 'protected_action.denied',
            });
            const errorOptions = {
              retryable: err.normalized.retryable,
              details: {
                provider_key: err.normalized.provider_key,
                provider_error_code: err.normalized.provider_error_code,
              },
              ...(auditEventId ? { auditEventId } : {}),
            };
            commerceCriticalFlowTotal.labels('provider_webhook.process', 'replay_rejected', err.normalized.code).inc();
            request.log.warn(commerceLogContext({
              requestId: request.id,
              providerKey,
              webhookProviderEventIdRef: hashedReference(parsedFallback.event_id, 'provider_event'),
              providerPaymentIdRef: parsedFallback.provider_payment_id
                ? hashedReference(parsedFallback.provider_payment_id, 'provider_payment')
                : undefined,
              errorCode: err.normalized.code,
            }), 'commerce.provider_webhook.replay_rejected');
            throw new CommerceHttpError(409, err.normalized.code, err.normalized.message, errorOptions);
          }
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

      const sql = getSql();
      const existingRows = await sql<ExistingWebhookRow[]>`
        SELECT id, payment_intent_id, processing_status
          FROM commerce_provider_webhook_events
         WHERE provider_key = ${providerKey}
           AND provider_event_id = ${providerEvent.event_id}
         LIMIT 1
      `;
      const existing = existingRows[0];
      if (existing) {
        commerceCriticalFlowTotal.labels('provider_webhook.process', 'duplicate', '').inc();
        request.log.info(commerceLogContext({
          requestId: request.id,
          providerKey,
          webhookEventId: existing.id,
          webhookProviderEventIdRef: hashedReference(providerEvent.event_id, 'provider_event'),
          paymentIntentId: existing.payment_intent_id,
          status: existing.processing_status,
        }), 'commerce.provider_webhook.duplicate');
        return reply.status(200).send({
          data: {
            status: 'duplicate',
            event_id: providerEvent.event_id,
            payment_intent_id: existing.payment_intent_id,
            processing_status: existing.processing_status,
          },
        });
      }

      const parsed: ParsedWebhookPayload = {
        event_id: providerEvent.event_id,
        event_type: providerEvent.event_type,
      };
      if (providerEvent.merchant_ref !== undefined) parsed.merchant_ref = providerEvent.merchant_ref;
      if (providerEvent.provider_payment_id !== undefined) parsed.provider_payment_id = providerEvent.provider_payment_id;
      if (providerEvent.status !== undefined) parsed.status = providerEvent.status;
      const paymentIntent = await findPaymentIntentForWebhook(sql, {
        providerKey,
        providerPaymentId: parsed.provider_payment_id,
        merchantRef: parsed.merchant_ref,
      });

      const response = await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        const webhookEventId = await insertWebhookEvent(tx, {
          providerKey,
          payloadHash,
          receivedAt,
          parsed,
          paymentIntent,
          signatureStatus: providerEvent.signature_valid ? 'valid' : 'invalid',
          replayStatus: providerEvent.replay ? 'duplicate' : 'fresh',
          processingStatus: 'received',
          providerMetadata: providerEvent.provider_metadata,
        });
        if (!webhookEventId) {
          return {
            data: {
              status: 'duplicate',
              event_id: parsed.event_id,
              payment_intent_id: paymentIntent?.id ?? null,
              processing_status: 'processed',
            },
          };
        }
        if (paymentIntent) {
          await storeProviderWebhookReplayPayload(tx, {
            tenantId: paymentIntent.tenant_id,
            webhookEventId,
            providerKey,
            signatureValid: providerEvent.signature_valid,
            payloadHash,
            rawBody,
            safeHeaders: safeHeaderMetadata(providerKey, request.headers),
          });
        }
        if (!paymentIntent) {
          await updateWebhookEventStatus(tx, {
            id: webhookEventId,
            processingStatus: 'ignored',
            errorCode: 'payment_intent_not_found',
            errorMessage: 'No matching Grantex payment intent was found for the provider event',
          });
          return {
            data: {
              status: 'ignored',
              reason: 'payment_intent_not_found',
              event_id: parsed.event_id,
              payment_intent_id: null,
            },
          };
        }

        const receivedAuditId = await appendProviderWebhookReceivedAudit(tx as unknown as Sql, request, {
          paymentIntent,
          webhookEventId,
          parsed,
          providerKey,
        });

        const targetStatus = targetStatusForWebhook(parsed.event_type, parsed.status);
        if (!targetStatus) {
          await updateWebhookEventStatus(tx, {
            id: webhookEventId,
            processingStatus: 'ignored',
            errorCode: 'unsupported_provider_event',
            errorMessage: 'Provider webhook event type or status is not supported',
          });
          const deniedAuditId = await appendWebhookDeniedAudit(tx as unknown as Sql, request, {
            paymentIntent,
            webhookEventId,
            parsed,
            providerKey,
            reason: 'unsupported_provider_event',
          });
          return {
            data: {
              status: 'ignored',
              reason: 'unsupported_provider_event',
              event_id: parsed.event_id,
              payment_intent_id: paymentIntent.id,
            },
            received_audit_event_id: receivedAuditId,
            audit_event_id: deniedAuditId,
          };
        }

        if (paymentIntent.status === targetStatus) {
          await updateWebhookEventStatus(tx, {
            id: webhookEventId,
            processingStatus: 'ignored',
            errorCode: 'transition_already_applied',
            errorMessage: 'Payment intent is already in the provider webhook target state',
          });
          return {
            data: {
              status: 'duplicate',
              reason: 'transition_already_applied',
              event_id: parsed.event_id,
              payment_intent_id: paymentIntent.id,
              payment_status: paymentIntent.status,
            },
            received_audit_event_id: receivedAuditId,
          };
        }

        try {
          assertPaymentStatusTransition(paymentIntent.status, targetStatus);
        } catch {
          await updateWebhookEventStatus(tx, {
            id: webhookEventId,
            processingStatus: 'failed',
            errorCode: 'invalid_payment_status_transition',
            errorMessage: `Invalid payment status transition: ${paymentIntent.status} -> ${targetStatus}`,
          });
          const deniedAuditId = await appendWebhookDeniedAudit(tx as unknown as Sql, request, {
            paymentIntent,
            webhookEventId,
            parsed,
            providerKey,
            reason: 'invalid_payment_status_transition',
            fromStatus: paymentIntent.status,
            toStatus: targetStatus,
          });
          return {
            error: {
              statusCode: 409,
              code: 'invalid_payment_status_transition',
              message: `Cannot apply provider webhook transition ${paymentIntent.status} -> ${targetStatus}`,
              retryable: false,
              auditEventId: deniedAuditId,
            } satisfies ProviderWebhookRouteError,
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
                     webhook_event_row_id: webhookEventId,
                     ...(providerEvent.provider_metadata ?? {}),
                   })}::jsonb,
                 updated_at = NOW()
           WHERE id = ${paymentIntent.id}
             AND tenant_id = ${paymentIntent.tenant_id}
             AND merchant_id = ${paymentIntent.merchant_id}
             AND provider = ${providerKey}
             AND provider_payment_id = ${parsed.provider_payment_id ?? null}
             AND status = ${paymentIntent.status}
          RETURNING id, tenant_id, merchant_id, agent_id, passport_jti,
                    amount, currency, provider, provider_payment_id,
                    status, provider_raw_status, policy_version, decision_id,
                    updated_at
        `;
        const updated = updatedRows[0];
        if (!updated) {
          await updateWebhookEventStatus(tx, {
            id: webhookEventId,
            processingStatus: 'failed',
            errorCode: 'payment_status_changed',
            errorMessage: 'Payment intent status changed before provider webhook processing completed',
          });
          return {
            error: {
              statusCode: 409,
              code: 'payment_status_changed',
              message: 'Payment intent status changed before provider webhook processing completed',
              retryable: true,
            } satisfies ProviderWebhookRouteError,
          };
        }

        await updateWebhookEventStatus(tx, {
          id: webhookEventId,
          processingStatus: 'processed',
        });
        const eventType =
          targetStatus === 'paid' ? 'payment_intent.paid'
          : targetStatus === 'failed' ? 'payment_intent.failed'
          : 'payment_intent.expired';
        const paymentAudit = await appendCommerceAudit(tx as unknown as Sql, {
          tenantId: updated.tenant_id,
          merchantId: updated.merchant_id,
          agentId: updated.agent_id,
          eventType,
          resourceType: 'commerce_payment_intent',
          resourceId: updated.id,
          passportJti: updated.passport_jti,
          policyVersion: updated.policy_version,
          decisionId: updated.decision_id,
          requestId: request.id,
          metadata: {
            provider_key: providerKey,
            provider_event_id: parsed.event_id,
            provider_event_type: parsed.event_type,
            provider_payment_id: parsed.provider_payment_id ?? null,
            webhook_event_id: webhookEventId,
            from_status: paymentIntent.status,
            to_status: updated.status,
          },
        });

        return {
          data: {
            status: 'processed',
            event_id: parsed.event_id,
            payment_intent_id: updated.id,
            payment_status: updated.status,
          },
          received_audit_event_id: receivedAuditId,
          audit_event_id: paymentAudit.id,
        };
      });

      if ('error' in response) {
        const error = response.error as ProviderWebhookRouteError;
        commerceCriticalFlowTotal.labels('provider_webhook.process', 'failed', error.code).inc();
        throw new CommerceHttpError(error.statusCode, error.code, error.message, {
          retryable: error.retryable,
          ...(error.auditEventId ? { auditEventId: error.auditEventId } : {}),
        });
      }

      const responseData = response.data as Record<string, unknown>;
      commerceCriticalFlowTotal.labels(
        'provider_webhook.process',
        typeof responseData['status'] === 'string' ? responseData['status'] : 'unknown',
        '',
      ).inc();
      request.log.info(commerceLogContext({
        requestId: request.id,
        tenantId: paymentIntent?.tenant_id,
        merchantId: paymentIntent?.merchant_id,
        agentId: paymentIntent?.agent_id,
        passportJti: paymentIntent?.passport_jti,
        paymentIntentId: paymentIntent?.id,
        providerKey,
        providerPaymentIdRef: parsed.provider_payment_id
          ? hashedReference(parsed.provider_payment_id, 'provider_payment')
          : undefined,
        webhookProviderEventIdRef: hashedReference(parsed.event_id, 'provider_event'),
        policyVersion: paymentIntent?.policy_version,
        decisionId: paymentIntent?.decision_id,
        status: typeof responseData['status'] === 'string' ? responseData['status'] : undefined,
      }), 'commerce.provider_webhook.processed');

      return reply.status(200).send(response);
    },
  );
}
