import type { SuiteDefinition, SuiteContext, TestResult } from '../types.js';
import { test, expectStatus, expectKeys, expectArray } from '../helpers.js';

export const complianceSuite: SuiteDefinition = {
  name: 'compliance',
  description: 'Compliance reporting and evidence export',
  optional: true,
  run: async (ctx: SuiteContext): Promise<TestResult[]> => {
    const results: TestResult[] = [];

    results.push(
      await test('GET /v1/compliance/summary returns summary', '§12', async () => {
        const res = await ctx.http.get<{
          generatedAt: string;
          agents: Record<string, number>;
          grants: Record<string, number>;
        }>('/v1/compliance/summary');
        expectStatus(res, 200);
        expectKeys(res.body, ['generatedAt', 'agents', 'grants', 'auditEntries', 'policies']);
      }),
    );

    results.push(
      await test('GET /v1/compliance/export/grants returns grants export', '§12', async () => {
        const res = await ctx.http.get<{
          generatedAt: string;
          total: number;
          grants: unknown[];
        }>('/v1/compliance/export/grants');
        expectStatus(res, 200);
        expectKeys(res.body, ['generatedAt', 'total', 'grants']);
        expectArray(res.body.grants, 'grants');
      }),
    );

    results.push(
      await test('GET /v1/compliance/export/audit returns audit export', '§12', async () => {
        const res = await ctx.http.get<{
          generatedAt: string;
          total: number;
          entries: unknown[];
        }>('/v1/compliance/export/audit');
        expectStatus(res, 200);
        expectKeys(res.body, ['generatedAt', 'total', 'entries']);
        expectArray(res.body.entries, 'entries');
      }),
    );

    results.push(
      await test('GET /v1/compliance/evidence-pack returns evidence pack', '§12', async () => {
        const res = await ctx.http.get<{
          meta: Record<string, unknown>;
          summary: Record<string, unknown>;
        }>('/v1/compliance/evidence-pack');
        expectStatus(res, 200);
        expectKeys(res.body, ['meta', 'summary', 'grants', 'auditEntries', 'policies', 'chainIntegrity']);
      }),
    );

    return results;
  },
};
