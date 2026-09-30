/**
 * Expires DPDP consent records whose processing period has ended.
 *
 * An active record past `processing_expires_at` is marked `expired`, with a
 * `grantex.dpdp.consent_expired` entry on the developer's audit chain and a
 * `dpdp.consent.expired` event. With DPDP_CONSENT_EXPIRY_REVOKES_GRANT=true
 * the record's grant, and the grants delegated from it, are revoked in the
 * same transaction (lib/revoke.ts), the revocation cache and `grant.revoked`
 * following the commit.
 *
 * Runs only with DPDP_CONSENT_EXPIRY_ENABLED=true (index.ts). A run takes the
 * developers with due records one at a time, each in its own transaction, a
 * bounded batch per developer, rows claimed with FOR UPDATE SKIP LOCKED so
 * several instances never expire the same record twice. A failed batch is
 * logged and retried next interval; it never throws into the service.
 */
import type postgres from 'postgres';
import { config } from '../config.js';
import type { TxSql } from '../db/client.js';
import { appendPlatformAuditEntries, lockAuditChain } from '../lib/audit-chain.js';
import { emitEvent } from '../lib/events.js';
import { logger, type AppLogger } from '../lib/logger.js';
import { publishGrantRevocation, revokeGrantInTx, type RevokedGrantTree } from '../lib/revoke.js';

type Sql = ReturnType<typeof postgres>;

const EXPIRY_INTERVAL_MS = 5 * 60_000;
/** Records expired per developer per transaction. */
export const EXPIRY_BATCH_SIZE = 100;
/** Developers handled per run; the rest wait for the next run. */
export const EXPIRY_MAX_DEVELOPERS = 100;

const CONSENT_EXPIRED_ACTION = 'grantex.dpdp.consent_expired';

export interface ExpiryRunResult {
  expired: number;
  grantsRevoked: number;
  failedDevelopers: number;
}

let timer: NodeJS.Timeout | null = null;

interface DeveloperBatch {
  trees: RevokedGrantTree[];
  rows: Record<string, unknown>[];
}

async function expireForDeveloper(
  sql: Sql,
  developerId: string,
  revokeGrants: boolean,
  batchSize: number,
): Promise<DeveloperBatch> {
  const batch: DeveloperBatch = { trees: [], rows: [] };
  await sql.begin(async (_tx) => {
    const tx = _tx as unknown as TxSql;
    const rows = await tx`
      UPDATE dpdp_consent_records
      SET status = 'expired'
      WHERE id IN (
        SELECT id FROM dpdp_consent_records
        WHERE developer_id = ${developerId}
          AND status = 'active'
          AND processing_expires_at <= NOW()
        ORDER BY processing_expires_at, id
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      AND status = 'active'
      RETURNING id, grant_id, data_principal_id
    `;
    if (rows.length === 0) return;
    const grantRevoked = new Map<string, boolean>();
    if (revokeGrants) {
      for (const grantId of [...new Set(rows.map((row) => row['grant_id'] as string))].sort()) {
        const tree = await revokeGrantInTx(tx, grantId, developerId);
        grantRevoked.set(grantId, tree !== null);
        if (tree) batch.trees.push(tree);
      }
    }
    const head = await lockAuditChain(tx, developerId);
    await appendPlatformAuditEntries(tx, developerId, head, rows.map((row) => ({
      action: CONSENT_EXPIRED_ACTION,
      grantId: row['grant_id'] as string,
      metadata: {
        record_id: row['id'],
        data_principal_id: row['data_principal_id'],
        grant_revoked: grantRevoked.get(row['grant_id'] as string) ?? false,
      },
    })));
    batch.rows = [...rows];
  });
  return batch;
}

/** One pass: expire due records, developer by developer. */
export async function expireConsentRecordsOnce(
  sql: Sql,
  log: AppLogger = logger,
  options: { batchSize?: number; maxDevelopers?: number } = {},
): Promise<ExpiryRunResult> {
  const batchSize = options.batchSize ?? EXPIRY_BATCH_SIZE;
  const maxDevelopers = options.maxDevelopers ?? EXPIRY_MAX_DEVELOPERS;
  const revokeGrants = config.dpdpConsentExpiryRevokesGrant;
  const result: ExpiryRunResult = { expired: 0, grantsRevoked: 0, failedDevelopers: 0 };

  let developers: string[];
  try {
    const due = await sql<{ developer_id: string }[]>`
      SELECT DISTINCT developer_id FROM dpdp_consent_records
      WHERE status = 'active' AND processing_expires_at <= NOW()
      LIMIT ${maxDevelopers}
    `;
    developers = due.map((row) => row.developer_id).sort();
  } catch (err) {
    log.error({ err }, 'DPDP consent expiry could not list due records; it runs again next interval');
    return result;
  }

  for (const developerId of developers) {
    try {
      const { trees, rows } = await expireForDeveloper(sql, developerId, revokeGrants, batchSize);
      result.expired += rows.length;
      result.grantsRevoked += trees.length;
      for (const tree of trees) await publishGrantRevocation(developerId, tree);
      const revoked = new Set(trees.map((tree) => tree.grantId));
      for (const row of rows) {
        emitEvent(developerId, 'dpdp.consent.expired', {
          recordId: row['id'],
          grantId: row['grant_id'],
          dataPrincipalId: row['data_principal_id'],
          grantRevoked: revoked.has(row['grant_id'] as string),
        }).catch(() => {});
      }
    } catch (err) {
      result.failedDevelopers += 1;
      log.error({ err, developerId }, 'DPDP consent expiry failed for a developer; it runs again next interval');
    }
  }
  if (result.expired > 0) log.info({ ...result }, 'expired DPDP consent records past their processing period');
  return result;
}

/** Starts the worker when DPDP_CONSENT_EXPIRY_ENABLED=true; returns whether it did. */
export function startDpdpConsentExpiryWorker(
  sql: Sql,
  log: AppLogger = logger,
  intervalMs: number = EXPIRY_INTERVAL_MS,
): boolean {
  if (!config.dpdpConsentExpiryEnabled || timer) return false;
  timer = setInterval(() => void expireConsentRecordsOnce(sql, log), intervalMs);
  timer.unref?.();
  return true;
}

export function stopDpdpConsentExpiryWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
