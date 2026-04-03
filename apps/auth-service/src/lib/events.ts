import { ulid } from 'ulid';
import { getRedis } from '../redis/client.js';
import { enqueueWebhookDeliveries } from './webhook.js';

export type EventType =
  | 'grant.created'
  | 'grant.revoked'
  | 'token.issued'
  | 'budget.threshold'
  | 'budget.exhausted'
  | 'fido.registered'
  | 'fido.assertion'
  | 'vc.issued'
  | 'sd-jwt.issued'
  | 'sd-jwt.presented'
  | 'passport.issued'
  | 'passport.revoked'
  | 'passport.token-exchange'
  | 'sso.login'
  | 'sso.connection.created'
  | 'sso.connection.updated'
  | 'sso.connection.deleted'
  | 'consent_bundle.created'
  | 'consent_bundle.synced'
  | 'consent_bundle.revoked';

export interface GrantexEvent {
  id: string;
  type: EventType;
  createdAt: string;
  data: Record<string, unknown>;
}

/**
 * Central event bus — publishes an event to:
 * (a) webhook_deliveries table (existing webhook delivery path)
 * (b) Redis pub/sub channel for real-time SSE/WebSocket consumers
 */
export async function emitEvent(
  developerId: string,
  type: EventType,
  data: Record<string, unknown>,
): Promise<void> {
  const event: GrantexEvent = {
    id: `evt_${ulid()}`,
    type,
    createdAt: new Date().toISOString(),
    data,
  };

  // Enqueue to webhook_deliveries (existing path)
  await enqueueWebhookDeliveries(developerId, event);

  // Publish to Redis for real-time consumers (SSE/WS)
  try {
    const redis = getRedis();
    await redis.publish(`grantex:events:${developerId}`, JSON.stringify(event));
  } catch {
    // Best-effort — don't fail the request if Redis pub/sub is unavailable
  }
}
