/**
 * Revocation checking for `enforce()` (PRD G-6).
 *
 * - `offline` (default): no check. A revoked grant's token stays
 *   cryptographically valid until it expires, which is why the other two modes
 *   exist.
 * - `feed`: follow the revocation feed and keep an in-memory set of revoked
 *   grants and tokens. Denies within seconds of a revocation, with no network
 *   call on the hot path, and fails closed when the feed goes stale.
 * - `online`: ask the auth service about the grant on every call. Simplest,
 *   slowest, and denies when the service cannot be reached.
 */
export const REVOCATION_CHECK_MODES = ['offline', 'online', 'feed'] as const;
export type RevocationCheckMode = (typeof REVOCATION_CHECK_MODES)[number];

export function isRevocationCheckMode(value: unknown): value is RevocationCheckMode {
  return typeof value === 'string' && (REVOCATION_CHECK_MODES as readonly string[]).includes(value);
}

export { RevokedSet } from './set.js';
export type { CredentialRef, RevocationAction, RevocationEntry, RevocationMatch } from './set.js';
export { RevocationFeed } from './feed.js';
export type { FeedUnavailableReason, RevocationFeedOptions, RevocationFeedState } from './feed.js';
