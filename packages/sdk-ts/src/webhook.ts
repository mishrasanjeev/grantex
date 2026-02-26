import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify that a webhook payload was sent by Grantex.
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
