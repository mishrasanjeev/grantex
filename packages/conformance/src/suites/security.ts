import type { SuiteDefinition, SuiteContext, TestResult } from '../types.js';
import { test, expectStatus, expectEqual } from '../helpers.js';

export const securitySuite: SuiteDefinition = {
  name: 'security',
  description: 'Authentication, authorization, and security enforcement',
  optional: false,
  run: async (ctx: SuiteContext): Promise<TestResult[]> => {
    const results: TestResult[] = [];

    results.push(
      await test('Request without auth returns 401', '§14', async () => {
        const res = await ctx.http.requestPublic('GET', '/v1/agents');
        expectStatus(res, 401);
      }),
    );

    results.push(
      await test('Request with bad auth returns 401', '§14', async () => {
        const badHttp = await import('../http-client.js');
        const client = new badHttp.ConformanceHttpClient(ctx.baseUrl, 'invalid-api-key-12345');
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

    results.push(
      await test('Delegation scope enforcement prevents escalation', '§14', async () => {
        const flow = await ctx.flow.executeFullFlow({
          agentName: `conformance-sec-scope-${Date.now()}`,
          scopes: ['read'],
        });

        const subAgentRes = await ctx.http.post<{ agentId: string }>('/v1/agents', {
          name: `conformance-sec-sub-${Date.now()}`,
          scopes: ['read', 'write', 'admin'],
        });
        expectStatus(subAgentRes, 201);
        ctx.cleanup.trackAgent(subAgentRes.body.agentId);

        // Try to delegate with more scopes than parent has
        const delRes = await ctx.http.post('/v1/grants/delegate', {
          parentGrantToken: flow.grantToken,
          subAgentId: subAgentRes.body.agentId,
          scopes: ['read', 'write'],
        });
        expectStatus(delRes, 400);
      }),
    );

    results.push(
      await test('Audit log is append-only (PUT/DELETE return 404 or 405)', '§14', async () => {
        const flow = await ctx.flow.executeFullFlow({
          agentName: `conformance-sec-audit-${Date.now()}`,
          scopes: ['read'],
        });

        // Create an audit entry
        const logRes = await ctx.http.post<{ entryId: string }>('/v1/audit/log', {
          agentId: flow.agentId,
          agentDid: flow.agentDid,
          grantId: flow.grantId,
          principalId: flow.principalId,
          action: 'conformance.security.test',
        });
        expectStatus(logRes, 201);

        // Try PUT on audit entry — should fail
        const putRes = await ctx.http.request('PUT', `/v1/audit/${logRes.body.entryId}`, {
          action: 'modified',
        });
        if (putRes.status !== 404 && putRes.status !== 405) {
          throw new Error(
            `Expected 404 or 405 for PUT /v1/audit/:id, got ${putRes.status}`,
          );
        }

        // Try DELETE on audit entry — should fail
        const delRes = await ctx.http.delete(`/v1/audit/${logRes.body.entryId}`);
        if (delRes.status !== 404 && delRes.status !== 405) {
          throw new Error(
            `Expected 404 or 405 for DELETE /v1/audit/:id, got ${delRes.status}`,
          );
        }
      }),
    );

    return results;
  },
};
