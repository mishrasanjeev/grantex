import { createHmac, timingSafeEqual } from 'node:crypto';

/** Default age limit for a delivery, matching the sender's retry envelope. */
const DEFAULT_TOLERANCE_SECONDS = 300;

function timingSafeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, so compare lengths first —
  // length is not the secret here, the digest is.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Verify that a webhook payload was sent by Grantex.
 *
 * @deprecated This checks only that the body was signed with your secret. It
 * commits to nothing time-bound, so a delivery captured once stays valid
 * forever and can be replayed at will. Prefer {@link verifyWebhook}, which
 * binds the signature to a timestamp and rejects stale deliveries.
 *
 * @param payload   - The raw request body string (or Buffer) received from Grantex.
 * @param signature - The value of the `X-Grantex-Signature` header.
 * @param secret    - The webhook secret returned when the endpoint was created.
 * @returns `true` if the signature is valid, `false` otherwise.
 */
export function verifyWebhookSignature(
  payload: string | Buffer,
  signature: string,
  secret: string,
): boolean {
  const expected =
    'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

export interface VerifyWebhookOptions {
  /** The raw request body, exactly as received — do not re-serialize it. */
  payload: string | Buffer;
  /** The value of the `X-Grantex-Signature-V2` header. */
  signature: string;
  /** The value of the `X-Grantex-Timestamp` header (unix seconds). */
  timestamp: string;
  /** The webhook secret returned when the endpoint was created. */
  secret: string;
  /**
   * How old a delivery may be, in seconds. Defaults to 300. Deliveries dated
   * in the future by more than this are also refused, so a forged clock cannot
   * buy an attacker an unbounded window.
   */
  toleranceSeconds?: number;
}

/**
 * Verify a timestamped webhook delivery.
 *
 * Checks that the signature covers `<timestamp>.<payload>` and that the
 * timestamp is recent. Both halves matter: without the signature the timestamp
 * could be rewritten, and without the timestamp the signature never expires.
 *
 * ```ts
 * const ok = verifyWebhook({
 *   payload: rawBody,
 *   signature: req.headers['x-grantex-signature-v2'],
 *   timestamp: req.headers['x-grantex-timestamp'],
 *   secret: process.env.GRANTEX_WEBHOOK_SECRET,
 * });
 * ```
 *
 * Pass the untouched request body. A body that has been parsed and
 * re-serialized will not hash to the same value.
 */
export function verifyWebhook(options: VerifyWebhookOptions): boolean {
  const { payload, signature, timestamp, secret } = options;
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;

  if (typeof signature !== 'string' || signature.length === 0) return false;
  if (typeof timestamp !== 'string' || !/^\d{1,15}$/.test(timestamp)) return false;

  const sentAt = Number(timestamp);
  if (!Number.isSafeInteger(sentAt)) return false;

  const ageSeconds = Math.floor(Date.now() / 1000) - sentAt;
  if (Math.abs(ageSeconds) > tolerance) return false;

  const expected = 'sha256=' + createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(payload)
    .digest('hex');

  return timingSafeStringEqual(signature, expected);
}
