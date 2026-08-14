import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { computeAuditHash, matchStoredAuditHash } from '../src/lib/hash.js';

const databaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('audit metadata write/read integration (Postgres)', () => {
  it('stores sql.json as an object and verifies both new and legacy rows', async () => {
    const sql = postgres(databaseUrl!, { max: 1, idle_timeout: 5, connect_timeout: 10 });
    try {
      await sql.begin(async (tx) => {
        await tx`
          CREATE TEMP TABLE audit_entries_probe (
            id            TEXT PRIMARY KEY,
            agent_id      TEXT NOT NULL,
            agent_did     TEXT NOT NULL,
            grant_id      TEXT NOT NULL,
            principal_id  TEXT NOT NULL,
            developer_id  TEXT NOT NULL,
            action        TEXT NOT NULL,
            metadata      JSONB NOT NULL,
            hash          TEXT NOT NULL,
            previous_hash TEXT,
            timestamp     TIMESTAMPTZ NOT NULL,
            status        TEXT NOT NULL
          ) ON COMMIT DROP`;

        const metadata = { zebra: 1, alpha: { yankee: true, bravo: [3, 2] } };
        const base = {
          agentId: 'ag_01',
          agentDid: 'did:grantex:ag_01',
          grantId: 'grnt_01',
          principalId: 'user_01',
          developerId: 'dev_TEST',
          action: 'tool.run',
          timestamp: '2026-08-14T00:00:00.000Z',
          prevHash: null as string | null,
          status: 'success',
        };

        const currentFields = { ...base, id: 'alog_current', metadata };
        const currentHash = computeAuditHash(currentFields);
        await tx`
          INSERT INTO audit_entries_probe
            (id, agent_id, agent_did, grant_id, principal_id, developer_id,
             action, metadata, hash, previous_hash, timestamp, status)
          VALUES
            (${currentFields.id}, ${base.agentId}, ${base.agentDid}, ${base.grantId},
             ${base.principalId}, ${base.developerId}, ${base.action}, ${tx.json(metadata)},
             ${currentHash}, ${base.prevHash}, ${base.timestamp}, ${base.status})`;

        const [currentRow] = await tx`
          SELECT *, jsonb_typeof(metadata) AS metadata_type
          FROM audit_entries_probe WHERE id = ${currentFields.id}`;
        expect(currentRow!['metadata_type']).toBe('object');
        expect(currentRow!['metadata']).toEqual(metadata);
        expect(matchStoredAuditHash({
          ...currentFields,
          timestamp: (currentRow!['timestamp'] as Date).toISOString(),
          metadata: currentRow!['metadata'],
        }, currentHash)).toBe('C');

        // Reproduce the historical `${JSON.stringify(metadata)}` write exactly.
        const encodedFields = { ...base, id: 'alog_encoded_c', metadata };
        const encodedHash = computeAuditHash(encodedFields);
        await tx`
          INSERT INTO audit_entries_probe
            (id, agent_id, agent_did, grant_id, principal_id, developer_id,
             action, metadata, hash, previous_hash, timestamp, status)
          VALUES
            (${encodedFields.id}, ${base.agentId}, ${base.agentDid}, ${base.grantId},
             ${base.principalId}, ${base.developerId}, ${base.action}, ${JSON.stringify(metadata)},
             ${encodedHash}, ${base.prevHash}, ${base.timestamp}, ${base.status})`;

        const [encodedRow] = await tx`
          SELECT *, jsonb_typeof(metadata) AS metadata_type
          FROM audit_entries_probe WHERE id = ${encodedFields.id}`;
        expect(encodedRow!['metadata_type']).toBe('string');
        expect(encodedRow!['metadata']).toBe(JSON.stringify(metadata));
        expect(matchStoredAuditHash({
          ...encodedFields,
          timestamp: (encodedRow!['timestamp'] as Date).toISOString(),
          metadata: encodedRow!['metadata'],
        }, encodedHash)).toBe('C');

        const eraBFields = {
          ...base,
          id: 'alog_era_b',
          metadata,
          timestamp: '2026-03-01T00:00:00.000Z',
        };
        const eraBHash = createHash('sha256').update(JSON.stringify({
          id: eraBFields.id,
          agentId: eraBFields.agentId,
          agentDid: eraBFields.agentDid,
          grantId: eraBFields.grantId,
          principalId: eraBFields.principalId,
          developerId: eraBFields.developerId,
          action: eraBFields.action,
          metadata,
          timestamp: eraBFields.timestamp,
          prevHash: eraBFields.prevHash,
          status: eraBFields.status,
        })).digest('hex');
        await tx`
          INSERT INTO audit_entries_probe
            (id, agent_id, agent_did, grant_id, principal_id, developer_id,
             action, metadata, hash, previous_hash, timestamp, status)
          VALUES
            (${eraBFields.id}, ${base.agentId}, ${base.agentDid}, ${base.grantId},
             ${base.principalId}, ${base.developerId}, ${base.action}, ${JSON.stringify(metadata)},
             ${eraBHash}, ${base.prevHash}, ${eraBFields.timestamp}, ${base.status})`;

        const [eraBRow] = await tx`
          SELECT * FROM audit_entries_probe WHERE id = ${eraBFields.id}`;
        expect(matchStoredAuditHash({
          ...eraBFields,
          timestamp: (eraBRow!['timestamp'] as Date).toISOString(),
          metadata: eraBRow!['metadata'],
        }, eraBHash)).toBe('B');
      });
    } finally {
      await sql.end();
    }
  });

  it('runs the writeback probe without touching permanent tables', () => {
    const result = spawnSync(process.execPath, [
      'scripts/jsonb-writeback-probe.mjs',
      databaseUrl!,
    ], { cwd: process.cwd(), encoding: 'utf8' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('jsonb_typeof(metadata) : string');
    expect(result.stdout.match(/jsonb_typeof\(metadata\) : object/g)).toHaveLength(2);
    expect(result.stdout).toContain('the value is double-encoded');
  });
});
