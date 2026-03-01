import { createHmac } from 'node:crypto';
import { ulid } from 'ulid';
import { getSql } from '../db/client.js';

export function signWebhookPayload(secret: string, payload: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Enqueue webhook deliveries for all matching endpoints.
 * Called by the event bus — each matching webhook endpoint gets
 * a delivery row in the `webhook_deliveries` table for retry processing.
 */
export async function enqueueWebhookDeliveries(
  developerId: string,
  event: { id: string; type: string; createdAt: string; data: Record<string, unknown> },
): Promise<void> {
  const sql = getSql();
  const rows = await sql<{ id: string; url: string; secret: string }[]>`
    SELECT id, url, secret FROM webhooks
    WHERE developer_id = ${developerId}
      AND ${event.type} = ANY(events)
  `;
  if (rows.length === 0) return;

  const payloadStr = JSON.stringify(event);

  for (const row of rows) {
    const sig = signWebhookPayload(row.secret, payloadStr);
    const deliveryId = `whd_${ulid()}`;

    await sql`
      INSERT INTO webhook_deliveries
        (id, webhook_id, developer_id, event_id, event_type, payload, signature, url, status, attempts, next_retry_at)
      VALUES
        (${deliveryId}, ${row.id}, ${developerId}, ${event.id}, ${event.type},
         ${payloadStr}, ${sig}, ${row.url}, 'pending', 0, NOW())
    `;
  }
}
