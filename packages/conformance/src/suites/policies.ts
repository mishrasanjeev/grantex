import type { SuiteDefinition, SuiteContext, TestResult } from '../types.js';
import { test, expectStatus, expectKeys, expectString, expectArray, expectEqual } from '../helpers.js';

export const policiesSuite: SuiteDefinition = {
  name: 'policies',
  description: 'Policy CRUD and enforcement',
  optional: true,
  run: async (ctx: SuiteContext): Promise<TestResult[]> => {
    const results: TestResult[] = [];
    let policyId = '';

    results.push(
      await test('POST /v1/policies creates policy (201)', '§12', async () => {
        const res = await ctx.http.post<{
          id: string;
          name: string;
          effect: string;
        }>('/v1/policies', {
          name: `conformance-policy-${Date.now()}`,
          effect: 'allow',
          scopes: ['read'],
        });
        expectStatus(res, 201);
        expectKeys(res.body, ['id', 'name', 'effect']);
        expectString(res.body.id, 'id');
        policyId = res.body.id;
        ctx.cleanup.trackPolicy(policyId);
      }),
    );

    results.push(
      await test('GET /v1/policies lists policies', '§12', async () => {
        const res = await ctx.http.get<{ policies: unknown[] }>('/v1/policies');
        expectStatus(res, 200);
        expectKeys(res.body, ['policies']);
        expectArray(res.body.policies, 'policies');
      }),
    );

    results.push(
      await test('GET /v1/policies/:id returns policy details', '§12', async () => {
        if (!policyId) throw new Error('No policy created');
        const res = await ctx.http.get<{ id: string; effect: string }>(
          `/v1/policies/${policyId}`,
        );
        expectStatus(res, 200);
        expectKeys(res.body, ['id', 'name', 'effect']);
        expectEqual(res.body.id, policyId, 'id');
      }),
    );

    results.push(
      await test('PATCH /v1/policies/:id updates policy', '§12', async () => {
        if (!policyId) throw new Error('No policy created');
        const res = await ctx.http.patch<{ id: string; effect: string }>(
          `/v1/policies/${policyId}`,
          { effect: 'deny' },
        );
        expectStatus(res, 200);
        expectEqual(res.body.effect, 'deny', 'effect');
      }),
    );

    results.push(
      await test('DELETE /v1/policies/:id returns 204', '§12', async () => {
        if (!policyId) throw new Error('No policy created');
        const res = await ctx.http.delete(`/v1/policies/${policyId}`);
        expectStatus(res, 204);
      }),
    );

    return results;
  },
};
