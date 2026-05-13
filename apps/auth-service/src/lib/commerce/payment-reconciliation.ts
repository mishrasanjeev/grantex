import type postgres from 'postgres';
import { getSql, type TxSql } from '../../db/client.js';
import { appendCommerceAudit } from './audit.js';
import {
  getPaymentProvider,
  isPaymentProviderError,
  type CommerceEnvironment,
  type NormalizedProviderError,
  type ProviderKey,
} from './payment-providers/index.js';
import {
  assertPaymentStatusTransition,
  type CommercePaymentStatus,
} from './payment-state.js';

type Sql = ReturnType<typeof postgres>;

export const DEFAULT_RECONCILE_OLDER_THAN_SECONDS = 120;
export const DEFAULT_PENDING_TIMEOUT_SECONDS = 900;

export interface PaymentIntentReconciliationRow {
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

export type PaymentReconciliationResult =
  | {
      kind: 'transitioned';
      paymentIntent: PaymentIntentReconciliationRow;
      fromStatus: CommercePaymentStatus;
      toStatus: 'paid' | 'failed' | 'expired';
      providerStatus: string;
      auditEventId: string;
    }
  | {
      kind: 'no_change';
      paymentIntent: PaymentIntentReconciliationRow;
      status: CommercePaymentStatus;
      providerStatus: string;
      reason: 'provider_still_pending';
    }
  | {
      kind: 'ignored';
      paymentIntent: PaymentIntentReconciliationRow;
      status: CommercePaymentStatus;
      reason: 'terminal_status' | 'payment_status_changed';
    }
  | {
      kind: 'invalid_transition';
      paymentIntent: PaymentIntentReconciliationRow;
      fromStatus: CommercePaymentStatus;
      toStatus: CommercePaymentStatus;
      providerStatus: string;
      auditEventId: string;
    }
  | {
      kind: 'provider_error';
      paymentIntent: PaymentIntentReconciliationRow;
      error: NormalizedProviderError;
    };

export interface ReconcilePaymentIntentOptions {
  requestId?: string | null;
  source?: 'manual' | 'batch';
  now?: Date;
}

export interface ReconcilePendingPaymentIntentsInput {
  sql?: Sql;
  limit?: number;
  olderThanSeconds?: number;
  now?: Date;
}

export interface ReconcilePendingPaymentIntentsResult {
  scanned: number;
  transitioned: number;
  noChange: number;
  ignored: number;
  failed: number;
  results: PaymentReconciliationResult[];
}

function isTerminalPaymentStatus(status: CommercePaymentStatus): boolean {
  return status === 'paid' || status === 'failed' || status === 'cancelled' || status === 'expired';
}

function dateLikeToTime(v: Date | string): number {
  if (v instanceof Date) return v.getTime();
  return new Date(v).getTime();
}

function paymentAuditEventForStatus(status: 'paid' | 'failed' | 'expired') {
  if (status === 'paid') return 'payment_intent.paid';
  if (status === 'failed') return 'payment_intent.failed';
  return 'payment_intent.expired';
}

function terminalTargetForProviderStatus(
  providerStatus: string,
  expiresAt: Date | string,
  now: Date,
): 'paid' | 'failed' | 'expired' | null {
  if (providerStatus === 'paid') return 'paid';
  if (providerStatus === 'failed') return 'failed';
  if (providerStatus === 'expired') return 'expired';
  if (providerStatus === 'payment_pending' && dateLikeToTime(expiresAt) <= now.getTime()) return 'expired';
  return null;
}

function safeReconciliationError(error: NormalizedProviderError): string {
  return JSON.stringify({
    code: error.code,
    message: error.message,
    provider_key: error.provider_key,
    provider_error_code: error.provider_error_code,
    retryable: error.retryable,
    safe_metadata: error.safe_metadata,
  });
}

async function markReconciliationAttempt(
  sql: Sql,
  input: {
    row: PaymentIntentReconciliationRow;
    providerRawStatus?: string | null;
    providerMetadata?: Record<string, unknown>;
    error?: string | null;
    retryable?: boolean | null;
  },
): Promise<void> {
  await sql`
    UPDATE commerce_payment_intents
       SET last_reconciliation_attempt_at = NOW(),
           reconciled_at = CASE WHEN ${input.error ?? null}::text IS NULL THEN NOW() ELSE reconciled_at END,
           provider_raw_status = COALESCE(${input.providerRawStatus ?? null}, provider_raw_status),
           provider_metadata = COALESCE(provider_metadata, '{}'::jsonb)
             || ${JSON.stringify(input.providerMetadata ?? {})}::jsonb,
           last_reconciliation_error = ${input.error ?? null},
           last_reconciliation_retryable = ${input.retryable ?? null},
           updated_at = NOW()
     WHERE id = ${input.row.id}
       AND tenant_id = ${input.row.tenant_id}
       AND merchant_id = ${input.row.merchant_id}
       AND status = ${input.row.status}
  `;
}

async function appendInvalidTransitionAudit(
  sql: Sql,
  input: {
    row: PaymentIntentReconciliationRow;
    requestId?: string | null;
    source: 'manual' | 'batch';
    providerStatus: string;
    targetStatus: CommercePaymentStatus;
  },
): Promise<string> {
  const audit = await appendCommerceAudit(sql, {
    tenantId: input.row.tenant_id,
    merchantId: input.row.merchant_id,
    agentId: input.row.agent_id,
    eventType: 'protected_action.denied',
    resourceType: 'commerce_payment_intent',
    resourceId: input.row.id,
    passportJti: input.row.passport_jti,
    policyVersion: input.row.policy_version,
    decisionId: input.row.decision_id,
    requestId: input.requestId ?? null,
    metadata: {
      action: 'payment_intent.reconcile',
      source: input.source,
      reason: 'invalid_payment_status_transition',
      provider_key: input.row.provider,
      provider_payment_id: input.row.provider_payment_id,
      provider_status: input.providerStatus,
      from_status: input.row.status,
      to_status: input.targetStatus,
    },
  });
  return audit.id;
}

export async function reconcilePaymentIntent(
  sql: Sql,
  row: PaymentIntentReconciliationRow,
  options: ReconcilePaymentIntentOptions = {},
): Promise<PaymentReconciliationResult> {
  const source = options.source ?? 'manual';
  const now = options.now ?? new Date();
  if (isTerminalPaymentStatus(row.status)) {
    return { kind: 'ignored', paymentIntent: row, status: row.status, reason: 'terminal_status' };
  }
  if (!row.provider_payment_id) {
    const error = {
      code: 'provider_validation_failed',
      message: 'Payment intent has no provider payment id to reconcile',
      retryable: false,
      provider_key: row.provider,
      provider_error_code: 'provider_payment_missing',
    } satisfies NormalizedProviderError;
    await markReconciliationAttempt(sql, { row, error: safeReconciliationError(error), retryable: error.retryable });
    return { kind: 'provider_error', paymentIntent: row, error };
  }

  const provider = getPaymentProvider(row.provider);
  let providerResult: {
    status: 'payment_pending' | 'paid' | 'failed' | 'expired' | 'cancelled';
    raw_status: string;
    provider_metadata?: Record<string, unknown>;
  };
  try {
    providerResult = await provider.getPaymentStatus({
      tenant_id: row.tenant_id,
      merchant_id: row.merchant_id,
      payment_intent_id: row.id,
      provider_payment_id: row.provider_payment_id,
    });
  } catch (err) {
    const normalized = isPaymentProviderError(err)
      ? err.normalized
      : provider.normalizeError(err);
    await markReconciliationAttempt(sql, {
      row,
      error: safeReconciliationError(normalized),
      retryable: normalized.retryable,
    });
    return { kind: 'provider_error', paymentIntent: row, error: normalized };
  }

  const providerMetadata = {
    last_reconciliation_source: source,
    last_reconciliation_status: providerResult.status,
    ...(providerResult.provider_metadata ?? {}),
  };
  const targetStatus = terminalTargetForProviderStatus(providerResult.status, row.expires_at, now);
  if (!targetStatus) {
    await markReconciliationAttempt(sql, {
      row,
      providerRawStatus: providerResult.raw_status,
      providerMetadata,
      error: null,
    });
    return {
      kind: 'no_change',
      paymentIntent: row,
      status: row.status,
      providerStatus: providerResult.status,
      reason: 'provider_still_pending',
    };
  }

  try {
    assertPaymentStatusTransition(row.status, targetStatus);
  } catch {
    const error = `invalid_payment_status_transition:${row.status}->${targetStatus}`;
    const auditEventId = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      await markReconciliationAttempt(tx as unknown as Sql, {
        row,
        providerRawStatus: providerResult.raw_status,
        providerMetadata,
        error,
        retryable: false,
      });
      return appendInvalidTransitionAudit(tx as unknown as Sql, {
        row,
        source,
        providerStatus: providerResult.status,
        targetStatus,
        ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
      });
    });
    return {
      kind: 'invalid_transition',
      paymentIntent: row,
      fromStatus: row.status,
      toStatus: targetStatus,
      providerStatus: providerResult.status,
      auditEventId,
    };
  }

  return sql.begin(async (_tx) => {
    const tx = _tx as unknown as TxSql;
    const updatedRows = await tx<PaymentIntentReconciliationRow[]>`
      UPDATE commerce_payment_intents
         SET status = ${targetStatus},
             provider_raw_status = ${providerResult.raw_status},
             provider_metadata = COALESCE(provider_metadata, '{}'::jsonb)
               || ${JSON.stringify(providerMetadata)}::jsonb,
             last_reconciliation_attempt_at = NOW(),
             last_reconciliation_error = NULL,
             last_reconciliation_retryable = NULL,
             reconciled_at = NOW(),
             updated_at = NOW()
       WHERE id = ${row.id}
         AND tenant_id = ${row.tenant_id}
         AND merchant_id = ${row.merchant_id}
         AND status = ${row.status}
      RETURNING id, tenant_id, merchant_id, agent_id, cart_id, passport_jti,
                amount, currency, provider, provider_environment,
                provider_payment_id, provider_order_id, checkout_url, checkout_expires_at, status,
                line_items_snapshot, idempotency_key_hash, provider_metadata,
                provider_raw_status, policy_version, decision_id,
                expires_at, reconciled_at, last_reconciliation_attempt_at,
                last_reconciliation_error, last_reconciliation_retryable,
                created_at, updated_at
    `;
    const updated = updatedRows[0];
    if (!updated) {
      return {
        kind: 'ignored',
        paymentIntent: row,
        status: row.status,
        reason: 'payment_status_changed',
      };
    }
    const audit = await appendCommerceAudit(tx as unknown as Sql, {
      tenantId: updated.tenant_id,
      merchantId: updated.merchant_id,
      agentId: updated.agent_id,
      eventType: paymentAuditEventForStatus(targetStatus),
      resourceType: 'commerce_payment_intent',
      resourceId: updated.id,
      passportJti: updated.passport_jti,
      policyVersion: updated.policy_version,
      decisionId: updated.decision_id,
      requestId: options.requestId ?? null,
      metadata: {
        action: 'payment_intent.reconcile',
        source,
        provider_key: updated.provider,
        provider_payment_id: updated.provider_payment_id,
        provider_status: providerResult.status,
        provider_raw_status: providerResult.raw_status,
        from_status: row.status,
        to_status: updated.status,
      },
    });
    return {
      kind: 'transitioned',
      paymentIntent: updated,
      fromStatus: row.status,
      toStatus: targetStatus,
      providerStatus: providerResult.status,
      auditEventId: audit.id,
    };
  });
}

