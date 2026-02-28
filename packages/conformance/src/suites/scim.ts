import type { SuiteDefinition, SuiteContext, TestResult } from '../types.js';
import { test, expectStatus, expectKeys, expectString, expectArray } from '../helpers.js';

export const scimSuite: SuiteDefinition = {
  name: 'scim',
  description: 'SCIM 2.0 provisioning endpoints',
  optional: true,
  run: async (ctx: SuiteContext): Promise<TestResult[]> => {
    const results: TestResult[] = [];
    let scimToken = '';
    let scimTokenId = '';
    let userId = '';

    results.push(
      await test('POST /v1/scim/tokens creates SCIM token (201)', '§13', async () => {
        const res = await ctx.http.post<{
          id: string;
          label: string;
          token: string;
        }>('/v1/scim/tokens', {
          label: `conformance-scim-${Date.now()}`,
        });
        expectStatus(res, 201);
        expectKeys(res.body, ['id', 'label', 'token']);
        expectString(res.body.token, 'token');
        scimToken = res.body.token;
        scimTokenId = res.body.id;
      }),
    );

    results.push(
      await test('GET /v1/scim/tokens lists SCIM tokens', '§13', async () => {
        const res = await ctx.http.get<{ tokens: unknown[] }>('/v1/scim/tokens');
        expectStatus(res, 200);
        expectKeys(res.body, ['tokens']);
        expectArray(res.body.tokens, 'tokens');
      }),
    );

    results.push(
      await test('GET /scim/v2/ServiceProviderConfig returns config', '§13', async () => {
        const res = await ctx.http.requestPublic<{ schemas: string[] }>(
          'GET',
          '/scim/v2/ServiceProviderConfig',
        );
        expectStatus(res, 200);
        expectKeys(res.body, ['schemas']);
      }),
    );

    results.push(
      await test('POST /scim/v2/Users creates user (201)', '§13', async () => {
        if (!scimToken) throw new Error('No SCIM token created');
        const res = await ctx.http.doRequestWithToken<{
          id: string;
          userName: string;
          schemas: string[];
        }>('POST', '/scim/v2/Users', scimToken, {
          userName: `conformance-user-${Date.now()}@example.com`,
          displayName: 'Conformance Test User',
        });
        expectStatus(res, 201);
        expectKeys(res.body, ['id', 'userName', 'schemas']);
        expectString(res.body.id, 'id');
        userId = res.body.id;
      }),
    );

    results.push(
      await test('GET /scim/v2/Users lists users', '§13', async () => {
        if (!scimToken) throw new Error('No SCIM token created');
        const res = await ctx.http.doRequestWithToken<{ Resources: unknown[] }>(
          'GET',
          '/scim/v2/Users',
          scimToken,
        );
        expectStatus(res, 200);
        expectKeys(res.body, ['Resources', 'totalResults']);
      }),
    );

    results.push(
      await test('DELETE /scim/v2/Users/:id returns 204', '§13', async () => {
        if (!scimToken || !userId) throw new Error('No SCIM user created');
        const res = await ctx.http.doRequestWithToken(
          'DELETE',
          `/scim/v2/Users/${userId}`,
          scimToken,
        );
        expectStatus(res, 204);

        // Clean up SCIM token
        if (scimTokenId) {
          await ctx.http.delete(`/v1/scim/tokens/${scimTokenId}`);
        }
      }),
    );

    return results;
  },
};
