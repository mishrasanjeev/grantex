import type { SuiteDefinition, SuiteContext, TestResult } from '../types.js';
import { test, expectStatus, expectString, expectArray, expectIsoDate } from '../helpers.js';

export const tokenSuite: SuiteDefinition = {
  name: 'token',
  description: 'Token exchange (code → grant token)',
  optional: false,
  run: async (ctx: SuiteContext): Promise<TestResult[]> => {
    const results: TestResult[] = [];
    const { agentId, agentDid } = ctx.sharedAgent;

    results.push(
      await test(
        'POST /v1/token exchanges code for grantToken, refreshToken, grantId, scopes, expiresAt',
        '§5.3',
        async () => {
          const flow = await ctx.flow.executeFullFlow({
            agentId,
            agentDid,
            scopes: ['read', 'write'],
          });
          expectString(flow.grantToken, 'grantToken');
          expectString(flow.refreshToken, 'refreshToken');
          expectString(flow.grantId, 'grantId');
          expectArray(flow.scopes, 'scopes');
          expectIsoDate(flow.expiresAt, 'expiresAt');
        },
      ),
    );

    results.push(
      await test('POST /v1/token rejects invalid code (400)', '§5.3', async () => {
        const res = await ctx.http.post('/v1/token', {
          code: 'invalid-code-12345',
          agentId,
        });
        expectStatus(res, 400);
      }),
    );

    results.push(
      await test('POST /v1/token rejects reused code (400)', '§5.3', async () => {
        // Authorize to get a code
        const authRes = await ctx.http.post<{
          authRequestId: string;
          code?: string;
        }>('/v1/authorize', {
          agentId,
          principalId: `principal-reuse-${Date.now()}`,
          scopes: ['read'],
        });
        expectStatus(authRes, 201);

        let code: string;
        if (authRes.body.code) {
          code = authRes.body.code;
        } else {
          const consentRes = await ctx.http.requestPublic<{ code: string }>(
            'POST',
            `/v1/consent/${authRes.body.authRequestId}/approve`,
          );
          code = consentRes.body.code;
        }

        // First exchange — should succeed
        const first = await ctx.http.post<{ grantId: string }>('/v1/token', {
          code,
          agentId,
        });
        expectStatus(first, 201);
        ctx.cleanup.trackGrant(first.body.grantId);

        // Second exchange with same code — should fail
        const second = await ctx.http.post('/v1/token', {
          code,
          agentId,
        });
        expectStatus(second, 400);
      }),
    );

    // ─── Token Refresh ─────────────────────────────────────────────────

    results.push(
      await test(
        'POST /v1/token/refresh exchanges refresh token for new grant token',
        '§7.4',
        async () => {
          // First, execute a full flow to get a refresh token
          const flow = await ctx.flow.executeFullFlow({
            agentId,
            agentDid,
            scopes: ['read', 'write'],
          });
          expectString(flow.refreshToken, 'refreshToken');

          // Now refresh
          const refreshRes = await ctx.http.post<{
            grantToken: string;
            refreshToken: string;
            grantId: string;
            scopes: string[];
            expiresAt: string;
          }>('/v1/token/refresh', {
            refreshToken: flow.refreshToken,
            agentId,
          });
          expectStatus(refreshRes, 201);
          expectString(refreshRes.body.grantToken, 'grantToken');
          expectString(refreshRes.body.refreshToken, 'refreshToken');
          expectString(refreshRes.body.grantId, 'grantId');
          expectArray(refreshRes.body.scopes, 'scopes');
          expectIsoDate(refreshRes.body.expiresAt, 'expiresAt');

          // Same grantId
          if (refreshRes.body.grantId !== flow.grantId) {
            throw new Error(
              `Expected same grantId after refresh: got ${refreshRes.body.grantId}, expected ${flow.grantId}`,
            );
          }
          // Rotated refresh token
          if (refreshRes.body.refreshToken === flow.refreshToken) {
            throw new Error('Expected rotated refresh token, but got the same one');
          }

          ctx.cleanup.trackGrant(refreshRes.body.grantId);
        },
      ),
    );

    results.push(
      await test(
        'POST /v1/token/refresh rejects used refresh token (400)',
        '§7.4',
        async () => {
          const flow = await ctx.flow.executeFullFlow({
            agentId,
            agentDid,
            scopes: ['read'],
          });

          // First refresh — should succeed
          const first = await ctx.http.post<{ grantId: string }>('/v1/token/refresh', {
            refreshToken: flow.refreshToken,
            agentId,
          });
          expectStatus(first, 201);
          ctx.cleanup.trackGrant(first.body.grantId);

          // Second refresh with same (now used) token — should fail
          const second = await ctx.http.post('/v1/token/refresh', {
            refreshToken: flow.refreshToken,
            agentId,
          });
          expectStatus(second, 400);
        },
      ),
    );

    return results;
  },
};
