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
          // Create a session token
          const sessionRes = await ctx.http.post<{
            sessionToken: string;
          }>('/v1/principal-sessions', {
            principalId,
          });
          expectStatus(sessionRes, 201);

          // Use the session token to fetch grants
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
          // Should find the grant we created
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

    return results;
  },
};