export async function reconcilePendingPaymentIntents(
  input: ReconcilePendingPaymentIntentsInput = {},
): Promise<ReconcilePendingPaymentIntentsResult> {
  const sql = input.sql ?? getSql();
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const olderThanSeconds = Math.max(input.olderThanSeconds ?? DEFAULT_RECONCILE_OLDER_THAN_SECONDS, 0);
  const rows = await sql<PaymentIntentReconciliationRow[]>`
    SELECT id, tenant_id, merchant_id, agent_id, cart_id, passport_jti,
           amount, currency, provider, provider_environment,
           provider_payment_id, provider_order_id, checkout_url, checkout_expires_at, status,
           line_items_snapshot, idempotency_key_hash, provider_metadata,
           provider_raw_status, policy_version, decision_id,
           expires_at, reconciled_at, last_reconciliation_attempt_at,
           last_reconciliation_error, last_reconciliation_retryable,
           created_at, updated_at
      FROM commerce_payment_intents
     WHERE status = 'payment_pending'
       AND updated_at <= NOW() - (${olderThanSeconds} || ' seconds')::interval
       AND (last_reconciliation_error IS NULL OR last_reconciliation_retryable = true)
     ORDER BY updated_at ASC
     LIMIT ${limit}
  `;

  const results: PaymentReconciliationResult[] = [];
  for (const row of rows) {
    const options: ReconcilePaymentIntentOptions = {
      source: 'batch',
      ...(input.now !== undefined ? { now: input.now } : {}),
    };
    results.push(await reconcilePaymentIntent(sql, row, options));
  }

  return {
    scanned: rows.length,
    transitioned: results.filter((r) => r.kind === 'transitioned').length,
    noChange: results.filter((r) => r.kind === 'no_change').length,
    ignored: results.filter((r) => r.kind === 'ignored' || r.kind === 'invalid_transition').length,
    failed: results.filter((r) => r.kind === 'provider_error').length,
    results,
  };
}
