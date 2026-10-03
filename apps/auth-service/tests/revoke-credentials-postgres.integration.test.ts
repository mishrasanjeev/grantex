/**
 * The plain (non-cascade-engine) revocation path, `revokeGrantCascade`,
 * against real Postgres.
 *
 * It used to revoke the credentials behind a grant as fire-and-forget after
 * the commit — `revokeVCsByGrantIds(ids, developerId).catch(() => {})` — so a
 * failure left a credential that still verified against a grant that no
 * longer existed, and the rejection was swallowed. It now runs inside the
 * same transaction as the grants.
 *
 * The fixture uses a status-list-backed credential, as every credential
 * `issueAgentGrantVC` writes is. Without the list the whole bit-flipping path
 * is skipped, which is how a nested-transaction bug survived a green suite.
 */
import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TxSql } from '../src/db/client.js';
import { createTestDatabase } from './helpers/database.js';

// A database of its own; see FINDINGS G-24.
const adminDatabaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !adminDatabaseUrl) {
  throw new Error(
    'AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the revocation credential tests',
  );
}
const describePostgres = adminDatabaseUrl ? describe : describe.skip;

// `revokeGrantCascade` reaches for the pool itself, so this file points
// `getSql` at the real database instead of the shared mock. The pool is built
// lazily because a `vi.hoisted` factory runs before this module's imports.
const state = vi.hoisted(() => ({ pool: null as ReturnType<typeof postgres> | null }));

vi.mock('../src/db/client.js', () => ({
  getSql: () => state.pool,
  closeSql: vi.fn(),
}));

// The pool is created in `beforeAll` so this file can own its database:
// `getSql` reads `state.pool` at call time, so assigning it later is enough.
let dropTestDatabase: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (!adminDatabaseUrl) return;
  const db = await createTestDatabase('revoke_credentials');
  state.pool = postgres(db.url, { max: 4, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
  dropTestDatabase = db.drop;
}, 60_000);

afterAll(async () => {
  // The database goes even if closing the pool throws.
  try {
    await state.pool?.end();
  } finally {
    state.pool = null;
    await dropTestDatabase?.();
  }
}, 60_000);

const { revokeGrantCascade, revokeAgentGrantsCascade, revokeAgentGrantsInTx } = await import('../src/lib/revoke.js');
const { reconcileRevokedGrantDescendants, reconcileRevokedGrantVCs } = await import('../src/lib/vc-reconciliation.js');
const { runMigrations } = await import('../src/db/migrate.js');

