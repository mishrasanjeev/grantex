import type { OfflineAuditLog } from './offline-audit-log.js';
import type { SignedAuditEntry } from './hash-chain.js';

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

export interface SyncOptions {
  /** URL of the Grantex offline-sync endpoint. */
  endpoint: string;
  /** Developer API key for authenticating sync requests. */
  apiKey: string;
  /** Number of entries per batch (default 100). */
  batchSize?: number;
  /** Consent-bundle ID linking these entries to a specific offline session. */
  bundleId: string;
}

export interface SyncResult {
  /** Total entries synced in this call. */
  syncedCount: number;
  /** Whether any errors occurred. */
  hasErrors: boolean;
  /** Error messages for failed batches. */
  errors: string[];
}

/* ------------------------------------------------------------------ */
/*  Implementation                                                     */
/* ------------------------------------------------------------------ */

/**
 * Sync un-synced audit-log entries to the Grantex cloud endpoint in batches.
 *
 * Entries are POSTed to `{endpoint}/v1/audit/offline-sync`. On success,
 * entries are marked as synced so they won't be uploaded again.
 */
export async function syncAuditLog(
  auditLog: OfflineAuditLog,
  options: SyncOptions,
): Promise<SyncResult> {
  const {
    endpoint,
    apiKey,
    batchSize = 100,
    bundleId,
  } = options;

  const allEntries = await auditLog.entries();
  // Filter to unsynced (we check after markSynced via the log itself).
  // Since the log exposes unsyncedCount + markSynced based on seq,
  // we just post everything and let markSynced handle dedup.
  // But for efficiency, read the synced marker to skip already-sent entries.
  const unsyncedEntries: SignedAuditEntry[] = [];
  let syncedMarkerSeq = -1;

  // We walk all entries; the log internally tracks syncedUpTo.
  // For simplicity, just use unsyncedCount as a hint and send the tail.
  const totalUnsynced = await auditLog.unsyncedCount();
  if (totalUnsynced === 0) {
    return { syncedCount: 0, hasErrors: false, errors: [] };
  }

  // Take the last `totalUnsynced` entries.
  const startIdx = allEntries.length - totalUnsynced;
  for (let i = startIdx; i < allEntries.length; i++) {
    unsyncedEntries.push(allEntries[i]!);
  }

  const errors: string[] = [];
  let syncedCount = 0;

  for (let i = 0; i < unsyncedEntries.length; i += batchSize) {
    const batch = unsyncedEntries.slice(i, i + batchSize);
    const lastSeq = batch[batch.length - 1]!.seq;

    let attempt = 0;
    const maxRetries = 3;
    let success = false;

    while (attempt < maxRetries && !success) {
      try {
        const res = await fetch(
          `${endpoint.replace(/\/+$/, '')}/v1/audit/offline-sync`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ bundleId, entries: batch }),
          },
        );
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        }
        success = true;
        syncedCount += batch.length;
        await auditLog.markSynced(lastSeq);
      } catch (err) {
        attempt++;
        if (attempt >= maxRetries) {
          errors.push(
            `Failed batch seq ${batch[0]!.seq}-${lastSeq}: ${(err as Error).message}`,
          );
        } else {
          // Exponential back-off: 200ms, 400ms
          await new Promise((r) =>
            setTimeout(r, 200 * Math.pow(2, attempt - 1)),
          );
        }
      }
    }
  }

  return {
    syncedCount,
    hasErrors: errors.length > 0,
    errors,
  };
}
