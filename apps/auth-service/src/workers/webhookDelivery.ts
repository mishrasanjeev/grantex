import type postgres from 'postgres';
import { webhookDeliveriesTotal } from '../lib/metrics.js';
import { config } from '../config.js';
import { safeFetch } from '../lib/url-security.js';

interface PendingDelivery {
  id: string;
  url: string;
  payload: string;
  signature: string;
  attempts: number;
  max_attempts: number;
}

const DELIVERY_BATCH_SIZE = 20;
const DELIVERY_CONCURRENCY = 5;

/**
 * Calculate next retry delay with exponential backoff.
 * Attempts: 0→30s, 1→60s, 2→120s, 3→240s, 4→480s
 */
function backoffSeconds(attempt: number): number {
  return 30 * Math.pow(2, attempt);
}

async function processDeliveries(sql: ReturnType<typeof postgres>): Promise<void> {
  // Atomically lease due rows before doing network I/O. A plain SELECT lets
  // overlapping timers or multiple service replicas deliver the same webhook
  // concurrently. The two-minute next_retry_at lease is longer than the
  // request timeout and naturally recovers rows after a worker crash. The
  // bounded parallel processor below completes a worst-case batch well inside
  // the two-minute lease (20 rows / 5 workers * 10-second request timeout).
  const rows = await sql<PendingDelivery[]>`
    WITH due AS (
      SELECT id
      FROM webhook_deliveries
      WHERE status = 'pending'
        AND next_retry_at <= NOW()
      ORDER BY next_retry_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${DELIVERY_BATCH_SIZE}
    )
    UPDATE webhook_deliveries AS delivery
    SET next_retry_at = NOW() + INTERVAL '2 minutes'
    FROM due
    WHERE delivery.id = due.id
    RETURNING delivery.id, delivery.url, delivery.payload, delivery.signature,
              delivery.attempts, delivery.max_attempts
  `;

  let nextRowIndex = 0;
  const workerCount = Math.min(DELIVERY_CONCURRENCY, rows.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextRowIndex < rows.length) {
      const row = rows[nextRowIndex++];
      if (row) await processDelivery(sql, row);
    }
  }));
}

async function processDelivery(
  sql: ReturnType<typeof postgres>,
  row: PendingDelivery,
): Promise<void> {
  const nextAttempt = row.attempts + 1;

  try {
    const res = await safeFetch(row.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Grantex-Signature': row.signature,
        'User-Agent': 'Grantex-Webhooks/0.1',
      },
      body: row.payload,
      signal: AbortSignal.timeout(10_000),
    }, {
      allowedProtocols: ['https:', 'http:'],
      allowInsecureHttp: config.allowInsecureWebhookUrls,
      allowPrivateHosts: config.allowPrivateWebhookHosts,
    });

    if (res.ok) {
      await sql`
        UPDATE webhook_deliveries
        SET status = 'delivered', attempts = ${nextAttempt}, delivered_at = NOW()
        WHERE id = ${row.id}
      `;
      webhookDeliveriesTotal.inc({ status: 'delivered' });
    } else {
      await markRetryOrFail(sql, row, nextAttempt, `HTTP ${res.status}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markRetryOrFail(sql, row, nextAttempt, message);
  }
}

async function markRetryOrFail(
  sql: ReturnType<typeof postgres>,
  row: PendingDelivery,
  attempt: number,
  error: string,
): Promise<void> {
  if (attempt >= row.max_attempts) {
    await sql`
      UPDATE webhook_deliveries
      SET status = 'failed', attempts = ${attempt}, last_error = ${error}
      WHERE id = ${row.id}
    `;
    webhookDeliveriesTotal.inc({ status: 'failed' });
  } else {
    // attempt is one-based after the failed request; backoffSeconds is
    // zero-based (first failure => 30 seconds).
    const delaySec = backoffSeconds(Math.max(0, attempt - 1));
    await sql`
      UPDATE webhook_deliveries
      SET attempts = ${attempt},
          last_error = ${error},
          next_retry_at = NOW() + ${delaySec + ' seconds'}::interval
      WHERE id = ${row.id}
    `;
  }
}

let _intervalHandle: NodeJS.Timeout | null = null;
let _processing = false;

function runDeliveryCycle(
  sql: ReturnType<typeof postgres>,
  errorPrefix: string,
): void {
  // setInterval does not wait for an async callback. Avoid overlapping cycles
  // in this process; database leases provide the corresponding cross-replica
  // exclusion.
  if (_processing) return;
  _processing = true;
  processDeliveries(sql)
    .catch((err) => {
      console.error(errorPrefix, err);
    })
    .finally(() => {
      _processing = false;
    });
}

/**
 * Start the webhook delivery worker. Polls every `intervalMs` for
 * pending deliveries and attempts to deliver them with exponential backoff.
 */
export function startWebhookDeliveryWorker(
  sql: ReturnType<typeof postgres>,
  intervalMs = 30_000,
): NodeJS.Timeout {
  if (_intervalHandle) clearInterval(_intervalHandle);
  const timer = setInterval(() => {
    runDeliveryCycle(sql, '[webhook-delivery] Error processing deliveries:');
  }, intervalMs);

  _intervalHandle = timer;

  // Run once immediately
  runDeliveryCycle(sql, '[webhook-delivery] Error on initial run:');

  return timer;
}

/**
 * Stop the webhook delivery worker and clean up the polling interval.
 */
export function stopWebhookDeliveryWorker(): void {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
}
