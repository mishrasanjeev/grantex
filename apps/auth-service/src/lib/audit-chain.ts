/**
 * Appending platform-written entries to a developer's audit hash chain.
 *
 * The chain is the same one `POST /v1/audit/log` and evidence records write
 * to: one chain per developer, each entry hashing the one before it. Writers
 * serialise on the developer's audit advisory lock, and entry timestamps and
 * ids never sort before the head (see `nextStamp`).
 *
 * Entries written here carry a reserved `grantex.` action and the
 * `grantex:platform` metadata marker, both refused on the tenant-facing
 * endpoint (lib/audit-reserved.ts), so a revocation record cannot be forged by
 * a tenant. They are not subject to the plan entry limit: a security record
 * that a full plan could suppress would be worthless.
 */
import type postgres from 'postgres';
import { computeAuditHash } from './hash.js';
import { PLATFORM_MARKER } from './evidence/hashing.js';
import { nextStamp } from './evidence-service/service.js';

type Sql = ReturnType<typeof postgres>;

export interface AuditChainHead {
  hash: string | null;
  timestampMs: number;
  id: string | null;
}

/** Take the developer's audit lock for the rest of the transaction and read the chain head. */
export async function lockAuditChain(tx: Sql, developerId: string): Promise<AuditChainHead> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${developerId}, 0))`;
  const rows = await tx<{ id: string; hash: string; timestamp: Date | string }[]>`
    SELECT id, hash, timestamp FROM audit_entries WHERE developer_id = ${developerId}
    ORDER BY timestamp DESC, id DESC LIMIT 1`;
  const row = rows[0];
  return row
    ? { hash: row.hash, timestampMs: new Date(row.timestamp).getTime(), id: row.id }
    : { hash: null, timestampMs: 0, id: null };
}

export interface PlatformAuditEntry {
  /** Must start with a reserved prefix (`grantex.`). */
  action: string;
  metadata: Record<string, unknown>;
  agentId?: string;
  agentDid?: string;
  grantId?: string;
}

export interface AppendedAuditEntry {
  id: string;
  hash: string;
  timestamp: string;
}

/**
 * Append entries to the chain in order, inside the caller's transaction.
 * `lockAuditChain` must already have been called for this developer.
 */
export async function appendPlatformAuditEntries(
  tx: Sql,
  developerId: string,
  head: AuditChainHead,
  entries: readonly PlatformAuditEntry[],
  now: () => Date = () => new Date(),
): Promise<{ head: AuditChainHead; appended: AppendedAuditEntry[] }> {
  let current = head;
  const appended: AppendedAuditEntry[] = [];
  for (const entry of entries) {
    const stamp = nextStamp(current, now());
    const metadata = { ...entry.metadata, [PLATFORM_MARKER]: true };
    const row = {
      id: stamp.id,
      agentId: entry.agentId ?? '',
      agentDid: entry.agentDid ?? '',
      grantId: entry.grantId ?? '',
      principalId: 'platform',
      developerId,
      action: entry.action,
      metadata,
      timestamp: stamp.timestamp,
      prevHash: current.hash,
      status: 'success',
    };
    const hash = computeAuditHash(row);
    await tx`
      INSERT INTO audit_entries (id, agent_id, agent_did, grant_id, principal_id, developer_id, action, metadata, hash, previous_hash, timestamp, status)
      VALUES (${row.id}, ${row.agentId}, ${row.agentDid}, ${row.grantId}, ${row.principalId}, ${developerId}, ${row.action},
              ${tx.json(metadata as postgres.JSONValue)}, ${hash}, ${row.prevHash}, ${row.timestamp}, 'success')`;
    current = { hash, timestampMs: stamp.timestampMs, id: stamp.id };
    appended.push({ id: stamp.id, hash, timestamp: stamp.timestamp });
  }
  return { head: current, appended };
}
