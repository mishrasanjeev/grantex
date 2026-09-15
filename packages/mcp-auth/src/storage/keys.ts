import { createHash } from 'node:crypto';

/**
 * Lookup key for a bearer secret (authorization code, refresh token, consent
 * id). Storage never persists the secret itself, so a database or cache dump
 * cannot be replayed against the server.
 */
export function secretKey(secret: string): string {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new TypeError('storage key must be a non-empty string');
  }
  return createHash('sha256').update(secret, 'utf8').digest('base64url');
}

/** Milliseconds until `expiresAt`, or 0 when it has already passed. */
export function remainingMs(expiresAt: number, now = Date.now()): number {
  if (!Number.isFinite(expiresAt)) return 0;
  return Math.max(0, Math.floor(expiresAt - now));
}

export function assertExpiry(expiresAt: unknown, what: string): asserts expiresAt is number {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    throw new TypeError(`${what}.expiresAt must be a finite unix-millisecond timestamp`);
  }
}
