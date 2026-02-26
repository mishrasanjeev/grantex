import { createHmac } from 'node:crypto';
import { ulid } from 'ulid';
import { getSql } from '../db/client.js';

export type WebhookEventType = 'grant.created' | 'grant.revoked' | 'token.issued';

export function signWebhookPayload(secret: string, payload: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
}

export async function fireWebhooks(
  developerId: string,
  type: WebhookEventType,
  data: Record<string, unknown>,
): Promise<void> {
  const sql = getSql();
  const rows = await sql<{ url: string; secret: string }[]>`
    SELECT url, secret FROM webhooks
    WHERE developer_id = ${developerId}
      AND ${type} = ANY(events)
  `;
  if (rows.length === 0) return;

  const event = {
    id: `evt_${ulid()}`,
    type,
    createdAt: new Date().toISOString(),
    data,
  };
  const payloadStr = JSON.stringify(event);

  for (const row of rows) {
    const sig = signWebhookPayload(row.secret, payloadStr);
    fetch(row.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Grantex-Signature': sig,
        'User-Agent': 'Grantex-Webhooks/0.1',
      },
      body: payloadStr,
      signal: AbortSignal.timeout(10_000),
    }).catch(() => { /* best-effort delivery */ });
  }
}
