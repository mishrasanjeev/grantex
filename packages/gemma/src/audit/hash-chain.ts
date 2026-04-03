import { createHash } from 'node:crypto';

/**
 * Shape of a signed audit entry (after signing + hashing).
 */
export interface SignedAuditEntry {
  seq: number;
  timestamp: string;
  action: string;
  agentDID: string;
  grantId: string;
  scopes: string[];
  result: string;
  metadata?: Record<string, unknown>;
  prevHash: string;
  hash: string;
  signature: string;
}

/** The sentinel prevHash for the first entry in a chain. */
export const GENESIS_HASH = '0000000000000000';

/**
 * Compute the SHA-256 hash of an audit entry (before the entry's own
 * `hash` and `signature` fields are set).
 *
 * Hash input: `seq|timestamp|action|agentDID|grantId|scopes|result|metadata|prevHash`
 */
export function computeEntryHash(
  entry: Omit<SignedAuditEntry, 'hash' | 'signature'>,
): string {
  const h = createHash('sha256');
  h.update(String(entry.seq));
  h.update('|');
  h.update(entry.timestamp);
  h.update('|');
  h.update(entry.action);
  h.update('|');
  h.update(entry.agentDID);
  h.update('|');
  h.update(entry.grantId);
  h.update('|');
  h.update(entry.scopes.join(','));
  h.update('|');
  h.update(entry.result);
  h.update('|');
  h.update(
    entry.metadata !== undefined ? JSON.stringify(entry.metadata) : '',
  );
  h.update('|');
  h.update(entry.prevHash);
  return h.digest('hex');
}

/**
 * Verify the integrity of an ordered sequence of signed audit entries.
 *
 * Checks:
 * 1. Each entry's `hash` equals the recomputed hash.
 * 2. Each entry's `prevHash` matches the previous entry's `hash`
 *    (the first entry must use `GENESIS_HASH`).
 * 3. Sequence numbers are consecutive starting from the first entry.
 *
 * @returns `{ valid: true }` if the chain is intact, or
 *          `{ valid: false, brokenAt }` indicating the first broken index.
 */
export function verifyChain(
  entries: SignedAuditEntry[],
): { valid: boolean; brokenAt?: number } {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;

    // Check prevHash linkage
    const expectedPrev =
      i === 0 ? GENESIS_HASH : entries[i - 1]!.hash;
    if (entry.prevHash !== expectedPrev) {
      return { valid: false, brokenAt: i };
    }

    // Recompute hash and compare
    const recomputed = computeEntryHash({
      seq: entry.seq,
      timestamp: entry.timestamp,
      action: entry.action,
      agentDID: entry.agentDID,
      grantId: entry.grantId,
      scopes: entry.scopes,
      result: entry.result,
      ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
      prevHash: entry.prevHash,
    });

    if (entry.hash !== recomputed) {
      return { valid: false, brokenAt: i };
    }

    // Check sequence continuity
    if (i > 0 && entry.seq !== entries[i - 1]!.seq + 1) {
      return { valid: false, brokenAt: i };
    }
  }

  return { valid: true };
}
