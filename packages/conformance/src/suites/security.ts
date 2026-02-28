import type { SuiteDefinition, SuiteContext, TestResult } from '../types.js';
import { test, expectStatus } from '../helpers.js';
import { ConformanceHttpClient } from '../http-client.js';

export const securitySuite: SuiteDefinition = {
  name: 'security',
  description: 'Authentication, authorization, and security enforcement',
  optional: false,
  run: async (ctx: SuiteContext): Promise<TestResult[]> => {
    const results: TestResult[] = [];
    const { agentId, agentDid } = ctx.sharedAgent;

    results.push(
      await test('Request without auth returns 401', '§14', async () => {
        const res = await ctx.http.requestPublic('GET', '/v1/agents');
        expectStatus(res, 401);
      }),
    );

    results.push(
      await test('Request with bad auth returns 401', '§14', async () => {
        const client = new ConformanceHttpClient(ctx.baseUrl, 'invalid-api-key-12345');
        const res = await client.get('/v1/agents');
        expectStatus(res, 401);
      }),
    );

    results.push(
      await test('JWKS only contains RS256 keys', '§14', async () => {
        const res = await ctx.http.requestPublic<{
          keys: Array<{ kty: string; alg?: string; use?: string }>;
        }>('GET', '/.well-known/jwks.json');
        expectStatus(res, 200);
        for (const key of res.body.keys) {
          if (key.alg && key.alg !== 'RS256') {
            throw new Error(`Expected RS256 algorithm, found: ${key.alg}`);
          }
          if (key.kty !== 'RSA') {
            throw new Error(`Expected RSA key type, found: ${key.kty}`);
          }
        }
      }),
    );

    // Use shared agent — get a grant with limited scopes
    const flow = await ctx.flow.executeFullFlow({
      agentId,
      agentDid,
      scopes: ['read'],
    });

    results.push(
      await test('Delegation scope enforcement prevents escalation', '§14', async () => {
        // Try to delegate with scopes the parent doesn't have
        const delRes = await ctx.http.post('/v1/grants/delegate', {
          parentGrantToken: flow.grantToken,
          subAgentId: agentId,
          scopes: ['read', 'write'],
        });
        expectStatus(delRes, 400);
      }),
    );

    results.push(
      await test('Audit log is append-only (PUT/DELETE return 404 or 405)', '§14', async () => {
        const logRes = await ctx.http.post<{ entryId: string }>('/v1/audit/log', {
          agentId: flow.agentId,
          agentDid: flow.agentDid,
          grantId: flow.grantId,
          principalId: flow.principalId,
          action: 'conformance.security.test',
        });
        expectStatus(logRes, 201);

        const putRes = await ctx.http.request('PUT', `/v1/audit/${logRes.body.entryId}`, {
          action: 'modified',
        });
        if (putRes.status !== 404 && putRes.status !== 405) {
          throw new Error(
            `Expected 404 or 405 for PUT /v1/audit/:id, got ${putRes.status}`,
          );
        }

        const deleteRes = await ctx.http.delete(`/v1/audit/${logRes.body.entryId}`);
        if (deleteRes.status !== 404 && deleteRes.status !== 405) {
          throw new Error(
            `Expected 404 or 405 for DELETE /v1/audit/:id, got ${deleteRes.status}`,
          );
        }
      }),
    );

    return results;
  },
};
