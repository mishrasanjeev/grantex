import type { SuiteDefinition, SuiteContext, TestResult } from '../types.js';
import { test, expectStatus, expectString } from '../helpers.js';

export const principalSessionsSuite: SuiteDefinition = {
  name: 'principal-sessions',
  description: 'Principal session tokens and end-user permission endpoints',
  optional: true,
  run: async (ctx: SuiteContext): Promise<TestResult[]> => {
    const results: TestResult[] = [];
    const { agentId, agentDid } = ctx.sharedAgent;

    // We need a grant to exist for the principal before creating a session
    const principalId = `principal-session-${Date.now()}`;
    const flow = await ctx.flow.executeFullFlow({
      agentId,
      agentDid,
      scopes: ['read', 'write'],
      principalId,
    });

    results.push(
      await test(
        'POST /v1/principal-sessions returns 201 with sessionToken and dashboardUrl',
        '§12',
        async () => {
          const res = await ctx.http.post<{
            sessionToken: string;
            dashboardUrl: string;
            expiresAt: string;
          }>('/v1/principal-sessions', {
            principalId,
            expiresIn: '1h',
          });
          expectStatus(res, 201);
          expectString(res.body.sessionToken, 'sessionToken');
          expectString(res.body.dashboardUrl, 'dashboardUrl');
          expectString(res.body.expiresAt, 'expiresAt');

          if (!res.body.dashboardUrl.includes('/permissions?session=')) {
            throw new Error(
              `Expected dashboardUrl to contain /permissions?session=, got: ${res.body.dashboardUrl}`,
            );
          }
        },
      ),
    );

    results.push(
      await test(
        'POST /v1/principal-sessions returns 400 without principalId',
        '§12',
        async () => {
          const res = await ctx.http.post('/v1/principal-sessions', {});
          expectStatus(res, 400);
        },
      ),
    );

    results.push(
      await test(
        'Session token can be used to GET /v1/principal/grants',
        '§12',
        async () => {
          const sessionRes = await ctx.http.post<{
            sessionToken: string;
          }>('/v1/principal-sessions', {
            principalId,
          });
          expectStatus(sessionRes, 201);

          const grantsRes = await ctx.http.doRequestWithToken<{
            grants: Array<{ grantId: string; agentId: string; scopes: string[] }>;
            principalId: string;
          }>('GET', '/v1/principal/grants', sessionRes.body.sessionToken);
          expectStatus(grantsRes, 200);

          if (!Array.isArray(grantsRes.body.grants)) {
            throw new Error('Expected grants to be an array');
          }
          if (grantsRes.body.principalId !== principalId) {
            throw new Error(
              `Expected principalId ${principalId}, got ${grantsRes.body.principalId}`,
            );
          }
          const found = grantsRes.body.grants.some(
            (g) => g.grantId === flow.grantId,
          );
          if (!found) {
            throw new Error(
              `Expected to find grant ${flow.grantId} in principal grants`,
            );
          }
        },
      ),
    );

    results.push(
      await test(
        'Session token can be used to GET /v1/principal/audit',
        '§12',
        async () => {
          const sessionRes = await ctx.http.post<{
            sessionToken: string;
          }>('/v1/principal-sessions', {
            principalId,
          });
          expectStatus(sessionRes, 201);

          const auditRes = await ctx.http.doRequestWithToken<{
            entries: unknown[];
          }>('GET', '/v1/principal/audit', sessionRes.body.sessionToken);
          expectStatus(auditRes, 200);

          if (!Array.isArray(auditRes.body.entries)) {
            throw new Error('Expected entries to be an array');
          }
        },
      ),
    );

    results.push(
      await test(
        'Session token can revoke a principal grant via DELETE /v1/principal/grants/:id',
        '§12',
        async () => {
          // Create a fresh grant to revoke
          const revokeFlow = await ctx.flow.executeFullFlow({
            agentId,
            agentDid,
            scopes: ['read'],
            principalId,
          });

          const sessionRes = await ctx.http.post<{
            sessionToken: string;
          }>('/v1/principal-sessions', {
            principalId,
          });
          expectStatus(sessionRes, 201);

          const revokeRes = await ctx.http.doRequestWithToken(
            'DELETE',
            `/v1/principal/grants/${revokeFlow.grantId}`,
            sessionRes.body.sessionToken,
          );
          expectStatus(revokeRes, 204);
        },
      ),
    );

    results.push(
      await test(
        'Session token is rejected on developer API endpoints (401)',
        '§12',
        async () => {
          const sessionRes = await ctx.http.post<{
            sessionToken: string;
          }>('/v1/principal-sessions', {
            principalId,
          });
          expectStatus(sessionRes, 201);

          // Using session token on a developer endpoint should fail
          const agentsRes = await ctx.http.doRequestWithToken(
            'GET',
            '/v1/agents',
            sessionRes.body.sessionToken,
          );
          expectStatus(agentsRes, 401);
        },
      ),
    );

    results.push(
      await test(
        'GET /permissions returns HTML page (200)',
        '§12',
        async () => {
          const res = await ctx.http.requestPublic('GET', '/permissions');
          expectStatus(res, 200);
        },
      ),
    );

    return results;
  },
};
