import { describe, it, expect } from 'vitest';
import { setupSharedAgent, SHARED_AGENT_NAME } from '../src/runner.js';
import { CleanupTracker } from '../src/cleanup.js';
import type { ConformanceHttpClient } from '../src/http-client.js';
import type { HttpResponse } from '../src/types.js';

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function response<T>(status: number, body: T): HttpResponse<T> {
  return { status, headers: {}, body, rawText: JSON.stringify(body), durationMs: 0 };
}

/** Minimal stand-in for ConformanceHttpClient that records every call. */
function fakeHttp(route: (call: Call) => HttpResponse<unknown>) {
  const calls: Call[] = [];
  const respond = (method: string, path: string, body?: unknown): Promise<HttpResponse<never>> => {
    const call: Call = { method, path, body };
    calls.push(call);
    return Promise.resolve(route(call) as HttpResponse<never>);
  };
  const http = {
    get: (path: string) => respond('GET', path),
    post: (path: string, body?: unknown) => respond('POST', path, body),
    patch: (path: string, body?: unknown) => respond('PATCH', path, body),
    delete: (path: string) => respond('DELETE', path),
  } as unknown as ConformanceHttpClient;
  return { http, calls };
}

const foreign = { agentId: 'agt_prod', did: 'did:web:x:agents:agt_prod', name: 'production-bot', scopes: ['read', 'write'] };
const ours = { agentId: 'agt_ours', did: 'did:web:x:agents:agt_ours', name: SHARED_AGENT_NAME, scopes: ['read', 'write'] };

describe('setupSharedAgent', () => {
  it('reuses the conformance-owned agent and never touches other agents', async () => {
    const { http, calls } = fakeHttp(({ method, path }) => {
      if (method === 'GET' && path === '/v1/agents') return response(200, { agents: [foreign, ours] });
      throw new Error(`unexpected call ${method} ${path}`);
    });
    const cleanup = new CleanupTracker(http);

    const result = await setupSharedAgent(http, cleanup);

    expect(result.agent?.agentId).toBe('agt_ours');
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);

    await cleanup.teardown();
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
  });

  it('does not adopt a foreign agent even when its scopes match; creates its own and tracks it for cleanup', async () => {
    const { http, calls } = fakeHttp(({ method, path }) => {
      if (method === 'GET' && path === '/v1/agents') return response(200, { agents: [foreign] });
      if (method === 'POST' && path === '/v1/agents') {
        return response(201, { agentId: 'agt_new', did: 'did:web:x:agents:agt_new', name: SHARED_AGENT_NAME });
      }
      if (method === 'DELETE') return response(204, '');
      throw new Error(`unexpected call ${method} ${path}`);
    });
    const cleanup = new CleanupTracker(http);

    const result = await setupSharedAgent(http, cleanup);

    expect(result.agent).toEqual({ agentId: 'agt_new', agentDid: 'did:web:x:agents:agt_new', name: SHARED_AGENT_NAME });
    const created = calls.find((c) => c.method === 'POST');
    expect(created?.body).toEqual({ name: SHARED_AGENT_NAME, scopes: ['read', 'write'] });
    expect(calls.some((c) => c.path === '/v1/agents/agt_prod')).toBe(false);

    await cleanup.teardown();
    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => c.path);
    expect(deletes).toEqual(['/v1/agents/agt_new']);
  });

  it('returns no agent with a skip reason on 402 instead of freeing slots by deleting agents', async () => {
    const { http, calls } = fakeHttp(({ method, path }) => {
      if (method === 'GET' && path === '/v1/agents') return response(200, { agents: [foreign] });
      if (method === 'POST' && path === '/v1/agents') {
        return response(402, { message: 'Plan limit reached', code: 'PLAN_LIMIT_EXCEEDED' });
      }
      throw new Error(`unexpected call ${method} ${path}`);
    });
    const cleanup = new CleanupTracker(http);

    const result = await setupSharedAgent(http, cleanup);

    expect(result.agent).toBeNull();
    expect(result.skipReason).toMatch(/plan limit/i);
    expect(calls.filter((c) => c.method === 'DELETE' || c.method === 'PATCH')).toEqual([]);
  });

  it('only adds missing scopes to its own agent rather than replacing them', async () => {
    const narrowed = { ...ours, scopes: ['read', 'calendar:read'] };
    const { http, calls } = fakeHttp(({ method, path }) => {
      if (method === 'GET' && path === '/v1/agents') return response(200, { agents: [narrowed, foreign] });
      if (method === 'PATCH' && path === '/v1/agents/agt_ours') return response(200, { agentId: 'agt_ours', name: SHARED_AGENT_NAME });
      throw new Error(`unexpected call ${method} ${path}`);
    });

    const result = await setupSharedAgent(http, new CleanupTracker(http));

    expect(result.agent?.agentId).toBe('agt_ours');
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.path).toBe('/v1/agents/agt_ours');
    expect((patch?.body as { scopes: string[] }).scopes.sort()).toEqual(['calendar:read', 'read', 'write']);
    expect(calls.some((c) => c.path.includes('agt_prod'))).toBe(false);
  });
});
