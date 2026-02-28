import type { SuiteDefinition, SuiteContext, TestResult } from '../types.js';
import { test, expectStatus, expectKeys, expectString, expectArray, expectIsoDate } from '../helpers.js';

export const tokenSuite: SuiteDefinition = {
  name: 'token',
  description: 'Token exchange (code → grant token)',
  optional: false,
  run: async (ctx: SuiteContext): Promise<TestResult[]> => {
    const results: TestResult[] = [];

    results.push(
      await test(
        'POST /v1/token exchanges code for grantToken, refreshToken, grantId, scopes, expiresAt',
        '§5.3',
        async () => {
          const flow = await ctx.flow.executeFullFlow();
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
        // Create agent first
        const agentRes = await ctx.http.post<{ agentId: string }>('/v1/agents', {
          name: `conformance-bad-code-${Date.now()}`,
          scopes: ['read'],
        });
        expectStatus(agentRes, 201);
        ctx.cleanup.trackAgent(agentRes.body.agentId);

        const res = await ctx.http.post('/v1/token', {
          code: 'invalid-code-12345',
          agentId: agentRes.body.agentId,
        });
        expectStatus(res, 400);
      }),
    );

    results.push(
      await test('POST /v1/token rejects reused code (400)', '§5.3', async () => {
        // Execute a full flow to get a valid code
        const agentRes = await ctx.http.post<{ agentId: string }>('/v1/agents', {
          name: `conformance-reuse-${Date.now()}`,
          scopes: ['read'],
        });
        expectStatus(agentRes, 201);
        ctx.cleanup.trackAgent(agentRes.body.agentId);

        const authRes = await ctx.http.post<{
          authRequestId: string;
          code?: string;
        }>('/v1/authorize', {
          agentId: agentRes.body.agentId,
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
          agentId: agentRes.body.agentId,
        });
        expectStatus(first, 201);
        ctx.cleanup.trackGrant(first.body.grantId);

        // Second exchange with same code — should fail
        const second = await ctx.http.post('/v1/token', {
          code,
          agentId: agentRes.body.agentId,
        });
        expectStatus(second, 400);
      }),
    );

    return results;
  },
};
