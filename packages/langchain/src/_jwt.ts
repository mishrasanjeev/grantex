/**
 * Decode the payload section of a JWT without verifying the signature.
 * Used only to extract audit metadata. Never use this helper to authorize a call.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) {
    throw new Error('Grantex: invalid JWT format');
  }
  // base64url → base64 → JSON
  const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const json = Buffer.from(b64, 'base64').toString('utf8');
  return JSON.parse(json) as Record<string, unknown>;
}
