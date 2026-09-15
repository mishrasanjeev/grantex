/**
 * Evidence endpoints (PRD G-5) with the database mocked: flag, tenant scope,
 * validation before any write, disclosure permission, reason codes, reserved
 * audit names, startup configuration and audit stamping. The full write and
 * export flow runs against real Postgres in
 * tests/evidence-postgres.integration.test.ts.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reservedAuditError } from '../src/lib/audit-reserved.js';
import { nextStamp, validateRecord } from '../src/lib/evidence-service/service.js';
import { evidenceConfigErrors } from '../src/lib/evidence-service/settings.js';
import { authHeader, buildTestApp, seedAuth, sqlMock } from './helpers.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let app: FastifyInstance;
const CASE = 'case_demo_0001';
const digest = (label: string): string => `sha256:${createHash('sha256').update(label).digest('hex')}`;
const NOW = new Date('2026-09-14T12:00:00.000Z');

beforeAll(async () => {
  app = await buildTestApp();
});

beforeEach(() => {
  vi.stubEnv('EVIDENCE_EXPORT_ENABLED', 'true');
  vi.stubEnv('EVIDENCE_PSEUDONYMISATION_SECRET', 'placeholder-evidence-secret-for-tests-only-0000');
  sqlMock.mockReset();
  sqlMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function toolCall(n: number): Json {
  const at = `2026-09-14T09:05:${String(n).padStart(2, '0')}.000Z`;
  return {
    type: 'tool_call',
    at,
    data: {
      call_id: `call_${n}`, connector: 'acme_kyb', grant_id: 'grnt_leaf', input_hash: digest(`in${n}`), outcome: 'allowed',
      output_hash: digest(`out${n}`), provider: 'mock', purpose: 'aml.cdd.onboarding', started_at: at, tool: 'verify_business',
      upstream_records: [{ record_id: `mock:verification:v-${n}`, retrieved_at: at }],
    },
  };
}

const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: authHeader(), payload: payload as Json });

describe('feature flag and access', () => {
  it('is off unless EVIDENCE_EXPORT_ENABLED is true', async () => {
    vi.stubEnv('EVIDENCE_EXPORT_ENABLED', 'false');
    for (const path of ['export', 'records', 'void']) {
      seedAuth();
      const res = await post(`/v1/evidence/cases/${CASE}/${path}`, {});
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'FEATURE_DISABLED' });
    }
  });

  it('can be limited to listed developers', async () => {
    vi.stubEnv('EVIDENCE_EXPORT_DEVELOPER_IDS', 'dev_other');
    seedAuth();
    expect((await post(`/v1/evidence/cases/${CASE}/records`, { records: [toolCall(1)] })).statusCode).toBe(403);
  });

  it('requires an API key', async () => {
    expect((await app.inject({ method: 'POST', url: `/v1/evidence/cases/${CASE}/export`, payload: {} })).statusCode).toBe(401);
  });

  it('refuses disclosure unless an operator allowed it for the developer', async () => {
    seedAuth();
    let res = await post(`/v1/evidence/cases/${CASE}/export`, { disclose: ['approver', 'content', 'principal', 'record', 'subject'] });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'EVIDENCE_DISCLOSURE_NOT_PERMITTED', field_path: 'disclose' });
    expect(sqlMock).toHaveBeenCalledTimes(1); // only the API key lookup
    vi.stubEnv('EVIDENCE_DISCLOSURE_DEVELOPER_IDS', 'dev_TEST');
    seedAuth();
    res = await post(`/v1/evidence/cases/${CASE}/export`, { disclose: ['approver'] });
    expect(res.json()).toMatchObject({ code: 'EVIDENCE_CASE_NOT_FOUND' });
  });

  it('does not let the caller set the case state or other options', async () => {
    seedAuth();
    const res = await post(`/v1/evidence/cases/${CASE}/export`, { state: 'decided' });
    expect(res.json()).toMatchObject({ code: 'BAD_REQUEST', field_path: 'state' });
  });

  it('fails closed without a pseudonymisation key', async () => {
    vi.stubEnv('EVIDENCE_PSEUDONYMISATION_SECRET', '');
    seedAuth();
    expect((await post(`/v1/evidence/cases/${CASE}/export`, {})).json()).toMatchObject({ code: 'EVIDENCE_PSEUDONYMISATION_KEY_MISSING' });
  });

  it('refuses a malformed case id', async () => {
    seedAuth();
    const res = await post(`/v1/evidence/cases/${encodeURIComponent('case with space')}/records`, { records: [toolCall(1)] });
    expect(res.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('records are validated before anything is written', () => {
  it('refuses the whole request when any record is invalid, naming the field', async () => {
    const bad = toolCall(2);
    bad['data']['notes'] = 'free text';
    seedAuth();
    const res = await post(`/v1/evidence/cases/${CASE}/records`, { records: [toolCall(1), bad] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'EVIDENCE_RECORD_INVALID', field_path: 'records[1].data.notes' });
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it('refuses platform-only types, empty and oversized batches', async () => {
    for (const type of ['grant', 'decision', 'decision_consumption', 'revocation', 'void']) {
      seedAuth();
      const res = await post(`/v1/evidence/cases/${CASE}/records`, { records: [{ type, at: '2026-09-14T09:00:00.000Z', data: {} }] });
      expect(res.json(), type).toMatchObject({ code: 'EVIDENCE_RECORD_INVALID', field_path: 'records[0].type' });
    }
    seedAuth();
    expect((await post(`/v1/evidence/cases/${CASE}/records`, { records: [] })).statusCode).toBe(400);
    seedAuth();
    expect((await post(`/v1/evidence/cases/${CASE}/records`, { records: Array.from({ length: 101 }, (_, i) => toolCall(i % 60)) })).statusCode).toBe(400);
  });

  it('checks record-level rules', () => {
    const denied = toolCall(3);
    denied['data']['outcome'] = 'denied';
    expect(() => validateRecord(denied, 0, NOW)).toThrowError(expect.objectContaining({ fieldPath: 'records[0].data.denial' }) as Error);
    const backwards = toolCall(4);
    backwards['data']['completed_at'] = '2026-09-14T09:00:00.000Z';
    expect(() => validateRecord(backwards, 0, NOW)).toThrowError(expect.objectContaining({ fieldPath: 'records[0].data.completed_at' }) as Error);
    const future = toolCall(5);
    future['at'] = '2026-09-14T12:10:00.000Z';
    expect(() => validateRecord(future, 0, NOW)).toThrowError(expect.objectContaining({ fieldPath: 'records[0].at' }) as Error);
    const impossible = toolCall(6);
    impossible['at'] = '2026-02-30T09:00:00.000Z';
    expect(() => validateRecord(impossible, 0, NOW)).toThrowError(expect.objectContaining({ fieldPath: 'records[0].at' }) as Error);
    const keyed = toolCall(7);
    keyed['data']['input_hash'] = `hmac-sha256:${'0'.repeat(64)}`;
    expect(() => validateRecord(keyed, 0, NOW)).toThrowError(expect.objectContaining({ fieldPath: 'records[0].data.input_hash' }) as Error);
    const unsourced = {
      type: 'policy_evaluation', at: '2026-09-14T09:06:00.000Z',
      data: {
        evaluation_id: 'eval_1', fired_rules: [], inputs: [{ evidence: [], path: 'x', value: 1 }],
        policy: { digest: digest('p'), id: 'p', version: '1' }, score: 1, tier: 'low',
      },
    };
    expect(() => validateRecord(unsourced, 0, NOW)).toThrowError(expect.objectContaining({ fieldPath: 'records[0].data.inputs[0].unsourced' }) as Error);
  });

  it('validates the void body before writing', async () => {
    seedAuth();
    const res = await post(`/v1/evidence/cases/${CASE}/void`, { target_type: 'grant', target_id: 'grnt_1', reason_code: 'mistake' });
    expect(res.json()).toMatchObject({ code: 'EVIDENCE_RECORD_INVALID', field_path: 'target_type' });
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });
});

describe('platform-only audit names', () => {
  it('refuses evidence, decision and platform names on /v1/audit/log', async () => {
    const base = { agentId: 'ag_1', agentDid: 'did:grantex:ag_1', grantId: 'grnt_1', principalId: 'user_1' };
    for (const [action, metadata, code] of [
      ['evidence.package_exported', {}, 'AUDIT_ACTION_RESERVED'],
      ['Decision.approved', {}, 'AUDIT_ACTION_RESERVED'],
      ['grantex.anything', {}, 'AUDIT_ACTION_RESERVED'],
      ['tool.run', { 'grantex:platform': true }, 'AUDIT_METADATA_RESERVED'],
    ] as const) {
      seedAuth();
      const res = await post('/v1/audit/log', { ...base, action, metadata });
      expect(res.statusCode, action).toBe(400);
      expect(res.json()).toMatchObject({ code });
    }
    expect(reservedAuditError('tool.run', { case_id: 'x' })).toBeNull();
  });
});

describe('configuration and audit stamping', () => {
  it('rejects malformed evidence settings at startup', () => {
    expect(evidenceConfigErrors({ EVIDENCE_PSEUDONYMISATION_KEY_ID: 'bad key id' })).toHaveLength(1);
    expect(evidenceConfigErrors({ EVIDENCE_PSEUDONYMISATION_SECRET: 'too-short' })).toHaveLength(1);
    expect(evidenceConfigErrors({ EVIDENCE_EXPORT_ENABLED: 'yes' })).toHaveLength(1);
    expect(evidenceConfigErrors({ EVIDENCE_PSEUDONYMISATION_KEY_ID: 'v2', EVIDENCE_EXPORT_ENABLED: 'true' })).toEqual([]);
  });

  it('never stamps an audit entry ahead of the clock and always sorts after the head', () => {
    const head = { hash: 'a'.repeat(64), timestampMs: NOW.getTime(), id: 'alog_01M2J49WGKYSC05V0WJAGBGR58' };
    const same = nextStamp(head, NOW);
    expect(same.timestamp).toBe(NOW.toISOString());
    expect(same.id > head.id).toBe(true);
    const later = nextStamp(head, new Date(NOW.getTime() + 5));
    expect(later.timestampMs).toBe(NOW.getTime() + 5);
    const behind = nextStamp({ ...head, timestampMs: NOW.getTime() - 1000 }, NOW);
    expect(behind.timestampMs).toBe(NOW.getTime());
  });
});
