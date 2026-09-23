import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';

const databaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !databaseUrl) {
  throw new Error(
    'AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres purpose integration tests',
  );
}
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('purpose-bound grants against real Postgres', () => {
  it('migrates additively and stamps the grant purpose on audit entries of the same developer only', async () => {
    const sql = postgres(databaseUrl!, { max: 2, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
    const developerId = `dev_purpose_${suffix}`;
    const otherDeveloperId = `dev_other_${suffix}`;
    const agentId = `ag_purpose_${suffix}`;
    const grantId = `grnt_purpose_${suffix}`;
    const details = [{ type: 'urn:grantex:tools:v1', connector: 'acme_kyb', purpose: 'aml.cdd.onboarding' }];
    try {
      await runMigrations(sql);
      // A repeat start applies nothing now that the ledger exists; it used to
      // re-apply every file, which is what the second call here was for.
      expect((await runMigrations(sql)).applied).toEqual([]);

      const columns = await sql<{ table_name: string; is_nullable: string }[]>`
        SELECT table_name, is_nullable FROM information_schema.columns
        WHERE column_name = 'purpose' AND table_name IN ('auth_requests', 'grants', 'audit_entries')
        ORDER BY table_name`;
      expect(columns).toEqual([
        { table_name: 'audit_entries', is_nullable: 'YES' },
        { table_name: 'auth_requests', is_nullable: 'YES' },
        { table_name: 'grants', is_nullable: 'YES' },
      ]);

      await sql`INSERT INTO developers (id, api_key_hash, name) VALUES
        (${developerId}, ${'hash_' + suffix}, 'Purpose Test'),
        (${otherDeveloperId}, ${'hash_other_' + suffix}, 'Other Test')`;
      await sql`INSERT INTO agents (id, did, developer_id, name)
        VALUES (${agentId}, ${'did:grantex:' + agentId}, ${developerId}, 'Underwriting Agent')`;

      await sql`
        INSERT INTO auth_requests (id, agent_id, principal_id, developer_id, scopes, expires_at, purpose, authorization_details)
        VALUES (${'areq_' + suffix}, ${agentId}, 'user_01', ${developerId}, ${['tool:acme_kyb:read']},
                NOW() + INTERVAL '10 minutes', 'aml.cdd.onboarding', ${sql.json(details as never)})`;
      const [request] = await sql`SELECT purpose, authorization_details FROM auth_requests WHERE id = ${'areq_' + suffix}`;
      expect(request).toEqual({ purpose: 'aml.cdd.onboarding', authorization_details: details });

      await sql`
        INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, expires_at, purpose, authorization_details)
        VALUES (${grantId}, ${agentId}, 'user_01', ${developerId}, ${['tool:acme_kyb:read']},
                NOW() + INTERVAL '1 hour', 'aml.cdd.onboarding', ${sql.json(details as never)})`;

      const insertAudit = (id: string, owner: string) => sql`
        INSERT INTO audit_entries (id, agent_id, agent_did, grant_id, principal_id, developer_id, action, metadata, hash, previous_hash, timestamp, status, purpose)
        VALUES (
          ${id}, ${agentId}, ${'did:grantex:' + agentId}, ${grantId}, 'user_01',
          ${owner}, 'acme_kyb.resolve_business', ${sql.json({})}, ${'hash_' + id},
          NULL, ${new Date().toISOString()}, 'success',
          (SELECT g.purpose FROM grants g WHERE g.id = ${grantId} AND g.developer_id = ${owner})
        )
        RETURNING purpose`;

      expect((await insertAudit(`alog_a_${suffix}`, developerId))[0]).toEqual({ purpose: 'aml.cdd.onboarding' });
      // Another developer naming this grant id must not learn its purpose.
      expect((await insertAudit(`alog_b_${suffix}`, otherDeveloperId))[0]).toEqual({ purpose: null });

      const [refreshRow] = await sql`SELECT g.authorization_details AS grant_authorization_details FROM grants g WHERE g.id = ${grantId}`;
      expect(refreshRow!['grant_authorization_details']).toEqual(details);
    } finally {
      await sql`DELETE FROM audit_entries WHERE grant_id = ${grantId}`.catch(() => undefined);
      await sql`DELETE FROM grants WHERE id = ${grantId}`.catch(() => undefined);
      await sql`DELETE FROM auth_requests WHERE id = ${'areq_' + suffix}`.catch(() => undefined);
      await sql`DELETE FROM agents WHERE id = ${agentId}`.catch(() => undefined);
      await sql`DELETE FROM developers WHERE id IN (${developerId}, ${otherDeveloperId})`.catch(() => undefined);
      await sql.end();
    }
  }, 120_000);
});
