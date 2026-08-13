import { createHmac } from 'node:crypto';
import { ulid } from 'ulid';
import { getSql } from '../db/client.js';

/**
 * Legacy signature: HMAC over the payload alone.
 *
 * A signature that commits to nothing but the body stays valid forever, so a
 * captured delivery can be replayed at any point. Kept only so receivers that
 * have not yet moved to {@link signTimestampedWebhookPayload} keep working.
 *
 * @deprecated Use the timestamped scheme; this one carries no replay bound.
 */
export function signWebhookPayload(secret: string, payload: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Signature over `<unix-seconds>.<payload>`, sent alongside an
 * `X-Grantex-Timestamp` header so the receiver can bound how old a delivery
 * may be. Binding the timestamp into the signed material is what makes the
 * bound meaningful — an unsigned timestamp header could simply be rewritten.
 */
export function signTimestampedWebhookPayload(
  secret: string,
  timestamp: string,
  payload: string,
): string {
  return 'sha256=' + createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`)
    .digest('hex');
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
