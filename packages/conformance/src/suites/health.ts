import type { SuiteDefinition, SuiteContext, TestResult } from '../types.js';
import { test, expectStatus, expectKeys, expectString } from '../helpers.js';

export const healthSuite: SuiteDefinition = {
  name: 'health',
  description: 'Health check and JWKS endpoints',
  optional: false,
  run: async (ctx: SuiteContext): Promise<TestResult[]> => {
    const results: TestResult[] = [];

    results.push(
      await test('GET /health returns 200 with status ok', '§3.3', async () => {
        const res = await ctx.http.requestPublic<{ status: string }>('GET', '/health');
        expectStatus(res, 200);
        expectKeys(res.body, ['status']);
        expectString(res.body.status, 'status');
      }),
    );

    results.push(
      await test('JWKS endpoint has RS256 keys', '§10', async () => {
        const res = await ctx.http.requestPublic<{ keys: Array<{ kty: string; alg?: string }> }>(
          'GET',
          '/.well-known/jwks.json',
        );
        expectStatus(res, 200);
        expectKeys(res.body, ['keys']);
        const keys = res.body.keys;
        if (!Array.isArray(keys) || keys.length === 0) {
          throw new Error('JWKS must contain at least one key');
        }
        const rsaKeys = keys.filter((k) => k.kty === 'RSA');
        if (rsaKeys.length === 0) {
          throw new Error('JWKS must contain at least one RSA key');
        }
      }),
    );

    return results;
  },
};
