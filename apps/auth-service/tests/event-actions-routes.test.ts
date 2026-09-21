import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, authHeader, sqlMock, TEST_DEVELOPER } from './helpers.js';

let app: FastifyInstance;

const RULE_ROW = {
  id: 'evmap_01K5CCCCCCCCCCCCCCCCCCCCCC',
  developer_id: TEST_DEVELOPER.id,
  name: 'dissolution revokes',
  source_id: null,
  event_type: 'business.dissolved',
  conditions: [],
  target: { by: 'subject_ref', path: 'subject.business_ref', kind: 'business_ref' },
  action: 'revoke',
  mode: 'enforce',
  status: 'active',
  created_at: new Date(),
  updated_at: new Date(),
};

const VALID_RULE = {
  name: 'dissolution revokes',
  eventType: 'business.dissolved',
  target: { by: 'subject_ref', path: 'subject.business_ref', kind: 'business_ref' },
  action: 'revoke',
};

interface SqlState {
  statements: string[];
  handlers: Array<[RegExp, unknown[]]>;
}

let state: SqlState;

function installSql(): void {
  sqlMock.mockImplementation(async (strings: TemplateStringsArray | string) => {
    const text = Array.isArray(strings) ? strings.join('?') : String(strings);
    state.statements.push(text.replace(/\s+/g, ' ').trim());
    if (text.includes('FROM developers d')) return [TEST_DEVELOPER];
    for (const [pattern, rows] of state.handlers) {
      if (pattern.test(text)) return rows;
    }
    return [];
  });
}

beforeAll(async () => {
  app = await buildTestApp();
});

beforeEach(() => {
  state = { statements: [], handlers: [] };
  installSql();
  vi.stubEnv('EVENT_BRIDGE_ENABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('mapping rule routes', () => {
  it('are hidden behind the event bridge flag', async () => {
    vi.stubEnv('EVENT_BRIDGE_ENABLED', 'false');
    for (const [method, url] of [['GET', '/v1/event-mapping-rules'], ['POST', '/v1/event-mapping-rules'],
      ['GET', '/v1/grants/grnt_1/subject-refs'], ['PUT', '/v1/grants/grnt_1/subject-refs']] as const) {
      const res = await app.inject({ method, url, headers: authHeader(), ...(method === 'GET' ? {} : { payload: {} }) });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'FEATURE_DISABLED' });
    }
  });

  it('creates a rule and returns it without developer internals', async () => {
    state.handlers.push([/INSERT INTO event_mapping_rules/, [RULE_ROW]]);
    const res = await app.inject({ method: 'POST', url: '/v1/event-mapping-rules', headers: authHeader(), payload: VALID_RULE });
    expect(res.statusCode).toBe(201);
    const body = res.json<Record<string, unknown>>();
    expect(body).toMatchObject({ id: RULE_ROW.id, action: 'revoke', mode: 'enforce', status: 'active', sourceId: null });
    expect(body).not.toHaveProperty('developer_id');
  });

  it('refuses a rule whose source belongs to another developer', async () => {
    // The ownership query returns nothing for this developer.
    const res = await app.inject({
      method: 'POST', url: '/v1/event-mapping-rules', headers: authHeader(),
      payload: { ...VALID_RULE, sourceId: 'evsrc_01K5SOMEONEELSESSOURCEXXXX' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ fields: { sourceId: expect.stringContaining('no such event source') } });
    expect(state.statements.some((s) => s.includes('INSERT INTO event_mapping_rules'))).toBe(false);
  });

  it('refuses an invalid rule with the offending field', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/event-mapping-rules', headers: authHeader(),
      payload: { ...VALID_RULE, action: 'delete' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ fields: Record<string, string> }>().fields).toHaveProperty('action');
  });

  it('answers 404 for a rule of another developer', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/event-mapping-rules/evmap_01K5OTHER', headers: authHeader() });
    expect(res.statusCode).toBe(404);
  });
});

