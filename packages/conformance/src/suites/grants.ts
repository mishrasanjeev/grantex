import type { SuiteDefinition, SuiteContext, TestResult } from '../types.js';
import { test, expectStatus, expectKeys, expectArray, expectEqual } from '../helpers.js';

export const grantsSuite: SuiteDefinition = {
  name: 'grants',
  description: 'Grant listing, retrieval, and revocation',
  optional: false,
  run: async (ctx: SuiteContext): Promise<TestResult[]> => {
    const results: TestResult[] = [];
    const { agentId, agentDid } = ctx.sharedAgent;

    const flow = await ctx.flow.executeFullFlow({ agentId, agentDid });

    results.push(
      await test('GET /v1/grants lists grants', '§7.1', async () => {
        const res = await ctx.http.get<{ grants: unknown[] }>('/v1/grants');
        expectStatus(res, 200);
        expectKeys(res.body, ['grants']);
        expectArray(res.body.grants, 'grants');
      }),
    );

    results.push(
      await test('GET /v1/grants/:id returns grant details', '§7.1', async () => {
        const res = await ctx.http.get<{
          grantId: string;
          agentId: string;
          scopes: string[];
          status: string;
        }>(`/v1/grants/${flow.grantId}`);
        expectStatus(res, 200);
        expectKeys(res.body, ['grantId', 'agentId', 'scopes', 'status']);
        expectEqual(res.body.grantId, flow.grantId, 'grantId');
      }),
    );

    results.push(
      await test('DELETE /v1/grants/:id returns 204', '§7.1', async () => {
        const res = await ctx.http.delete(`/v1/grants/${flow.grantId}`);
        expectStatus(res, 204);
      }),
    );

    results.push(
      await test('Grant status is revoked after DELETE', '§7.1', async () => {
        const res = await ctx.http.get<{ status: string }>(`/v1/grants/${flow.grantId}`);
        expectStatus(res, 200);
        expectEqual(res.body.status, 'revoked', 'status');
      }),
    );

    return results;
  },
};
