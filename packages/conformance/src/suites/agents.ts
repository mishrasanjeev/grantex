import type { SuiteDefinition, SuiteContext, TestResult } from '../types.js';
import { test, expectStatus, expectKeys, expectString, expectArray } from '../helpers.js';

export const agentsSuite: SuiteDefinition = {
  name: 'agents',
  description: 'Agent registration and management (CRUD)',
  optional: false,
  run: async (ctx: SuiteContext): Promise<TestResult[]> => {
    const results: TestResult[] = [];
    let agentId = '';

    results.push(
      await test('POST /v1/agents creates agent with agentId and did', '§10', async () => {
        const res = await ctx.http.post<{
          agentId: string;
          did: string;
          name: string;
          scopes: string[];
        }>('/v1/agents', {
          name: `conformance-agent-${Date.now()}`,
          scopes: ['read', 'write'],
        });
        expectStatus(res, 201);
        expectKeys(res.body, ['agentId', 'did', 'name', 'scopes', 'status', 'createdAt']);
        expectString(res.body.agentId, 'agentId');
        expectString(res.body.did, 'did');
        agentId = res.body.agentId;
        ctx.cleanup.trackAgent(agentId);
      }),
    );

    results.push(
      await test('GET /v1/agents lists agents', '§10', async () => {
        const res = await ctx.http.get<{ agents: unknown[] }>('/v1/agents');
        expectStatus(res, 200);
        expectKeys(res.body, ['agents']);
        expectArray(res.body.agents, 'agents');
      }),
    );

    results.push(
      await test('GET /v1/agents/:id returns agent details', '§10', async () => {
        if (!agentId) throw new Error('No agent created in previous test');
        const res = await ctx.http.get<{ agentId: string }>(`/v1/agents/${agentId}`);
        expectStatus(res, 200);
        expectKeys(res.body, ['agentId', 'did', 'name', 'scopes', 'status']);
      }),
    );

    results.push(
      await test('PATCH /v1/agents/:id updates agent', '§10', async () => {
        if (!agentId) throw new Error('No agent created in previous test');
        const res = await ctx.http.patch<{ agentId: string; name: string }>(
          `/v1/agents/${agentId}`,
          { name: `updated-${Date.now()}` },
        );
        expectStatus(res, 200);
        expectKeys(res.body, ['agentId', 'name']);
      }),
    );

    results.push(
      await test('DELETE /v1/agents/:id returns 204', '§10', async () => {
        if (!agentId) throw new Error('No agent created in previous test');
        const res = await ctx.http.delete(`/v1/agents/${agentId}`);
        expectStatus(res, 204);
      }),
    );

    return results;
  },
};
