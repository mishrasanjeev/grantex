import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const S = JSON.stringify;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return S(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, nested]) => `${S(key)}:${canonical(nested)}`)
    .join(',')}}`;
};

type FixtureRow = Record<string, unknown> & {
  id: string;
  developer_id: string;
  timestamp: string;
  previous_hash: string | null;
  hash?: string;
};

const prefix = (row: FixtureRow) => '{'
  + `"id":${S(row.id)},"agentId":${S(row['agent_id'])},"agentDid":${S(row['agent_did'])},`
  + `"grantId":${S(row['grant_id'])},"principalId":${S(row['principal_id'])},`
  + `"developerId":${S(row.developer_id)},"action":${S(row['action'])},`;
const hashA = (row: FixtureRow, metadataJson: string) => sha(prefix(row)
  + `"metadata":${metadataJson},"timestamp":${S(row.timestamp)},`
  + `"previousHash":${S(row.previous_hash)}}`);
const hashBC = (row: FixtureRow, metadataJson: string) => sha(prefix(row)
  + `"metadata":${metadataJson},"timestamp":${S(row.timestamp)},`
  + `"prevHash":${S(row.previous_hash)},"status":${S(row['status'])}}`);

function row(
  id: string,
  developerId: string,
  timestamp: string,
  previousHash: string | null,
  metadata: unknown,
  action = 'tool.run',
): FixtureRow {
  return {
    id,
    agent_id: `ag_${developerId}`,
    agent_did: `did:grantex:ag_${developerId}`,
    grant_id: `grnt_${developerId}`,
    principal_id: `user_${developerId}`,
    developer_id: developerId,
    action,
    metadata,
    previous_hash: previousHash,
    timestamp,
    ts_raw: timestamp,
    status: 'success',
    meta_type: typeof metadata === 'string' ? 'string' : 'object',
  };
}

function runForensics(fixture: string, ...args: string[]) {
  return spawnSync(process.execPath, [
    'scripts/audit-chain-forensics.mjs', '--file', fixture, ...args,
  ], { cwd: process.cwd(), encoding: 'utf8' });
}

describe('audit-chain-forensics.mjs', () => {
  it('classifies historical formats, tampering, filtering, and tenant linkage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grantex-forensics-test-'));
    try {
      const raw = '{"zebra":1,"alpha":{"yankee":true,"bravo":[3,2]}}';
      const rows: FixtureRow[] = [];
      let current = row('alog_A', 'dev_A', '2026-02-25T00:00:00.000Z', null, raw);
      current.hash = hashA(current, raw);
      rows.push(current);

      current = row('alog_B', 'dev_A', '2026-03-01T00:00:00.000Z', current.hash!, raw);
      current.hash = hashBC(current, raw);
      rows.push(current);

      current = row('alog_C', 'dev_A', '2026-08-13T00:00:00.000Z', current.hash!, raw);
      current.hash = hashBC(current, canonical(JSON.parse(raw)));
      rows.push(current);

      current = row('alog_TAMPER', 'dev_A', '2026-08-14T00:00:00.000Z', current.hash!, raw, 'tool.delete');
      current.hash = hashBC({ ...current, action: 'tool.run' }, canonical(JSON.parse(raw)));
      rows.push(current);

      const sorted = '{"alpha":1,"zebra":2}';
      current = row('alog_BC', 'dev_B', '2026-08-01T00:00:00.000Z', null, sorted);
      current.hash = hashBC(current, sorted);
      rows.push(current);

      // JSONB object read-back order differs from the original canonical bytes;
      // without preserved insertion order the only defensible result is B/C.
      current = row('alog_OBJECT_AMBIG', 'dev_C', '2026-08-01T00:00:01.000Z', null, { b: 2, aa: 1 });
      current.hash = hashBC(current, '{"aa":1,"b":2}');
      rows.push(current);

      const fixture = join(dir, 'rows.json');
      writeFileSync(fixture, JSON.stringify(rows), 'utf8');
      const result = runForensics(fixture, '--limit', '0', '--json');
      expect(result.status, result.stderr).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        rows: Array<{ id: string; era: string | null }>;
        linkage: Array<{ developerId: string; broken: string | null }>;
      };
      expect(Object.fromEntries(parsed.rows.map((item) => [item.id, item.era ?? 'UNEXPLAINED'])))
        .toMatchObject({
          alog_A: 'A',
          alog_B: 'B',
          alog_C: 'C',
          alog_TAMPER: 'UNEXPLAINED',
          alog_BC: 'B/C',
          alog_OBJECT_AMBIG: 'B/C',
        });
      expect(parsed.linkage).toEqual(expect.arrayContaining([
        expect.objectContaining({ developerId: 'dev_A', broken: null }),
        expect.objectContaining({ developerId: 'dev_B', broken: null }),
        expect.objectContaining({ developerId: 'dev_C', broken: null }),
      ]));

      const filtered = runForensics(fixture, '--developer', 'dev_B', '--limit', '1', '--json');
      expect(filtered.status, filtered.stderr).toBe(0);
      expect((JSON.parse(filtered.stdout) as { rows: Array<{ id: string }> }).rows)
        .toEqual([expect.objectContaining({ id: 'alog_BC' })]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps exhausted searches inconclusive and withholds invalid metadata text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grantex-forensics-safety-'));
    try {
      const validRaw = '{"zebra":1,"alpha":2}';
      const valid = row('alog_VALID', 'dev_A', '2026-08-13T00:00:00.000Z', null, validRaw);
      valid.hash = hashBC(valid, canonical(JSON.parse(validRaw)));
      const unknown = row('alog_UNKNOWN', 'dev_B', '2026-08-14T00:00:00.000Z', null, {
        delta: 4, charlie: 3, bravo: 2, alpha: 1,
      });
      unknown.hash = '0'.repeat(64);
      const invalid = row('alog_INVALID', 'dev_C', '2026-08-15T00:00:00.000Z', null, 'customer-secret-value');
      invalid.hash = '1'.repeat(64);

      const fixture = join(dir, 'rows.json');
      writeFileSync(fixture, JSON.stringify([valid, unknown, invalid]), 'utf8');
      const text = runForensics(fixture, '--limit', '0', '--budget', '1');
      expect(text.status, text.stderr).toBe(0);
      expect(text.stdout).toContain('INCONCLUSIVE');
      expect(text.stdout).not.toContain('Every row is explained');
      expect(text.stdout).not.toContain('customer-secret');

      const json = runForensics(fixture, '--limit', '0', '--budget', '1', '--json');
      expect(json.status, json.stderr).toBe(0);
      expect(json.stdout).not.toContain('customer-secret');
      expect((JSON.parse(json.stdout) as { rows: Array<{ id: string; metaParseError: string | null }> }).rows)
        .toContainEqual(expect.objectContaining({ id: 'alog_INVALID', metaParseError: 'invalid_json' }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