describe('grant subject bindings', () => {
  it('replaces the bindings of a grant this developer owns', async () => {
    state.handlers.push([/SELECT id FROM grants\s+WHERE id =/, [{ id: 'grnt_1' }]]);
    const res = await app.inject({
      method: 'PUT', url: '/v1/grants/grnt_1/subject-refs', headers: authHeader(),
      payload: { refs: [{ kind: 'business_ref', value: 'gb:00000001' }, { kind: 'case_id', value: 'case_0001' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ grantId: 'grnt_1', refs: [{ kind: 'business_ref' }, { kind: 'case_id' }] });
    expect(state.statements.some((s) => s.includes('DELETE FROM grant_subject_refs'))).toBe(true);
    // The grant is held while the bindings are written.
    expect(state.statements.some((s) => s.includes('FOR UPDATE'))).toBe(true);
  });

  it('answers 404 for a grant of another developer, without writing a binding', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/v1/grants/grnt_theirs/subject-refs', headers: authHeader(),
      payload: { refs: [{ kind: 'business_ref', value: 'gb:00000001' }] },
    });
    expect(res.statusCode).toBe(404);
    expect(state.statements.some((s) => s.includes('INSERT INTO grant_subject_refs'))).toBe(false);
  });

  it('refuses malformed bindings', async () => {
    state.handlers.push([/SELECT id FROM grants\s+WHERE id =/, [{ id: 'grnt_1' }]]);
    for (const payload of [
      { refs: 'business_ref' },
      { refs: [{ kind: 'Business Ref', value: 'gb:00000001' }] },
      { refs: [{ kind: 'business_ref', value: '' }] },
      { refs: Array.from({ length: 51 }, () => ({ kind: 'business_ref', value: 'gb:00000001' })) },
    ]) {
      const res = await app.inject({ method: 'PUT', url: '/v1/grants/grnt_1/subject-refs', headers: authHeader(), payload });
      expect(res.statusCode).toBe(422);
    }
  });
});

describe('POST /v1/grants/:id/resume', () => {
  it('answers 404 when the grant is not the root of a suspension', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/grants/grnt_1/resume', headers: authHeader() });
    expect(res.statusCode).toBe(404);
  });

  it('answers 409 while an ancestor is revoked or suspended', async () => {
    state.handlers.push([/AND s\.root_grant_id =/, [{ id: 'grnt_child', parent_grant_id: 'grnt_parent' }]]);
    state.handlers.push([/WITH RECURSIVE chain/, [{ status: 'revoked' }]]);
    const res = await app.inject({ method: 'POST', url: '/v1/grants/grnt_child/resume', headers: authHeader() });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'ANCESTOR_INACTIVE' });
  });

  it('resumes the suspended subtree and reports the grants restored', async () => {
    state.handlers.push([/AND s\.root_grant_id =/, [{ id: 'grnt_root', parent_grant_id: null }]]);
    state.handlers.push([/UPDATE grants g SET status = 'active'/, [
      { id: 'grnt_root', agent_id: 'ag_1', agent_did: 'did:grantex:ag_1', principal_id: 'user_1', expires_at: new Date() },
      { id: 'grnt_child', agent_id: 'ag_1', agent_did: 'did:grantex:ag_1', principal_id: 'user_1', expires_at: new Date() },
    ]]);
    const res = await app.inject({ method: 'POST', url: '/v1/grants/grnt_root/resume', headers: authHeader() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ grantId: 'grnt_root', resumedGrantIds: ['grnt_root', 'grnt_child'] });
    expect(state.statements.some((s) => s.includes('INSERT INTO audit_entries'))).toBe(true);
  });

  it('stays available when the event bridge flag is off, so a suspension can always be undone', async () => {
    vi.stubEnv('EVENT_BRIDGE_ENABLED', 'false');
    const res = await app.inject({ method: 'POST', url: '/v1/grants/grnt_1/resume', headers: authHeader() });
    expect(res.statusCode).toBe(404);
    expect(res.json()).not.toMatchObject({ code: 'FEATURE_DISABLED' });
  });
});
