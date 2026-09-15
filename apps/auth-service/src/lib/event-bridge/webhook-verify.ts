/**
 * Generic signed webhook verification.
 *
 * The sender signs `<unix seconds>.<raw body bytes>` with HMAC-SHA256 using
 * the source secret, and sends:
 *
 *   X-Grantex-Timestamp: 1790000000
 *   X-Grantex-Signature: sha256=<hex>[, sha256=<hex>]
 *
 * This is the same scheme the auth service uses for its own outbound
 * deliveries (`X-Grantex-Signature-V2`), so one signer serves both
 * directions. Several signatures may be sent while the sender rotates.
 * During a receiver-side rotation both the new and the previous secret
 * verify until the previous one expires.
 *
 * The signature is checked before the body is parsed, and the timestamp must
 * be inside the source's tolerance window in either direction.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { EventVerificationError } from './errors.js';
import {
  MAX_EVENT_ID_LENGTH,
  MAX_EVENT_TYPE_LENGTH,
  isPlainObject,
  type NormalizedEvent,
} from './normalize.js';

export const WEBHOOK_TIMESTAMP_HEADER = 'x-grantex-timestamp';
export const WEBHOOK_SIGNATURE_HEADER = 'x-grantex-signature';

const MAX_SIGNATURES = 5;

export interface VerifyWebhookInput {
  rawBody: Buffer;
  timestamp: string | undefined;
  signature: string | undefined;
  /** Secrets currently accepted (the active one, and the previous one inside its grace period). */
  secrets: readonly string[];
  toleranceSeconds: number;
  now?: number;
}

export function computeWebhookSignature(secret: string, timestamp: string, rawBody: Buffer): string {
  return 'sha256=' + createHmac('sha256', secret)
    .update(`${timestamp}.`, 'utf8')
    .update(rawBody)
    .digest('hex');
}

export function verifyWebhookSignature(input: VerifyWebhookInput): void {
  const { timestamp, signature } = input;
  if (typeof timestamp !== 'string' || timestamp.length === 0) {
    throw new EventVerificationError('timestamp_missing', `${WEBHOOK_TIMESTAMP_HEADER} is required`);
  }
  if (!/^\d{1,12}$/.test(timestamp)) {
    throw new EventVerificationError('timestamp_invalid', `${WEBHOOK_TIMESTAMP_HEADER} must be unix seconds`);
  }
  if (typeof signature !== 'string' || signature.trim().length === 0) {
    throw new EventVerificationError('signature_missing', `${WEBHOOK_SIGNATURE_HEADER} is required`);
  }
  if (input.secrets.length === 0) {
    throw new EventVerificationError('secret_unavailable', 'source has no usable secret');
  }

  const presented = signature.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
  if (presented.length === 0 || presented.length > MAX_SIGNATURES
      || presented.some((part) => !/^sha256=[0-9a-f]{64}$/i.test(part))) {
    throw new EventVerificationError('signature_invalid', 'signature header is malformed');
  }

  // Check the signature before the timestamp window: a stale delivery with a
  // valid signature and a forged one are different findings.
  const expected = input.secrets.map((secret) => Buffer.from(computeWebhookSignature(secret, timestamp, input.rawBody)));
  let matched = false;
  for (const candidate of presented) {
    const candidateBytes = Buffer.from(candidate.toLowerCase());
    for (const value of expected) {
      if (value.length === candidateBytes.length && timingSafeEqual(value, candidateBytes)) matched = true;
    }
  }
  if (!matched) {
    throw new EventVerificationError('signature_invalid', 'signature does not verify');
  }

  const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > input.toleranceSeconds) {
    throw new EventVerificationError('timestamp_out_of_window', 'timestamp is outside the replay window');
  }
}

export interface WebhookSourceRef {
  id: string;
  developerId: string;
}

/**
 * Parse an authenticated webhook body:
 * `{"id": "...", "type": "...", "subject": {...}, "data": {...}?, "occurred_at": "..."?}`.
 */
export function parseWebhookEvent(rawBody: Buffer, source: WebhookSourceRef): NormalizedEvent {
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new EventVerificationError('malformed', 'body is not JSON');
  }
  if (!isPlainObject(body)) {
    throw new EventVerificationError('malformed', 'body must be a JSON object');
  }
  const { id, type, subject, data } = body;
  const occurredAt = body['occurred_at'];
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_EVENT_ID_LENGTH) {
    throw new EventVerificationError('jti_missing', `id is required (at most ${MAX_EVENT_ID_LENGTH} characters)`);
  }
  if (typeof type !== 'string' || type.length === 0 || type.length > MAX_EVENT_TYPE_LENGTH) {
    throw new EventVerificationError('events_missing', 'type is required');
  }
  if (subject !== undefined && !isPlainObject(subject)) {
    throw new EventVerificationError('malformed', 'subject must be an object');
  }
  if (data !== undefined && !isPlainObject(data)) {
    throw new EventVerificationError('malformed', 'data must be an object');
  }
  if (occurredAt !== undefined && (typeof occurredAt !== 'string' || Number.isNaN(Date.parse(occurredAt)))) {
    throw new EventVerificationError('malformed', 'occurred_at must be an RFC 3339 timestamp');
  }
  return {
    sourceId: source.id,
    sourceKind: 'webhook',
    developerId: source.developerId,
    eventId: id,
    type,
    subject: (subject as Record<string, unknown> | undefined) ?? {},
    data: (data as Record<string, unknown> | undefined) ?? {},
    occurredAt: typeof occurredAt === 'string' ? new Date(occurredAt).toISOString() : null,
  };
}
