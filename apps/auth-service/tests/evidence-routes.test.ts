/**
 * Evidence endpoints (PRD G-5) with the database mocked: flag, tenant scope,
 * validation, error mapping, export assembly and chain-verification alerts.
 * tests/evidence-postgres.integration.test.ts runs the same flow against real
 * Postgres, including the export-duration benchmark.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeAuditHash } from '../src/lib/hash.js';
import { isPseudonym } from '../src/lib/evidence/hashing.js';
import { verifyPackage } from '../src/lib/evidence/verify.js';
import { onChainVerificationFailure, type ChainVerificationFailure } from '../src/lib/evidence-service/metrics.js';
import { assembleRecords, selectGrantChain, validateRecord, type AuditRow, type GrantRow } from '../src/lib/evidence-service/service.js';
import { authHeader, buildTestApp, seedAuth, sqlMock, TEST_DEVELOPER } from './helpers.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let app: FastifyInstance;
const CASE = 'case_demo_0001';
const digest = (label: string): string => `sha256:${createHash('sha256').update(label).digest('hex')}`;

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

function toolCall(n: number, grantId = 'grnt_leaf'): Json {
  const at = `2026-09-14T09:05:${String(n).padStart(2, '0')}.000Z`;
  return {
    type: 'tool_call',
    at,
    agent_id: 'ag_underwriter',
    data: {
      call_id: `call_${n}`,
      connector: 'acme_kyb',
      grant_id: grantId,
      input_hash: digest(`in${n}`),
      outcome: 'allowed',
      output_hash: digest(`out${n}`),
      provider: 'mock',
      purpose: 'aml.cdd.onboarding',
      started_at: at,
      tool: 'verify_business',
      upstream_records: [{ record_id: `mock:verification:v-${n}`, retrieved_at: at }],
    },
  };
}

function auditRows(records: Json[], extra: Array<{ action: string; metadata: Json; principal?: string }> = []): AuditRow[] {
  let prevHash: string | null = null;
  let t = Date.parse('2026-09-14T09:06:00.000Z');
  const rows: AuditRow[] = [];
  const push = (action: string, metadata: Json, grantId: string, principal = 'platform'): void => {
    const timestamp = new Date(t += 1000);
    const fields = {
      id: `alog_${rows.length}`, agentId: '', agentDid: '', grantId, principalId: principal, developerId: TEST_DEVELOPER.id,
      action, metadata, timestamp: timestamp.toISOString(), prevHash, status: 'success',
    };
    const hash = computeAuditHash(fields);
    rows.push({
      id: fields.id, agent_id: '', agent_did: '', grant_id: grantId, principal_id: principal, developer_id: TEST_DEVELOPER.id,
      action, metadata, hash, previous_hash: prevHash, timestamp, status: 'success',
    });
    prevHash = hash;
  };
  for (const record of records) {
    push(`evidence.${record['type'] as string}`, { case_id: CASE, evidence: { at: record['at'], data: record['data'], type: record['type'] } }, record['data']['grant_id'] ?? '');
  }
  for (const item of extra) push(item.action, item.metadata, '', item.principal);
  return rows;
}

const grants: GrantRow[] = [
  {
    id: 'grnt_root', agent_id: 'ag_orchestrator', principal_id: 'user:underwriting-team', scopes: ['tool:acme_kyb:read'], status: 'active',
    issued_at: new Date('2026-09-14T09:00:00.000Z'), expires_at: new Date('2099-01-01T00:00:00.000Z'), revoked_at: null, parent_grant_id: null,
    purpose: 'aml.cdd.onboarding',
    authorization_details: [{ type: 'urn:grantex:tools:v1', connector: 'acme_kyb', purpose: 'aml.cdd.onboarding', tools: ['verify_business'], caps: { verify_business: { per_case: 3 } } }],
  },
  {
    id: 'grnt_leaf', agent_id: 'ag_underwriter', principal_id: 'user:underwriting-team', scopes: ['tool:acme_kyb:read'], status: 'revoked',
    issued_at: new Date('2026-09-14T09:01:00.000Z'), expires_at: new Date('2099-01-01T00:00:00.000Z'), revoked_at: new Date('2026-09-14T10:00:00.000Z'),
    parent_grant_id: 'grnt_root', purpose: 'aml.cdd.onboarding', authorization_details: null,
  },
];

const action = { action: 'case_decision', case_id: CASE, decision: 'approve', subject: 'gb:00000001' };
const actionHash = `sha256:${createHash('sha256').update(JSON.stringify({ action: 'case_decision', case_id: CASE, decision: 'approve', subject: 'gb:00000001' })).digest('base64url')}`;
const decisionEntries = [
  {
    action: 'decision.approved',
    principal: 'user:approver-a',
    metadata: {
      request_id: 'dreq_1', jti: 'dgnt_1', approver: { sub: 'user:approver-a', email: 'approver-a@example.com', name: 'Approver A' },
      approver_auth: 'sso+webauthn', acr: 'phr', amr: ['hwk'], auth_time: 1, dwell_ms: 61250, dwell_source: 'page_view',
      action, action_hash: actionHash, connector: 'acme_kyb', case_version: 'v1', approval_position: 1, approvals_required: 1,
      expires_at: '2026-09-15T09:06:00.000Z',
    },
  },
  { action: 'decision.consumed', principal: 'user:approver-a', metadata: { request_id: 'dreq_1', jtis: ['dgnt_1'], action, action_hash: actionHash, case_version: 'v1', approvers: [], consumed_at_epoch: 2 } },
];

/** Mock the export queries: auth, case rows (evidence, decisions), grant chain, anchor transaction. */
function mockExport(rows: AuditRow[]): void {
  seedAuth();
  const evidenceRows = rows.filter((r) => r.action.startsWith('evidence.'));
  const decisionRows = rows.filter((r) => r.action.startsWith('decision.'));
  sqlMock.mockResolvedValueOnce(evidenceRows);
  sqlMock.mockResolvedValueOnce(decisionRows);
  sqlMock.mockResolvedValueOnce([...grants].reverse().map((g, i) => ({ ...g, hops: grants.length - 1 - i })).reverse());
  sqlMock.mockResolvedValueOnce([]); // advisory lock
  sqlMock.mockResolvedValueOnce([{ hash: 'f'.repeat(64), timestamp: new Date('2026-09-14T09:59:00.000Z') }]); // chain head
  sqlMock.mockResolvedValueOnce([]); // anchor insert
}

