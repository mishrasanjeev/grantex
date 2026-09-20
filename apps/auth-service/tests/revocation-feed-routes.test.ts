import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, authHeader, sqlMock, TEST_DEVELOPER } from './helpers.js';
import { resetFeedReadyCache } from '../src/lib/revocation-feed/store.js';

let app: FastifyInstance;

interface SqlState {
  statements: string[];
  triggers: boolean;
  handlers: Array<[RegExp, unknown[]]>;
}

let state: SqlState;

function installSql(): void {
  sqlMock.mockImplementation(async (strings: TemplateStringsArray | string) => {
    const text = Array.isArray(strings) ? strings.join('?') : String(strings);
    state.statements.push(text.replace(/\s+/g, ' ').trim());
    if (text.includes('FROM developers d')) return [TEST_DEVELOPER];
    if (text.includes('FROM pg_trigger')) return [{ present: state.triggers }];
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
  state = { statements: [], triggers: true, handlers: [] };
  installSql();
  resetFeedReadyCache();
  vi.stubEnv('REVOCATION_FEED_ENABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the revocation feed flag', () => {
  it('hides every feed route unless REVOCATION_FEED_ENABLED is true', async () => {
    vi.stubEnv('REVOCATION_FEED_ENABLED', 'false');
    for (const url of ['/v1/revocations', '/v1/revocations/status?grantId=grnt_1', '/v1/revocations/stream']) {
      const res = await app.inject({ method: 'GET', url, headers: authHeader() });
      expect(res.statusCode).toBe(404);
    }
  });

  it('hides the feed from a developer outside REVOCATION_FEED_DEVELOPER_IDS', async () => {
    vi.stubEnv('REVOCATION_FEED_DEVELOPER_IDS', 'dev_SOMEONE_ELSE');
    const res = await app.inject({ method: 'GET', url: '/v1/revocations', headers: authHeader() });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /v1/revocations', () => {
  it('answers 503 rather than an empty feed when the triggers that fill it are missing', async () => {
    state.triggers = false;
    const res = await app.inject({ method: 'GET', url: '/v1/revocations', headers: authHeader() });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'FEED_UNAVAILABLE' });
  });

  it('returns a snapshot with the cursor to stream from, read before the page', async () => {
    state.handlers.push([/SELECT MAX\(seq\)/, [{ cursor: '41' }]]);
    state.handlers.push([/FROM grants\s+WHERE developer_id/, [
      { id: 'grnt_1', status: 'revoked', expires_at: new Date(Date.now() + 3_600_000), changed_at: new Date() },
      { id: 'grnt_2', status: 'suspended', expires_at: new Date(Date.now() + 3_600_000), changed_at: new Date() },
    ]]);
    const res = await app.inject({ method: 'GET', url: '/v1/revocations', headers: authHeader() });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ entries: Array<{ grantId: string; action: string }>; cursor: number; snapshot: boolean }>();
    expect(body.snapshot).toBe(true);
    expect(body.cursor).toBe(41);
    expect(body.entries.map((entry) => [entry.grantId, entry.action]))
      .toEqual([['grnt_1', 'revoked'], ['grnt_2', 'suspended']]);
    const cursorIndex = state.statements.findIndex((s) => s.includes('MAX(seq)'));
    const pageIndex = state.statements.findIndex((s) => s.includes('FROM grants WHERE developer_id'));
    expect(cursorIndex).toBeLessThan(pageIndex);
  });

  it('returns changes after a cursor, and 304 when nothing has changed', async () => {
    state.handlers.push([/SELECT MAX\(seq\)/, [{ cursor: '7' }]]);
    const empty = await app.inject({ method: 'GET', url: '/v1/revocations?since=7', headers: authHeader() });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({ entries: [], cursor: 7, snapshot: false });
    expect(empty.headers['cache-control']).toBe('private, max-age=1');
    const etag = empty.headers['etag'] as string;
    expect(etag).toBeDefined();

    const again = await app.inject({
      method: 'GET', url: '/v1/revocations?since=7', headers: { ...authHeader(), 'if-none-match': etag },
    });
    expect(again.statusCode).toBe(304);

    state.handlers.push([/FROM grant_revocation_events\s+WHERE developer_id = \? AND seq > \?/, [
      { seq: '8', developer_id: TEST_DEVELOPER.id, grant_id: 'grnt_9', jti: null, action: 'revoked', expires_at: new Date(), created_at: new Date() },
    ]]);
    const fresh = await app.inject({
      method: 'GET', url: '/v1/revocations?since=7', headers: { ...authHeader(), 'if-none-match': etag },
    });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json<{ entries: Array<{ grantId: string }> }>().entries[0]!.grantId).toBe('grnt_9');
  });

  it('refuses a malformed cursor, limit or wait', async () => {
    for (const query of ['since=-1', 'since=abc', 'limit=0', 'limit=100000', 'wait=99', 'since=1&wait=x']) {
      const res = await app.inject({ method: 'GET', url: `/v1/revocations?${query}`, headers: authHeader() });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('GET /v1/revocations/status', () => {
  it('reports an active grant, and fails closed for one this developer does not have', async () => {
    state.handlers.push([/SELECT id, status, expires_at FROM grants/, [
      { id: 'grnt_1', status: 'active', expires_at: new Date(Date.now() + 3_600_000) },
    ]]);
    const active = await app.inject({ method: 'GET', url: '/v1/revocations/status?grantId=grnt_1', headers: authHeader() });
    expect(active.json()).toMatchObject({ status: 'active', revoked: false, grantId: 'grnt_1' });

    state.handlers = [];
    const unknown = await app.inject({ method: 'GET', url: '/v1/revocations/status?grantId=grnt_theirs', headers: authHeader() });
    expect(unknown.json()).toMatchObject({ status: 'unknown', revoked: true });
  });

  it('reports a revoked grant, a suspended grant and an expired one as not usable', async () => {
    const cases: Array<[string, string]> = [['revoked', 'revoked'], ['suspended', 'suspended']];
    for (const [status, expected] of cases) {
      state.handlers = [[/SELECT id, status, expires_at FROM grants/, [
        { id: 'grnt_1', status, expires_at: new Date(Date.now() + 3_600_000) },
      ]]];
      const res = await app.inject({ method: 'GET', url: '/v1/revocations/status?grantId=grnt_1', headers: authHeader() });
      expect(res.json()).toMatchObject({ status: expected, revoked: true });
    }
    state.handlers = [[/SELECT id, status, expires_at FROM grants/, [
      { id: 'grnt_1', status: 'active', expires_at: new Date(Date.now() - 1_000) },
    ]]];
    const expired = await app.inject({ method: 'GET', url: '/v1/revocations/status?grantId=grnt_1', headers: authHeader() });
    expect(expired.json()).toMatchObject({ status: 'expired', revoked: true });
  });

  it('checks a token by jti, including one revoked on its own', async () => {
    state.handlers.push([/FROM grant_tokens gt JOIN grants g/, [
      { grant_id: 'grnt_1', status: 'active', token_revoked: true, expires_at: new Date(Date.now() + 3_600_000) },
    ]]);
    const res = await app.inject({ method: 'GET', url: '/v1/revocations/status?jti=tok_1', headers: authHeader() });
    expect(res.json()).toMatchObject({ status: 'revoked', revoked: true, grantId: 'grnt_1', jti: 'tok_1' });
  });

  it('requires an identifier and answers 304 for an unchanged status', async () => {
    const missing = await app.inject({ method: 'GET', url: '/v1/revocations/status', headers: authHeader() });
    expect(missing.statusCode).toBe(400);

    state.handlers.push([/SELECT id, status, expires_at FROM grants/, [
      { id: 'grnt_1', status: 'active', expires_at: new Date('2026-12-01T00:00:00Z') },
    ]]);
    const first = await app.inject({ method: 'GET', url: '/v1/revocations/status?grantId=grnt_1', headers: authHeader() });
    const etag = first.headers['etag'] as string;
    const second = await app.inject({
      method: 'GET', url: '/v1/revocations/status?grantId=grnt_1', headers: { ...authHeader(), 'if-none-match': etag },
    });
    expect(second.statusCode).toBe(304);
  });
});
