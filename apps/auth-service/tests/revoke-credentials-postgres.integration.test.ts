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
  await db.sql.end();
  state.pool = postgres(db.url, { max: 4, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
  dropTestDatabase = db.drop;
}, 60_000);

afterAll(async () => {
  await state.pool?.end();
  state.pool = null;
  await dropTestDatabase?.();
}, 60_000);

const { revokeGrantCascade } = await import('../src/lib/revoke.js');
const { runMigrations } = await import('../src/db/migrate.js');

describePostgres('revoking a grant revokes its credentials in the same transaction', () => {
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
      await sql.end({ timeout: 5 }).catch(() => undefined);
    }
  }, 300_000);
});