describe('feature flag and tenant scope', () => {
  it('is off unless EVIDENCE_EXPORT_ENABLED is true', async () => {
    vi.stubEnv('EVIDENCE_EXPORT_ENABLED', 'false');
    seedAuth();
    const res = await app.inject({ method: 'POST', url: `/v1/evidence/cases/${CASE}/export`, headers: authHeader(), payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'FEATURE_DISABLED' });
  });

  it('can be limited to listed developers', async () => {
    vi.stubEnv('EVIDENCE_EXPORT_DEVELOPER_IDS', 'dev_other');
    seedAuth();
    const res = await app.inject({ method: 'POST', url: `/v1/evidence/cases/${CASE}/records`, headers: authHeader(), payload: { records: [toolCall(1)] } });
    expect(res.statusCode).toBe(403);
  });

  it('requires an API key', async () => {
    const res = await app.inject({ method: 'POST', url: `/v1/evidence/cases/${CASE}/export`, payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('scopes every query to the authenticated developer', async () => {
    mockExport(auditRows([toolCall(1)]));
    await app.inject({ method: 'POST', url: `/v1/evidence/cases/${CASE}/export`, headers: authHeader(), payload: { disclose: ['approver', 'principal', 'subject'] } });
    const calls = sqlMock.mock.calls.slice(1, 4) as unknown[][];
    for (const call of calls) expect(call).toContain(TEST_DEVELOPER.id);
  });
});

describe('POST /v1/evidence/cases/:caseId/records', () => {
  it('appends valid records to the audit chain', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // plan
    sqlMock.mockResolvedValueOnce([]); // lock
    sqlMock.mockResolvedValueOnce([{ count: '0' }]);
    sqlMock.mockResolvedValueOnce([]); // head
    const res = await app.inject({ method: 'POST', url: `/v1/evidence/cases/${CASE}/records`, headers: authHeader(), payload: { records: [toolCall(1), toolCall(2)] } });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ case_id: string; records: Array<{ audit_entry_id: string; hash: string }> }>();
    expect(body.case_id).toBe(CASE);
    expect(body.records).toHaveLength(2);
    const inserts = (sqlMock.mock.calls as unknown[][]).filter((c) => String((c[0] as string[]).join('')).includes('INSERT INTO audit_entries'));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]).toContain('evidence.tool_call');
    expect(inserts[1]).toContain(body.records[0]!.hash); // second entry links to the first
  });

  it('refuses the whole request when any record is invalid, naming the field', async () => {
    seedAuth();
    const bad = toolCall(2);
    bad['data']['notes'] = 'free text';
    const res = await app.inject({ method: 'POST', url: `/v1/evidence/cases/${CASE}/records`, headers: authHeader(), payload: { records: [toolCall(1), bad] } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'EVIDENCE_RECORD_INVALID', field_path: 'records[1].data.notes' });
    expect(sqlMock).toHaveBeenCalledTimes(1); // only the API key lookup
  });

  it('refuses grant records, empty and oversized batches and bad case ids', async () => {
    seedAuth();
    let res = await app.inject({ method: 'POST', url: `/v1/evidence/cases/${CASE}/records`, headers: authHeader(), payload: { records: [{ type: 'grant', at: '2026-09-14T09:00:00.000Z', data: {} }] } });
    expect(res.json()).toMatchObject({ code: 'EVIDENCE_RECORD_INVALID', field_path: 'records[0].type' });
    seedAuth();
    res = await app.inject({ method: 'POST', url: `/v1/evidence/cases/${CASE}/records`, headers: authHeader(), payload: { records: [] } });
    expect(res.statusCode).toBe(400);
    seedAuth();
    res = await app.inject({ method: 'POST', url: `/v1/evidence/cases/${CASE}/records`, headers: authHeader(), payload: { records: Array.from({ length: 101 }, (_, i) => toolCall(i % 60)) } });
    expect(res.statusCode).toBe(400);
    seedAuth();
    res = await app.inject({ method: 'POST', url: `/v1/evidence/cases/${encodeURIComponent('case with space')}/records`, headers: authHeader(), payload: { records: [toolCall(1)] } });
    expect(res.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('checks record-level consistency', () => {
    const denied = toolCall(3);
    denied['data']['outcome'] = 'denied';
    expect(() => validateRecord(denied, 0)).toThrowError(expect.objectContaining({ fieldPath: 'records[0].data.denial' }) as Error);
    const call = toolCall(4);
    call['data']['completed_at'] = '2026-09-14T09:00:00.000Z';
    expect(() => validateRecord(call, 0)).toThrowError(expect.objectContaining({ fieldPath: 'records[0].data.completed_at' }) as Error);
  });
});

describe('POST /v1/evidence/cases/:caseId/export', () => {
  it('returns a verifiable, anchored, pseudonymised package', async () => {
    mockExport(auditRows([toolCall(1), toolCall(2)], decisionEntries));
    const res = await app.inject({ method: 'POST', url: `/v1/evidence/cases/${CASE}/export`, headers: authHeader(), payload: {} });
    expect(res.statusCode).toBe(200);
    const root = res.headers['grantex-evidence-root'] as string;
    const anchor = res.headers['grantex-evidence-anchor'] as string;
    const result = verifyPackage(res.rawPayload, { expectedRoot: root, expectedAnchorHash: anchor, requireAnchor: true });
    expect(result.ok, result.message).toBe(true);
    const pkg = JSON.parse(res.body) as Json;
    expect(pkg['entries'].map((e: Json) => e['type'])).toEqual(['grant', 'grant', 'tool_call', 'tool_call', 'decision', 'decision_consumption', 'revocation']);
    expect(pkg['case']).toMatchObject({ case_id: CASE, state: 'decided', tenant_id: TEST_DEVELOPER.id });
    const decision = pkg['entries'][4]['data'];
    expect(isPseudonym(decision['approver'])).toBe(true);
    expect(res.body.includes('approver-a@example.com')).toBe(false);
    expect(res.body.includes('user:underwriting-team')).toBe(false);
    expect(decision).toMatchObject({ jti: 'dgnt_1', approver_auth: 'sso+webauthn', dwell_ms: 61250, action_hash: actionHash });
    expect(pkg['entries'][6]['data']).toEqual({ grant_id: 'grnt_leaf', revoked_at: '2026-09-14T10:00:00.000Z' });
    expect(pkg['anchor']['audit_entry']['prevHash']).toBe('f'.repeat(64));
  });

  it('discloses identifier classes on request and recomputes the action hash', async () => {
    mockExport(auditRows([toolCall(1)], decisionEntries));
    const res = await app.inject({ method: 'POST', url: `/v1/evidence/cases/${CASE}/export`, headers: authHeader(), payload: { disclose: ['subject', 'approver', 'principal'] } });
    expect(res.statusCode).toBe(200);
    const pkg = JSON.parse(res.body) as Json;
    expect(pkg['privacy']).toEqual({ disclosed: ['approver', 'principal', 'subject'], scheme: 'none' });
    expect(pkg['entries'][3]['data']['approver']).toBe('user:approver-a');
  });

  it('signs the root when asked', async () => {
    mockExport(auditRows([toolCall(1)]));
    const res = await app.inject({ method: 'POST', url: `/v1/evidence/cases/${CASE}/export`, headers: authHeader(), payload: { sign: true } });
    expect(res.statusCode).toBe(200);
    const pkg = JSON.parse(res.body) as Json;
    expect(pkg['signature']).toMatchObject({ alg: 'RS256' });
    const jwks = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    const result = verifyPackage(res.rawPayload, { expectedRoot: res.headers['grantex-evidence-root'] as string, jwks: jwks.json(), requireSignature: true });
    expect(result.ok, result.message).toBe(true);
  });

  it('fails closed with a reason code', async () => {
    vi.stubEnv('EVIDENCE_PSEUDONYMISATION_SECRET', '');
    seedAuth();
    let res = await app.inject({ method: 'POST', url: `/v1/evidence/cases/${CASE}/export`, headers: authHeader(), payload: {} });
    expect(res.json()).toMatchObject({ code: 'EVIDENCE_PSEUDONYMISATION_KEY_MISSING' });
    vi.stubEnv('EVIDENCE_PSEUDONYMISATION_SECRET', 'placeholder-evidence-secret-for-tests-only-0000');

    seedAuth();
    res = await app.inject({ method: 'POST', url: `/v1/evidence/cases/${CASE}/export`, headers: authHeader(), payload: {} });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'EVIDENCE_CASE_NOT_FOUND' });

    seedAuth();
    res = await app.inject({ method: 'POST', url: `/v1/evidence/cases/${CASE}/export`, headers: authHeader(), payload: { disclose: ['everyone'] } });
    expect(res.json()).toMatchObject({ code: 'BAD_REQUEST', field_path: 'disclose' });
  });

  it('refuses a case whose source audit entry was edited and raises the alert', async () => {
    const failures: ChainVerificationFailure[] = [];
    const off = onChainVerificationFailure((f) => failures.push(f));
    try {
      const rows = auditRows([toolCall(1), toolCall(2)]);
      (rows[1]!.metadata as Json)['evidence']['data']['cost_units'] = 0;
      mockExport(rows);
      const res = await app.inject({ method: 'POST', url: `/v1/evidence/cases/${CASE}/export`, headers: authHeader(), payload: {} });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'EVIDENCE_CHAIN_VERIFICATION_FAILED' });
      expect(failures).toEqual([expect.objectContaining({ source: 'source_audit', code: 'audit_content', auditEntryId: 'alog_1', caseId: CASE })]);
      expect((sqlMock.mock.calls as unknown[][]).some((c) => String((c[0] as string[]).join('')).includes('INSERT'))).toBe(false);
    } finally {
      off();
    }
  });
});

