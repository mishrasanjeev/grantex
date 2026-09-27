import { getSql, type TxSql } from '../db/client.js';
import { revokeVCsByGrantIds } from './vc.js';
import { revokeGrantCascade } from './revoke.js';

/** Repair active descendants left below a historically revoked parent grant. */
export async function reconcileRevokedGrantDescendants(batchSize = 500): Promise<number> {
  const sql = getSql();
  let repaired = 0;
  while (true) {
    const rows = await sql<{ developer_id: string; id: string }[]>`
      SELECT child.developer_id, child.id
      FROM grants child
      JOIN grants parent ON parent.id = child.parent_grant_id
        AND parent.developer_id = child.developer_id
      WHERE child.status = 'active' AND parent.status = 'revoked'
      ORDER BY child.developer_id, child.id
      LIMIT ${batchSize}
    `;
    if (rows.length === 0) return repaired;
    for (const row of rows) {
      const result = await revokeGrantCascade(row.id, row.developer_id);
      if (result.revoked) repaired += 1 + result.descendantCount;
    }
  }
}

/** Repair VCs left active by historical grant-only revocation paths. */
export async function reconcileRevokedGrantVCs(batchSize = 500): Promise<number> {
  const sql = getSql();
  let repaired = 0;
  while (true) {
    const rows = await sql<{ developer_id: string; grant_id: string }[]>`
      SELECT DISTINCT c.developer_id, c.grant_id
      FROM verifiable_credentials c
      JOIN grants g ON g.id = c.grant_id AND g.developer_id = c.developer_id
      WHERE c.status = 'active' AND g.status = 'revoked'
      ORDER BY c.developer_id, c.grant_id
      LIMIT ${batchSize}
    `;
    if (rows.length === 0) return repaired;

    const byDeveloper = new Map<string, string[]>();
    for (const row of rows) {
      const grants = byDeveloper.get(row.developer_id) ?? [];
      grants.push(row.grant_id);
      byDeveloper.set(row.developer_id, grants);
    }
    for (const [developerId, grantIds] of byDeveloper) {
      await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${developerId}, 4))`;
        await revokeVCsByGrantIds(grantIds, developerId, tx);
      });
      repaired += grantIds.length;
    }
  }
}
