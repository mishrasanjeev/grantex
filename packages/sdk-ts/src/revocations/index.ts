/**
 * Revocation checking for `enforce()` (PRD G-6).
 *
 * - `online` (default): ask the auth service about the grant on every call.
 *   Simplest, slowest, and denies when the service cannot be reached.
 * - `feed`: follow the revocation feed and keep an in-memory set of revoked
 *   grants and tokens. Denies within seconds of a revocation, with no network
 *   call on the hot path, and fails closed when the feed goes stale.
 * - `offline`: no check, the explicit opt-out. A revoked grant's token stays
 *   cryptographically valid until it expires.
 */
export const REVOCATION_CHECK_MODES = ['offline', 'online', 'feed'] as const;
export type RevocationCheckMode = (typeof REVOCATION_CHECK_MODES)[number];

export const DEFAULT_REVOCATION_CHECK: RevocationCheckMode = 'online';

/**
 * The modes ordered by how soon a revocation is seen: `offline` never, `feed`
 * within its staleness bound, `online` on the next call. A per-call
 * `revocationCheck` may only be as strict as the client's mode or stricter.
 */
export const REVOCATION_CHECK_STRENGTH: Readonly<Record<RevocationCheckMode, number>> = Object.freeze({
  offline: 0,
  feed: 1,
  online: 2,
});

export function isRevocationCheckMode(value: unknown): value is RevocationCheckMode {
  return typeof value === 'string' && (REVOCATION_CHECK_MODES as readonly string[]).includes(value);
}

export { RevokedSet } from './set.js';
export type { CredentialRef, RevocationAction, RevocationEntry, RevocationMatch } from './set.js';
export { RevocationFeed } from './feed.js';
export type { FeedUnavailableReason, RevocationFeedOptions, RevocationFeedState } from './feed.js';
