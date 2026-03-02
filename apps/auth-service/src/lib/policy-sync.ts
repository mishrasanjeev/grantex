/**
 * Policy-as-code sync — parse, validate, and store policy bundles.
 */

import { createHash } from 'node:crypto';
import { getSql } from '../db/client.js';
import { newPolicyBundleId } from './ids.js';

export interface PolicyBundle {
  id: string;
  developerId: string;
  format: 'rego' | 'cedar';
  version: string;
  sha256: string;
  fileCount: number;
  active: boolean;
  createdAt: string;
}

export interface SyncResult {
  bundleId: string;
  format: string;
  version: string;
  sha256: string;
  fileCount: number;
  activated: boolean;
}

/**
 * Upload and store a policy bundle.
 */
export async function syncPolicyBundle(
  developerId: string,
  format: 'rego' | 'cedar',
  version: string,
  content: Buffer,
  fileCount: number,
  activate = true,
): Promise<SyncResult> {
  const sql = getSql();
  const sha256 = createHash('sha256').update(content).digest('hex');
  const id = newPolicyBundleId();

  // Deactivate previous active bundle
  if (activate) {
    await sql`
      UPDATE policy_bundles SET active = FALSE
      WHERE developer_id = ${developerId} AND format = ${format} AND active = TRUE
    `;
  }

  await sql`
    INSERT INTO policy_bundles (id, developer_id, format, version, sha256, content, file_count, active)
    VALUES (${id}, ${developerId}, ${format}, ${version}, ${sha256}, ${content}, ${fileCount}, ${activate})
  `;

  return {
    bundleId: id,
    format,
    version,
    sha256,
    fileCount,
    activated: activate,
  };
}

/**
 * Get the active policy bundle for a developer.
 */
export async function getActivePolicyBundle(
  developerId: string,
  format: 'rego' | 'cedar',
): Promise<PolicyBundle | null> {
  const sql = getSql();

  const rows = await sql`
    SELECT id, developer_id, format, version, sha256, file_count, active, created_at
    FROM policy_bundles
    WHERE developer_id = ${developerId} AND format = ${format} AND active = TRUE
    LIMIT 1
  `;

  const row = rows[0];
  if (!row) return null;

  return {
    id: row['id'] as string,
    developerId: row['developer_id'] as string,
    format: row['format'] as 'rego' | 'cedar',
    version: row['version'] as string,
    sha256: row['sha256'] as string,
    fileCount: row['file_count'] as number,
    active: row['active'] as boolean,
    createdAt: (row['created_at'] as Date).toISOString(),
  };
}

/**
 * List policy bundles for a developer.
 */
export async function listPolicyBundles(
  developerId: string,
  format?: 'rego' | 'cedar',
): Promise<PolicyBundle[]> {
  const sql = getSql();

  const rows = format
    ? await sql`
        SELECT id, developer_id, format, version, sha256, file_count, active, created_at
        FROM policy_bundles
        WHERE developer_id = ${developerId} AND format = ${format}
        ORDER BY created_at DESC LIMIT 50
      `
    : await sql`
        SELECT id, developer_id, format, version, sha256, file_count, active, created_at
        FROM policy_bundles
        WHERE developer_id = ${developerId}
        ORDER BY created_at DESC LIMIT 50
      `;

  return rows.map((r) => ({
    id: r['id'] as string,
    developerId: r['developer_id'] as string,
    format: r['format'] as 'rego' | 'cedar',
    version: r['version'] as string,
    sha256: r['sha256'] as string,
    fileCount: r['file_count'] as number,
    active: r['active'] as boolean,
    createdAt: (r['created_at'] as Date).toISOString(),
  }));
}
