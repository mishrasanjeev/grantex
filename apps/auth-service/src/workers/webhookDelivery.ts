import type postgres from 'postgres';

interface PendingDelivery {
  id: string;
  url: string;
  payload: string;
  signature: string;
  attempts: number;
  max_attempts: number;
}

/**
 * Calculate next retry delay with exponential backoff.
 * Attempts: 0→30s, 1→60s, 2→120s, 3→240s, 4→480s
 */
function backoffSeconds(attempt: number): number {
  return 30 * Math.pow(2, attempt);
}

async function processDeliveries(sql: ReturnType<typeof postgres>): Promise<void> {
  const rows = await sql<PendingDelivery[]>`
    SELECT id, url, payload, signature, attempts, max_attempts
    FROM webhook_deliveries
    WHERE status = 'pending'
      AND next_retry_at <= NOW()
    ORDER BY next_retry_at ASC
    LIMIT 50
  `;

  for (const row of rows) {
    const nextAttempt = row.attempts + 1;

    try {
      const res = await fetch(row.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Grantex-Signature': row.signature,
          'User-Agent': 'Grantex-Webhooks/0.1',
        },
        body: row.payload,
        signal: AbortSignal.timeout(10_000),
      });

      if (res.ok) {
        await sql`
          UPDATE webhook_deliveries
          SET status = 'delivered', attempts = ${nextAttempt}, delivered_at = NOW()
          WHERE id = ${row.id}
        `;
      } else {
        await markRetryOrFail(sql, row, nextAttempt, `HTTP ${res.status}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await markRetryOrFail(sql, row, nextAttempt, message);
    }
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
  } else {
    const delaySec = backoffSeconds(attempt);
    await sql`
      UPDATE webhook_deliveries
      SET attempts = ${attempt},
          last_error = ${error},
          next_retry_at = NOW() + ${delaySec + ' seconds'}::interval
      WHERE id = ${row.id}
    `;
  }
}

/**
 * Start the webhook delivery worker. Polls every `intervalMs` for
 * pending deliveries and attempts to deliver them with exponential backoff.
 */
export function startWebhookDeliveryWorker(
  sql: ReturnType<typeof postgres>,
  intervalMs = 30_000,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    processDeliveries(sql).catch((err) => {
      console.error('[webhook-delivery] Error processing deliveries:', err);
    });
  }, intervalMs);

  // Run once immediately
  processDeliveries(sql).catch((err) => {
    console.error('[webhook-delivery] Error on initial run:', err);
  });

  return timer;
}
