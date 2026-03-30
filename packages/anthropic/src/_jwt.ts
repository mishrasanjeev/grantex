/**
 * Minimal offline JWT payload decoder — no signature verification.
 * Used only to read the `scp` claim from a Grantex grant token without
 * making a network round-trip.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) {
    throw new Error('Grantex: invalid JWT format');
  }
  // Convert base64url → base64, then decode
  const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Record<string, unknown>;
}
