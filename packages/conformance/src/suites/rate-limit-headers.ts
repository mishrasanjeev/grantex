import type { SuiteDefinition, SuiteContext, TestResult } from '../types.js';
import { test, expectStatus, expectNumericHeader } from '../helpers.js';

export const rateLimitHeadersSuite: SuiteDefinition = {
  name: 'rate-limit-headers',
  description: 'Rate limit headers presence and format',
  optional: false,
  run: async (ctx: SuiteContext): Promise<TestResult[]> => {
    const results: TestResult[] = [];

    results.push(
      await test('Rate limit headers on authenticated endpoint', '§14', async () => {
        const res = await ctx.http.get('/v1/agents');
        expectStatus(res, 200);

        expectNumericHeader(res, 'x-ratelimit-limit');
        expectNumericHeader(res, 'x-ratelimit-remaining');
        const reset = expectNumericHeader(res, 'x-ratelimit-reset');

        // Per IETF draft-ietf-httpapi-ratelimit-headers, reset is seconds
        // remaining until the window resets (not a Unix timestamp)
        if (reset < 0 || reset > 3600) {
          throw new Error(
            `Expected x-ratelimit-reset to be seconds remaining (0–3600), got ${reset}`,
          );
        }
      }),
    );

    results.push(
      await test('Rate limit headers on token verify endpoint', '§14', async () => {
        const res = await ctx.http.post('/v1/tokens/verify', {
          token: 'invalid-token-for-header-check',
        });

        expectNumericHeader(res, 'x-ratelimit-limit');
        expectNumericHeader(res, 'x-ratelimit-remaining');
        expectNumericHeader(res, 'x-ratelimit-reset');
      }),
    );

    results.push(
      await test('JWKS endpoint exempt from rate limits', '§14', async () => {
        const res = await ctx.http.requestPublic('GET', '/.well-known/jwks.json');
        expectStatus(res, 200);

        const hasRateLimit = res.headers['x-ratelimit-limit'] !== undefined;
        if (hasRateLimit) {
          throw new Error(
            'Expected JWKS endpoint to be exempt from rate limits, but x-ratelimit-limit header was present',
          );
        }
      }),
    );

    return results;
  },
};
