import type { SuiteDefinition, SuiteContext, TestResult } from '../types.js';
import { test, expectStatus, expectKeys, expectArray } from '../helpers.js';

export const anomaliesSuite: SuiteDefinition = {
  name: 'anomalies',
  description: 'Anomaly detection and acknowledgement',
  optional: true,
  run: async (ctx: SuiteContext): Promise<TestResult[]> => {
    const results: TestResult[] = [];

    results.push(
      await test('POST /v1/anomalies/detect runs detection (200)', '§12', async () => {
        const res = await ctx.http.post<{
          detectedAt: string;
          total: number;
          anomalies: unknown[];
        }>('/v1/anomalies/detect');
        expectStatus(res, 200);
        expectKeys(res.body, ['detectedAt', 'total', 'anomalies']);
        expectArray(res.body.anomalies, 'anomalies');
      }),
    );

    results.push(
      await test('GET /v1/anomalies lists anomalies', '§12', async () => {
        const res = await ctx.http.get<{ anomalies: unknown[]; total: number }>('/v1/anomalies');
        expectStatus(res, 200);
        expectKeys(res.body, ['anomalies', 'total']);
        expectArray(res.body.anomalies, 'anomalies');
      }),
    );

    results.push(
      await test('PATCH /v1/anomalies/:id/acknowledge returns 404 for invalid ID', '§12', async () => {
        const res = await ctx.http.patch('/v1/anomalies/nonexistent-id/acknowledge');
        expectStatus(res, 404);
      }),
    );

    return results;
  },
};