describePostgres('revoking a grant revokes its credentials in the same transaction', () => {
  it('commits or rolls back the agent lifecycle and grant-tree sweep together', async () => {
    const sql = state.pool!;
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
    const developerId = `dev_lifecycle_${suffix}`;
    const otherDeveloperId = `dev_other_${suffix}`;
    const agentId = `ag_lifecycle_${suffix}`;
    const childAgentId = `ag_child_${suffix}`;
    const otherAgentId = `ag_other_${suffix}`;
    const parentId = `grnt_parent_${suffix}`;
    const childId = `grnt_child_${suffix}`;
    const otherGrantId = `grnt_other_${suffix}`;
    await runMigrations(sql);
    try {
      await sql`INSERT INTO developers (id, api_key_hash, name)
                VALUES (${developerId}, ${'hash_a_' + suffix}, 'Lifecycle Test'),
                       (${otherDeveloperId}, ${'hash_b_' + suffix}, 'Other Test')`;
      await sql`INSERT INTO agents (id, did, developer_id, name)
                VALUES (${agentId}, ${'did:grantex:' + agentId}, ${developerId}, 'Agent'),
                       (${childAgentId}, ${'did:grantex:' + childAgentId}, ${developerId}, 'Child'),
                       (${otherAgentId}, ${'did:grantex:' + otherAgentId}, ${otherDeveloperId}, 'Other')`;
      await sql`INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, expires_at)
                VALUES (${parentId}, ${agentId}, 'user_lifecycle', ${developerId}, ${['read']}, NOW() + INTERVAL '1 hour'),
                       (${otherGrantId}, ${otherAgentId}, 'user_other', ${otherDeveloperId}, ${['read']}, NOW() + INTERVAL '1 hour')`;
      await sql`INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, status, expires_at, parent_grant_id)
                VALUES (${childId}, ${childAgentId}, 'user_lifecycle', ${developerId}, ${['read']}, 'suspended',
                        NOW() + INTERVAL '1 hour', ${parentId})`;

      await expect(sql.begin(async (raw) => {
        const tx = raw as unknown as TxSql;
        await tx`UPDATE agents SET status = 'suspended' WHERE id = ${agentId} AND developer_id = ${developerId}`;
        await revokeAgentGrantsInTx(tx, agentId, developerId, false);
        throw new Error('roll back lifecycle transition');
      })).rejects.toThrow('roll back lifecycle transition');
      expect((await sql`SELECT status FROM agents WHERE id = ${agentId}`)[0]?.['status']).toBe('active');
      expect((await sql`SELECT status FROM grants WHERE id = ${parentId}`)[0]?.['status']).toBe('active');
      expect((await sql`SELECT status FROM grants WHERE id = ${childId}`)[0]?.['status']).toBe('suspended');
      expect(await sql`SELECT grant_id FROM grant_revocation_events
                       WHERE developer_id = ${developerId} AND action = 'revoked'`).toHaveLength(0);

      const revoked = await sql.begin(async (raw) => {
        const tx = raw as unknown as TxSql;
        await tx`UPDATE agents SET status = 'suspended' WHERE id = ${agentId} AND developer_id = ${developerId}`;
        return revokeAgentGrantsInTx(tx, agentId, developerId, false);
      });
      expect(new Set(revoked.map((row) => row['id']))).toEqual(new Set([parentId, childId]));
      expect((await sql`SELECT status FROM agents WHERE id = ${agentId}`)[0]?.['status']).toBe('suspended');
      expect((await sql`SELECT status FROM grants WHERE id = ${parentId}`)[0]?.['status']).toBe('revoked');
      expect((await sql`SELECT status FROM grants WHERE id = ${childId}`)[0]?.['status']).toBe('revoked');
      expect((await sql`SELECT status FROM grants WHERE id = ${otherGrantId}`)[0]?.['status']).toBe('active');
      const feed = await sql`SELECT grant_id FROM grant_revocation_events
                             WHERE developer_id = ${developerId} AND action = 'revoked'`;
      expect(new Set(feed.map((row) => row['grant_id']))).toEqual(new Set([parentId, childId]));
    } finally {
      await sql`DELETE FROM grants WHERE id IN (${parentId}, ${childId}, ${otherGrantId})`.catch(() => undefined);
      await sql`DELETE FROM agents WHERE id IN (${agentId}, ${childAgentId}, ${otherAgentId})`.catch(() => undefined);
      await sql`DELETE FROM developers WHERE id IN (${developerId}, ${otherDeveloperId})`.catch(() => undefined);
    }
  }, 300_000);

  it('marks the credential revoked and flips its status-list bit', async () => {
    const sql = state.pool!;
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
    const dev = `dev_rvc_${suffix}`;
    const agent = `ag_rvc_${suffix}`;
    const parent = `grnt_rvc_p_${suffix}`;
    const child = `grnt_rvc_c_${suffix}`;
    const listId = `vcsl_rvc_${suffix}`;
    const vcId = `vc_rvc_${suffix}`;
    const index = 3;

    await runMigrations(sql);
    try {
      await sql`INSERT INTO developers (id, api_key_hash, name) VALUES (${dev}, ${'hash_' + suffix}, 'Revoke VC Test')`;
      await sql`INSERT INTO agents (id, did, developer_id, name)
                VALUES (${agent}, ${'did:grantex:' + agent}, ${dev}, 'Agent')`;
      await sql`
        INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, expires_at)
        VALUES (${parent}, ${agent}, 'user_rvc', ${dev}, ${['tool:acme_kyb:read']}, NOW() + INTERVAL '1 hour')`;
      await sql`
        INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, expires_at, parent_grant_id)
        VALUES (${child}, ${agent}, 'user_rvc', ${dev}, ${['tool:acme_kyb:read']}, NOW() + INTERVAL '1 hour', ${parent})`;
      await sql`
        INSERT INTO vc_status_lists (id, developer_id, purpose, encoded_list, size, next_index)
        VALUES (${listId}, ${dev}, 'revocation', ${gzipSync(Buffer.alloc(16384, 0)).toString('base64url')},
                131072, ${index + 1})`;
      await sql`
        INSERT INTO verifiable_credentials
          (id, grant_id, developer_id, principal_id, agent_did, credential_type, credential_jwt, status,
           status_list_id, status_list_idx, expires_at)
        VALUES (${vcId}, ${child}, ${dev}, 'user_rvc', ${'did:grantex:' + agent}, 'AgentGrantCredential',
                'placeholder', 'active', ${listId}, ${index}, NOW() + INTERVAL '1 hour')`;

      const result = await revokeGrantCascade(parent, dev);
      expect(result).toEqual({ revoked: true, descendantCount: 1 });

      const grants = await sql<{ id: string; status: string }[]>`
        SELECT id, status FROM grants WHERE developer_id = ${dev} ORDER BY id`;
      expect(grants.map((row) => row.status)).toEqual(['revoked', 'revoked']);

      // Committed with the grants, not attempted afterwards and dropped.
      const [credential] = await sql<{ status: string }[]>`
        SELECT status FROM verifiable_credentials WHERE id = ${vcId}`;
      expect(credential!.status).toBe('revoked');

      const [list] = await sql<{ encoded_list: string }[]>`
        SELECT encoded_list FROM vc_status_lists WHERE id = ${listId}`;
      const bits = gunzipSync(Buffer.from(list!.encoded_list, 'base64url'));
      expect((bits[Math.floor(index / 8)]! >> (7 - (index % 8))) & 1).toBe(1);
    } finally {
      await sql`DELETE FROM verifiable_credentials WHERE developer_id = ${dev}`.catch(() => undefined);
      await sql`DELETE FROM vc_status_lists WHERE developer_id = ${dev}`.catch(() => undefined);
      await sql`DELETE FROM grants WHERE developer_id = ${dev}`.catch(() => undefined);
      await sql`DELETE FROM agents WHERE developer_id = ${dev}`.catch(() => undefined);
      await sql`DELETE FROM developers WHERE id = ${dev}`.catch(() => undefined);
    }
  }, 300_000);

  it('auto-revokes an agent tree, credentials and status bits only under revoke policy', async () => {
    const sql = state.pool!;
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
    const dev = `dev_rvc_${suffix}`;
    const agent = `ag_rvc_${suffix}`;
    const childAgent = `ag_rvc_c_${suffix}`;
    const otherAgent = `ag_rvc_o_${suffix}`;
    const parent = `grnt_rvc_p_${suffix}`;
    const child = `grnt_rvc_c_${suffix}`;
    const unrelated = `grnt_rvc_o_${suffix}`;
    const listId = `vcsl_rvc_${suffix}`;
    const emptyList = gzipSync(Buffer.alloc(16384, 0)).toString('base64url');

    await runMigrations(sql);
    try {
      await sql`INSERT INTO developers (id, api_key_hash, name, irregularity_response_mode)
                VALUES (${dev}, ${'hash_' + suffix}, 'Auto Revoke VC Test', 'alert_only')`;
      for (const id of [agent, childAgent, otherAgent]) {
        await sql`INSERT INTO agents (id, did, developer_id, name)
                  VALUES (${id}, ${'did:grantex:' + id}, ${dev}, 'Agent')`;
      }
      await sql`INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, expires_at)
                VALUES (${parent}, ${agent}, 'user_rvc', ${dev}, ${['read']}, NOW() + INTERVAL '1 hour')`;
      await sql`INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, expires_at, parent_grant_id)
                VALUES (${child}, ${childAgent}, 'user_rvc', ${dev}, ${['read']}, NOW() + INTERVAL '1 hour', ${parent})`;
      await sql`INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, expires_at)
                VALUES (${unrelated}, ${otherAgent}, 'user_rvc', ${dev}, ${['read']}, NOW() + INTERVAL '1 hour')`;
      await sql`INSERT INTO vc_status_lists (id, developer_id, purpose, encoded_list, size, next_index)
                VALUES (${listId}, ${dev}, 'revocation', ${emptyList}, 131072, 3)`;
      for (const [grantId, index] of [[parent, 1], [child, 2]] as const) {
        await sql`
          INSERT INTO verifiable_credentials
            (id, grant_id, developer_id, principal_id, agent_did, credential_type, credential_jwt,
             status, status_list_id, status_list_idx, expires_at)
          VALUES (${'vc_' + grantId}, ${grantId}, ${dev}, 'user_rvc', ${'did:grantex:' + agent},
                  'AgentGrantCredential', 'placeholder', 'active', ${listId}, ${index},
                  NOW() + INTERVAL '1 hour')`;
      }

      expect(await revokeAgentGrantsCascade(agent, dev, true)).toEqual([]);
      expect((await sql`SELECT status FROM grants WHERE id = ${parent}`)[0]?.['status']).toBe('active');

      await sql`UPDATE developers SET irregularity_response_mode = 'revoke_agent_grants' WHERE id = ${dev}`;
      expect(new Set(await revokeAgentGrantsCascade(agent, dev, true)))
        .toEqual(new Set([parent, child]));
      const grants = await sql`SELECT id, status FROM grants WHERE developer_id = ${dev}`;
      expect(grants.find((row) => row['id'] === unrelated)?.['status']).toBe('active');
      expect(grants.filter((row) => row['id'] !== unrelated).every((row) => row['status'] === 'revoked')).toBe(true);
      const credentials = await sql`SELECT status FROM verifiable_credentials WHERE developer_id = ${dev}`;
      expect(credentials.every((row) => row['status'] === 'revoked')).toBe(true);
      const [list] = await sql<{ encoded_list: string }[]>`
        SELECT encoded_list FROM vc_status_lists WHERE id = ${listId}`;
      const bits = gunzipSync(Buffer.from(list!.encoded_list, 'base64url'));
      expect((bits[0]! >> 6) & 1).toBe(1);
      expect((bits[0]! >> 5) & 1).toBe(1);

      await sql`UPDATE verifiable_credentials SET status = 'active', revoked_at = NULL
                WHERE developer_id = ${dev}`;
      await sql`UPDATE grants SET status = 'active', revoked_at = NULL WHERE id = ${child}`;
      await sql`UPDATE vc_status_lists SET encoded_list = ${emptyList} WHERE id = ${listId}`;
      expect(await reconcileRevokedGrantDescendants()).toBe(1);
      expect((await sql`SELECT status FROM grants WHERE id = ${child}`)[0]?.['status']).toBe('revoked');
      expect(await reconcileRevokedGrantVCs()).toBe(1);
      const repaired = await sql`SELECT status FROM verifiable_credentials WHERE developer_id = ${dev}`;
      expect(repaired.every((row) => row['status'] === 'revoked')).toBe(true);
      const [repairedList] = await sql<{ encoded_list: string }[]>`
        SELECT encoded_list FROM vc_status_lists WHERE id = ${listId}`;
      const repairedBits = gunzipSync(Buffer.from(repairedList!.encoded_list, 'base64url'));
      expect((repairedBits[0]! >> 6) & 1).toBe(1);
      expect((repairedBits[0]! >> 5) & 1).toBe(1);
      expect(await reconcileRevokedGrantDescendants()).toBe(0);
      expect(await reconcileRevokedGrantVCs()).toBe(0);
    } finally {
      await sql`DELETE FROM verifiable_credentials WHERE developer_id = ${dev}`.catch(() => undefined);
      await sql`DELETE FROM vc_status_lists WHERE developer_id = ${dev}`.catch(() => undefined);
      await sql`DELETE FROM grants WHERE developer_id = ${dev}`.catch(() => undefined);
      await sql`DELETE FROM agents WHERE developer_id = ${dev}`.catch(() => undefined);
      await sql`DELETE FROM developers WHERE id = ${dev}`.catch(() => undefined);
    }
  }, 300_000);
});
