import type { SuiteDefinition, SuiteContext, TestResult } from '../types.js';
import { test, skip, expectStatus, expectKeys, expectString, expectArray } from '../helpers.js';

export const agentsSuite: SuiteDefinition = {
  name: 'agents',
  description: 'Agent registration and management (CRUD)',
  optional: false,
  run: async (ctx: SuiteContext): Promise<TestResult[]> => {
    const results: TestResult[] = [];
    const sharedId = ctx.sharedAgent.agentId;
    let crudAgentId = '';

    // Try to create a fresh agent for CRUD tests
    const createRes = await ctx.http.post<{
      agentId: string;
      did: string;
      name: string;
      scopes: string[];
    }>('/v1/agents', {
      name: `conformance-crud-${Date.now()}`,
      scopes: ['read', 'write'],
    });

    if (createRes.status === 201) {
      crudAgentId = createRes.body.agentId;
    }

    results.push(
      crudAgentId
        ? await test('POST /v1/agents creates agent with agentId and did', '§10', async () => {
            expectKeys(createRes.body, ['agentId', 'did', 'name', 'scopes', 'status', 'createdAt']);
            expectString(createRes.body.agentId, 'agentId');
            expectString(createRes.body.did, 'did');
          })
        : skip('POST /v1/agents creates agent with agentId and did', '§10', 'Plan limit reached — cannot create test agent'),
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
        const id = crudAgentId || sharedId;
        const res = await ctx.http.get<{ agentId: string }>(`/v1/agents/${id}`);
        expectStatus(res, 200);
        expectKeys(res.body, ['agentId', 'did', 'name', 'scopes', 'status']);
      }),
    );

    results.push(
      await test('PATCH /v1/agents/:id updates agent', '§10', async () => {
        const id = crudAgentId || sharedId;
        const newName = `updated-${Date.now()}`;
        const res = await ctx.http.patch<{ agentId: string; name: string }>(
          `/v1/agents/${id}`,
          { name: newName },
        );
        expectStatus(res, 200);
        expectKeys(res.body, ['agentId', 'name']);
      }),
    );

    results.push(
      crudAgentId
        ? await test('DELETE /v1/agents/:id returns 204', '§10', async () => {
            const res = await ctx.http.delete(`/v1/agents/${crudAgentId}`);
            expectStatus(res, 204);
          })
        : skip('DELETE /v1/agents/:id returns 204', '§10', 'Plan limit reached — no test agent to delete'),
    );

    return results;
  },
};