describe('assembly', () => {
  it('requires one delegation chain', () => {
    const other: GrantRow = { ...grants[1]!, id: 'grnt_other' };
    expect(() => selectGrantChain([grants, [grants[0]!, other]])).toThrowError(expect.objectContaining({ code: 'EVIDENCE_GRANT_CHAIN_AMBIGUOUS' }) as Error);
    expect(selectGrantChain([[grants[0]!], grants]).map((g) => g.id)).toEqual(['grnt_root', 'grnt_leaf']);
    expect(() => selectGrantChain([])).toThrowError(expect.objectContaining({ code: 'EVIDENCE_INCOMPLETE' }) as Error);
  });

  it('orders records by time after the grant chain and keeps audit order for ties', () => {
    const now = new Date('2026-09-14T11:00:00.000Z');
    const records = [
      { record: { type: 'tool_call', at: '2026-09-14T09:05:02.000Z', data: { call_id: 'b' } }, order: 1 },
      { record: { type: 'tool_call', at: '2026-09-14T09:05:01.000Z', data: { call_id: 'a' } }, order: 0 },
      { record: { type: 'tool_call', at: '2026-09-14T09:05:02.000Z', data: { call_id: 'c' } }, order: 2 },
    ];
    const { entries, caseMember } = assembleRecords({ developerId: 'dev_x', caseId: CASE, issuer: 'https://auth.example.com', exportedAt: now, records, chain: grants });
    expect(entries.map((e) => e['data']['call_id'] ?? e['data']['grant_id'])).toEqual(['grnt_root', 'grnt_leaf', 'a', 'b', 'c', 'grnt_leaf']);
    expect(caseMember['state']).toBe('open');
  });
});
