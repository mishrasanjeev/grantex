import { closeSql, getSql } from '../db/client.js';
import { reconcileRevokedGrantDescendants, reconcileRevokedGrantVCs } from '../lib/vc-reconciliation.js';

async function main(): Promise<void> {
  const sql = getSql();
  const pending = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM verifiable_credentials c
    JOIN grants g ON g.id = c.grant_id AND g.developer_id = c.developer_id
    WHERE c.status = 'active' AND g.status = 'revoked'
  `;
  const count = Number(pending[0]?.count ?? 0);
  const pendingDescendants = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM grants child
    JOIN grants parent ON parent.id = child.parent_grant_id
      AND parent.developer_id = child.developer_id
    WHERE child.status = 'active' AND parent.status = 'revoked'
  `;
  const descendantCount = Number(pendingDescendants[0]?.count ?? 0);
  if (process.argv[2] !== '--apply') {
    process.stdout.write(`Pending descendant grants: ${descendantCount}; pending credentials: ${count}\n`);
    return;
  }
  const descendants = await reconcileRevokedGrantDescendants();
  const repaired = await reconcileRevokedGrantVCs();
  process.stdout.write(`Descendant grants reconciled: ${descendants}; credential groups reconciled: ${repaired}\n`);
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`VC reconciliation failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  })
  .finally(() => closeSql());
