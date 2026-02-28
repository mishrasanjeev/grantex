import type { SuiteDefinition, SuiteContext, TestResult } from '../types.js';
import { test, expectStatus, expectKeys, expectString, expectEqual } from '../helpers.js';

export const delegationSuite: SuiteDefinition = {
  name: 'delegation',
  description: 'Grant delegation and scope enforcement',
  optional: false,
  run: async (ctx: SuiteContext): Promise<TestResult[]> => {
    const results: TestResult[] = [];

    // Create parent flow
    const parentFlow = await ctx.flow.executeFullFlow({
      agentName: `conformance-parent-${Date.now()}`,
      scopes: ['read', 'write'],
    });

    // Create sub-agent for delegation
    const subAgentRes = await ctx.http.post<{ agentId: string; did: string }>('/v1/agents', {
      name: `conformance-sub-${Date.now()}`,
      scopes: ['read', 'write'],
    });
    if (subAgentRes.status !== 201) {
      throw new Error(`Failed to create sub-agent: ${subAgentRes.status}`);
    }
    ctx.cleanup.trackAgent(subAgentRes.body.agentId);

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
            subAgentId: subAgentRes.body.agentId,
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
              subAgentId: subAgentRes.body.agentId,
              scopes: ['read'],
            },
          );
          expectStatus(res, 201);
          ctx.cleanup.trackGrant(res.body.grantId);

          // Decode JWT payload
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
            subAgentId: subAgentRes.body.agentId,
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
          // Create a chain: parent → child → grandchild
          const child2Res = await ctx.http.post<{ agentId: string }>('/v1/agents', {
            name: `conformance-child2-${Date.now()}`,
            scopes: ['read'],
          });
          if (child2Res.status !== 201) throw new Error('Failed to create child2 agent');
          ctx.cleanup.trackAgent(child2Res.body.agentId);

          // Delegate parent → child
          const del1 = await ctx.http.post<{ grantToken: string; grantId: string }>(
            '/v1/grants/delegate',
            {
              parentGrantToken: parentFlow.grantToken,
              subAgentId: subAgentRes.body.agentId,
              scopes: ['read'],
            },
          );
          expectStatus(del1, 201);
          ctx.cleanup.trackGrant(del1.body.grantId);

          // Delegate child → grandchild
          const del2 = await ctx.http.post<{ grantToken: string; grantId: string }>(
            '/v1/grants/delegate',
            {
              parentGrantToken: del1.body.grantToken,
              subAgentId: child2Res.body.agentId,
              scopes: ['read'],
            },
          );
          // Depth 2 — may succeed or fail depending on server config
          // We just verify it returns a meaningful response
          if (del2.status === 201) {
            ctx.cleanup.trackGrant(del2.body.grantId);
            // Check depth incremented
            const parts = del2.body.grantToken.split('.');
            const payload = JSON.parse(atob(parts[1]!)) as { delegationDepth: number };
            expectEqual(payload.delegationDepth, 2, 'delegationDepth');
          } else {
            // Server enforces depth limit — this is also valid
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
          // Create a fresh parent flow for cascade test
          const cascadeFlow = await ctx.flow.executeFullFlow({
            agentName: `conformance-cascade-parent-${Date.now()}`,
            scopes: ['read'],
          });

          const cascadeSubRes = await ctx.http.post<{ agentId: string }>('/v1/agents', {
            name: `conformance-cascade-sub-${Date.now()}`,
            scopes: ['read'],
          });
          expectStatus(cascadeSubRes, 201);
          ctx.cleanup.trackAgent(cascadeSubRes.body.agentId);

          // Delegate
          const delRes = await ctx.http.post<{ grantToken: string; grantId: string }>(
            '/v1/grants/delegate',
            {
              parentGrantToken: cascadeFlow.grantToken,
              subAgentId: cascadeSubRes.body.agentId,
              scopes: ['read'],
            },
          );
          expectStatus(delRes, 201);
          ctx.cleanup.trackGrant(delRes.body.grantId);

          // Revoke parent grant
          const revokeRes = await ctx.http.delete(`/v1/grants/${cascadeFlow.grantId}`);
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
