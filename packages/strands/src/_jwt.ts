/**
 * Minimal offline JWT payload decoder.
 * Used only for scope introspection; authorization uses verified grants.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) {
    throw new Error('Grantex: invalid JWT format');
  }
  const b64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Record<string, unknown>;
}
