import type { SuiteDefinition, SuiteContext, TestResult } from '../types.js';
import { test, expectStatus, expectKeys, expectString, expectEqual } from '../helpers.js';

export const delegationSuite: SuiteDefinition = {
  name: 'delegation',
  description: 'Grant delegation and scope enforcement',
  optional: false,
  run: async (ctx: SuiteContext): Promise<TestResult[]> => {
    const results: TestResult[] = [];
    const { agentId, agentDid } = ctx.sharedAgent;

    // Create parent flow using shared agent
    const parentFlow = await ctx.flow.executeFullFlow({
      agentId,
      agentDid,
      scopes: ['read', 'write'],
    });

    // Use the shared agent as both parent and sub-agent (self-delegation is valid)
    const subAgentId = agentId;

    results.push(
      await test(
        'POST /v1/grants/delegate returns 201 with grantToken',
        '§9',
        async () => {
          const res = await ctx.http.post<{
            grantToken: string;
            expiresAt: string;
            scopes: string[];
            grantId: string;
          }>('/v1/grants/delegate', {
            parentGrantToken: parentFlow.grantToken,
            subAgentId,
            scopes: ['read'],
          });
          expectStatus(res, 201);
          expectKeys(res.body, ['grantToken', 'expiresAt', 'scopes', 'grantId']);
          expectString(res.body.grantToken, 'grantToken');
          ctx.cleanup.trackGrant(res.body.grantId);
        },
      ),
    );

    results.push(
      await test(
        'Delegated JWT contains parentAgt, parentGrnt, delegationDepth',
        '§9',
        async () => {
          const res = await ctx.http.post<{ grantToken: string; grantId: string }>(
            '/v1/grants/delegate',
            {
              parentGrantToken: parentFlow.grantToken,
              subAgentId,
              scopes: ['read'],
            },
          );
          expectStatus(res, 201);
          ctx.cleanup.trackGrant(res.body.grantId);

          const parts = res.body.grantToken.split('.');
          const payload = JSON.parse(atob(parts[1]!)) as {
            parentAgt: string;
            parentGrnt: string;
            delegationDepth: number;
          };
          expectString(payload.parentAgt, 'parentAgt');
          expectString(payload.parentGrnt, 'parentGrnt');
          expectEqual(typeof payload.delegationDepth, 'number', 'delegationDepth type');
          expectEqual(payload.delegationDepth, 1, 'delegationDepth');
        },
      ),
    );

    results.push(
      await test(
        'Delegation rejects scope superset (400)',
        '§9',
        async () => {
          const res = await ctx.http.post('/v1/grants/delegate', {
            parentGrantToken: parentFlow.grantToken,
            subAgentId,
            scopes: ['read', 'write', 'admin'],
          });
          expectStatus(res, 400);
        },
      ),
    );

    results.push(
      await test(
        'Delegation depth limit is enforced',
        '§9',
        async () => {
          // Delegate parent → self (depth 1)
          const del1 = await ctx.http.post<{ grantToken: string; grantId: string }>(
            '/v1/grants/delegate',
            {
              parentGrantToken: parentFlow.grantToken,
              subAgentId,
              scopes: ['read'],
            },
          );
          expectStatus(del1, 201);
          ctx.cleanup.trackGrant(del1.body.grantId);

          // Delegate depth-1 → self (depth 2)
          const del2 = await ctx.http.post<{ grantToken: string; grantId: string }>(
            '/v1/grants/delegate',
            {
              parentGrantToken: del1.body.grantToken,
              subAgentId,
              scopes: ['read'],
            },
          );
          if (del2.status === 201) {
            ctx.cleanup.trackGrant(del2.body.grantId);
            const parts = del2.body.grantToken.split('.');
            const payload = JSON.parse(atob(parts[1]!)) as { delegationDepth: number };
            expectEqual(payload.delegationDepth, 2, 'delegationDepth');
          } else {
            // Server enforces depth limit — also valid
            expectStatus(del2, 400);
          }
        },
      ),
    );

    results.push(
      await test(
        'Revoking parent cascades to delegated grants',
        '§9',
        async () => {
          // New authorize+token flow using shared agent
          const authRes = await ctx.http.post<{
            authRequestId: string;
            code?: string;
          }>('/v1/authorize', {
            agentId,
            principalId: `principal-cascade-${Date.now()}`,
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
            if (consentRes.status !== 200) {
              throw new Error(`Consent approve failed: ${consentRes.status} ${consentRes.rawText}`);
            }
            code = consentRes.body.code;
          }

          const tokenRes = await ctx.http.post<{
            grantToken: string;
            grantId: string;
          }>('/v1/token', { code, agentId });
          expectStatus(tokenRes, 201);
          ctx.cleanup.trackGrant(tokenRes.body.grantId);

          // Delegate to self
          const delRes = await ctx.http.post<{ grantToken: string; grantId: string }>(
            '/v1/grants/delegate',
            {
              parentGrantToken: tokenRes.body.grantToken,
              subAgentId,
              scopes: ['read'],
            },
          );
          expectStatus(delRes, 201);
          ctx.cleanup.trackGrant(delRes.body.grantId);

          // Revoke parent grant
          const revokeRes = await ctx.http.delete(`/v1/grants/${tokenRes.body.grantId}`);
          expectStatus(revokeRes, 204);

          // Verify child token is now invalid
          const verifyRes = await ctx.http.post<{ valid: boolean }>('/v1/tokens/verify', {
            token: delRes.body.grantToken,
          });
          expectStatus(verifyRes, 200);
          expectEqual(verifyRes.body.valid, false, 'valid');
        },
      ),
    );

    return results;
  },
};
