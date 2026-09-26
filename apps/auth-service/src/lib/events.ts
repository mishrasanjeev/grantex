import { ulid } from 'ulid';
import { getRedis } from '../redis/client.js';
import { enqueueWebhookDeliveries } from './webhook.js';

/**
 * Every event type the platform publishes. One list, so what a developer may
 * subscribe to on a webhook cannot drift from what is actually emitted:
 * routes/webhooks.ts derives its validation from this.
 */
export const EVENT_TYPES = [
  'grant.created',
  'grant.revoked',
  'grant.suspended',
  'grant.resumed',
  'grant.re_evaluation_requested',
  'token.issued',
  'budget.threshold',
  'budget.exhausted',
  'wallet.payment.reserved',
  'wallet.payment.settled',
  'wallet.payment.released',
  'wallet.payment.denied',
  'wallet.payment.approval_required',
  'wallet.payment.approval_approved',
  'wallet.payment.approval_rejected',
  'wallet.spend_policy.changed',
  'wallet.low_balance',
  'wallet.reload.requested',
  'wallet.reload.approved',
  'wallet.reload.rejected',
  'wallet.reloaded',
  'wallet.blocked',
  'wallet.unblocked',
  'fido.registered',
  'fido.assertion',
  'vc.issued',
  'sd-jwt.issued',
  'sd-jwt.presented',
  'passport.issued',
  'passport.revoked',
  'passport.token-exchange',
  'sso.login',
  'sso.connection.created',
  'sso.connection.updated',
  'sso.connection.deleted',
  'vault.credential.stored',
  'vault.credential.deleted',
  'vault.credential.exchanged',
  'consent_bundle.created',
  'consent_bundle.synced',
  'consent_bundle.revoked',
  'dpdp.consent.created',
  'dpdp.consent.withdrawn',
  'dpdp.grievance.filed',
  'dpdp.erasure.completed',
  'anomaly.auto_revoked',
  'anomaly.detected',
  'irregularity.policy.updated',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

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
