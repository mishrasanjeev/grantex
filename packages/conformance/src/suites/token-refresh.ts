import type { SuiteDefinition, SuiteContext, TestResult } from '../types.js';
import { test, expectStatus, expectString, expectArray, expectIsoDate } from '../helpers.js';

export const tokenRefreshSuite: SuiteDefinition = {
  name: 'token-refresh',
  description: 'Token refresh rotation and request-bound response recovery',
  optional: true,
  run: async (ctx: SuiteContext): Promise<TestResult[]> => {
    const results: TestResult[] = [];
    const { agentId, agentDid } = ctx.sharedAgent;

    results.push(
      await test(
        'POST /v1/token/refresh returns new grantToken with same grantId',
        '§7.4',
        async () => {
          const flow = await ctx.flow.executeFullFlow({
            agentId,
            agentDid,
            scopes: ['read', 'write'],
          });

          const res = await ctx.http.post<{
            grantToken: string;
            refreshToken: string;
            grantId: string;
            scopes: string[];
            expiresAt: string;
          }>('/v1/token/refresh', {
            refreshToken: flow.refreshToken,
            agentId,
          }, { 'Idempotency-Key': 'conformance-refresh-success-0001' });
          expectStatus(res, 201);
          expectString(res.body.grantToken, 'grantToken');
          expectString(res.body.refreshToken, 'refreshToken');
          expectString(res.body.grantId, 'grantId');
          expectArray(res.body.scopes, 'scopes');
          expectIsoDate(res.body.expiresAt, 'expiresAt');

          if (res.body.grantId !== flow.grantId) {
            throw new Error(
              `Expected same grantId ${flow.grantId}, got ${res.body.grantId}`,
            );
          }
          if (res.body.refreshToken === flow.refreshToken) {
            throw new Error('Expected rotated refresh token, got the same one');
          }
          ctx.cleanup.trackGrant(res.body.grantId);
        },
      ),
    );

    results.push(
      await test(
        'POST /v1/token/refresh replays the exact committed token values only for the same idempotency key',
        '§7.4',
        async () => {
          const flow = await ctx.flow.executeFullFlow({
            agentId,
            agentDid,
            scopes: ['read'],
          });

          // First refresh — succeeds
          const key = 'conformance-refresh-recovery-0001';
          const first = await ctx.http.post<{
            grantToken: string;
            refreshToken: string;
            grantId: string;
          }>('/v1/token/refresh', {
            refreshToken: flow.refreshToken,
            agentId,
          }, { 'Idempotency-Key': key });
          expectStatus(first, 201);
          ctx.cleanup.trackGrant(first.body.grantId);

          const recovered = await ctx.http.post<{
            grantToken: string;
            refreshToken: string;
            grantId: string;
          }>('/v1/token/refresh', {
            refreshToken: flow.refreshToken,
            agentId,
          }, { 'Idempotency-Key': key });
          expectStatus(recovered, 201);
          if (recovered.body.grantToken !== first.body.grantToken
              || recovered.body.refreshToken !== first.body.refreshToken
              || recovered.body.grantId !== first.body.grantId) {
            throw new Error('Recovery did not return the exact committed refresh token values');
          }

          const mismatched = await ctx.http.post('/v1/token/refresh', {
            refreshToken: flow.refreshToken,
            agentId,
          }, { 'Idempotency-Key': 'conformance-refresh-different-0002' });
          expectStatus(mismatched, 400);
        },
      ),
    );

    results.push(
      await test(
        'POST /v1/token/refresh rejects mismatched agentId (400)',
        '§7.4',
        async () => {
          const flow = await ctx.flow.executeFullFlow({
            agentId,
            agentDid,
            scopes: ['read'],
          });

          const res = await ctx.http.post('/v1/token/refresh', {
            refreshToken: flow.refreshToken,
            agentId: 'ag_nonexistent_12345',
          });
          expectStatus(res, 400);
        },
      ),
    );

    results.push(
      await test(
        'POST /v1/token/refresh rejects missing refreshToken (400)',
        '§7.4',
        async () => {
          const res = await ctx.http.post('/v1/token/refresh', {
            agentId,
          });
          expectStatus(res, 400);
        },
      ),
    );

    results.push(
      await test(
        'POST /v1/token/refresh rejects missing agentId (400)',
        '§7.4',
        async () => {
          const flow = await ctx.flow.executeFullFlow({
            agentId,
            agentDid,
            scopes: ['read'],
          });

          const res = await ctx.http.post('/v1/token/refresh', {
            refreshToken: flow.refreshToken,
          });
          expectStatus(res, 400);
        },
      ),
    );

    results.push(
      await test(
        'Refreshed token can be verified online',
        '§7.4',
        async () => {
          const flow = await ctx.flow.executeFullFlow({
            agentId,
            agentDid,
            scopes: ['read', 'write'],
          });

          const refreshRes = await ctx.http.post<{
            grantToken: string;
            grantId: string;
          }>('/v1/token/refresh', {
            refreshToken: flow.refreshToken,
            agentId,
          }, { 'Idempotency-Key': 'conformance-refresh-verify-0001' });
          expectStatus(refreshRes, 201);
          ctx.cleanup.trackGrant(refreshRes.body.grantId);

          // Verify the new token
          const verifyRes = await ctx.http.post<{
            valid: boolean;
            grantId: string;
            scopes: string[];
          }>('/v1/tokens/verify', {
            token: refreshRes.body.grantToken,
          });
          expectStatus(verifyRes, 200);

          if (verifyRes.body.valid !== true) {
            throw new Error('Expected refreshed token to be valid');
          }
          if (verifyRes.body.grantId !== flow.grantId) {
            throw new Error(
              `Expected grantId ${flow.grantId}, got ${verifyRes.body.grantId}`,
            );
          }
        },
      ),
    );

    return results;
  },
};
