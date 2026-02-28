import type { SuiteDefinition, SuiteContext, TestResult } from '../types.js';
import { test, expectStatus, expectKeys, expectString, expectIsoDate } from '../helpers.js';

export const authorizeSuite: SuiteDefinition = {
  name: 'authorize',
  description: 'Authorization request creation and consent flow',
  optional: false,
  run: async (ctx: SuiteContext): Promise<TestResult[]> => {
    const results: TestResult[] = [];
    let agentId = '';

    // Create an agent for authorize tests
    const agentRes = await ctx.http.post<{ agentId: string }>('/v1/agents', {
      name: `conformance-auth-${Date.now()}`,
      scopes: ['read', 'write'],
    });
    if (agentRes.status === 201) {
      agentId = agentRes.body.agentId;
      ctx.cleanup.trackAgent(agentId);
    }

    results.push(
      await test(
        'POST /v1/authorize returns authRequestId, consentUrl, expiresAt (201)',
        '§5.1',
        async () => {
          if (!agentId) throw new Error('Agent setup failed');
          const res = await ctx.http.post<{
            authRequestId: string;
            consentUrl: string;
            expiresAt: string;
          }>('/v1/authorize', {
            agentId,
            principalId: `principal-${Date.now()}`,
            scopes: ['read'],
          });
          expectStatus(res, 201);
          expectKeys(res.body, ['authRequestId', 'consentUrl', 'expiresAt']);
          expectString(res.body.authRequestId, 'authRequestId');
          expectString(res.body.consentUrl, 'consentUrl');
          expectIsoDate(res.body.expiresAt, 'expiresAt');
        },
      ),
    );

    results.push(
      await test('POST /v1/authorize rejects missing required fields (400)', '§5.1', async () => {
        const res = await ctx.http.post('/v1/authorize', {});
        expectStatus(res, 400);
      }),
    );

    results.push(
      await test('POST /v1/authorize rejects non-existent agent (404)', '§5.1', async () => {
        const res = await ctx.http.post('/v1/authorize', {
          agentId: 'nonexistent-agent-id',
          principalId: 'principal-test',
          scopes: ['read'],
        });
        expectStatus(res, 404);
      }),
    );

    results.push(
      await test('Consent approval produces authorization code', '§5.2', async () => {
        if (!agentId) throw new Error('Agent setup failed');
        const authRes = await ctx.http.post<{
          authRequestId: string;
          code?: string;
        }>('/v1/authorize', {
          agentId,
          principalId: `principal-consent-${Date.now()}`,
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
          expectStatus(consentRes, 200);
          code = consentRes.body.code;
        }
        expectString(code, 'code');
      }),
    );

    return results;
  },
};
