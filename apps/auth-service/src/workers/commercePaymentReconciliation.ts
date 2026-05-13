import type postgres from 'postgres';
import { reconcilePendingPaymentIntents } from '../lib/commerce/payment-reconciliation.js';

let intervalHandle: NodeJS.Timeout | null = null;

export function startCommercePaymentReconciliationWorker(
  sql: ReturnType<typeof postgres>,
  options: {
    intervalMs?: number;
    limit?: number;
    olderThanSeconds?: number;
  } = {},
): NodeJS.Timeout {
  const intervalMs = options.intervalMs ?? 300_000;
  const limit = options.limit ?? 50;
  const olderThanSeconds = options.olderThanSeconds ?? 120;
  const run = () => {
    reconcilePendingPaymentIntents({ sql, limit, olderThanSeconds }).catch((err) => {
      console.error('[commerce-payment-reconciliation] Error processing payment intents:', err);
    });
  };
  const timer = setInterval(run, intervalMs);
  intervalHandle = timer;
  run();
  return timer;
}

export function stopCommercePaymentReconciliationWorker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
