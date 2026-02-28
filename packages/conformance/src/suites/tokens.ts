import type { SuiteDefinition, SuiteContext, TestResult } from '../types.js';
import { test, expectStatus, expectKeys, expectEqual, expectBoolean } from '../helpers.js';

export const tokensSuite: SuiteDefinition = {
  name: 'tokens',
  description: 'Token verification and revocation',
  optional: false,
  run: async (ctx: SuiteContext): Promise<TestResult[]> => {
    const results: TestResult[] = [];
    let grantToken = '';
    let refreshToken = '';

    // Execute full flow to get tokens
    const flow = await ctx.flow.executeFullFlow();
    grantToken = flow.grantToken;
    refreshToken = flow.refreshToken;

    results.push(
      await test('POST /v1/tokens/verify returns valid=true for active token', '§7.2', async () => {
        const res = await ctx.http.post<{
          valid: boolean;
          grantId: string;
          scopes: string[];
          principal: string;
          agent: string;
          expiresAt: string;
        }>('/v1/tokens/verify', { token: grantToken });
        expectStatus(res, 200);
        expectKeys(res.body, ['valid', 'grantId', 'scopes', 'principal', 'agent', 'expiresAt']);
        expectEqual(res.body.valid, true, 'valid');
      }),
    );

    results.push(
      await test('POST /v1/tokens/revoke returns 204', '§7.3', async () => {
        // Decode the JWT to get jti
        const parts = grantToken.split('.');
        const payload = JSON.parse(atob(parts[1]!)) as { jti: string };
        const res = await ctx.http.post('/v1/tokens/revoke', { jti: payload.jti });
        expectStatus(res, 204);
      }),
    );

    results.push(
      await test(
        'POST /v1/tokens/verify returns valid=false after revocation',
        '§7.3',
        async () => {
          const res = await ctx.http.post<{ valid: boolean }>('/v1/tokens/verify', {
            token: grantToken,
          });
          expectStatus(res, 200);
          expectEqual(res.body.valid, false, 'valid');
        },
      ),
    );

    results.push(
      await test('POST /v1/tokens/verify returns valid=false for garbage token', '§7.2', async () => {
        const res = await ctx.http.post<{ valid: boolean }>('/v1/tokens/verify', {
          token: 'not.a.valid.jwt.token',
        });
        expectStatus(res, 200);
        expectBoolean(res.body.valid, 'valid');
        expectEqual(res.body.valid, false, 'valid');
      }),
    );

    return results;
  },
};
