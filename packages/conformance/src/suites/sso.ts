import type { SuiteDefinition, SuiteContext, TestResult } from '../types.js';
import { test, expectStatus, expectKeys, expectString } from '../helpers.js';

export const ssoSuite: SuiteDefinition = {
  name: 'sso',
  description: 'SSO configuration and flow',
  optional: true,
  run: async (ctx: SuiteContext): Promise<TestResult[]> => {
    const results: TestResult[] = [];

    results.push(
      await test('POST /v1/sso/config creates SSO config (201)', '§13', async () => {
        const res = await ctx.http.post<{
          issuerUrl: string;
          clientId: string;
          redirectUri: string;
        }>('/v1/sso/config', {
          issuerUrl: 'https://accounts.google.com',
          clientId: 'conformance-test-client',
          clientSecret: 'conformance-test-secret',
          redirectUri: 'https://example.com/sso/callback',
        });
        expectStatus(res, 201);
        expectKeys(res.body, ['issuerUrl', 'clientId', 'redirectUri']);
      }),
    );

    results.push(
      await test('GET /v1/sso/config returns SSO config', '§13', async () => {
        const res = await ctx.http.get<{
          issuerUrl: string;
          clientId: string;
        }>('/v1/sso/config');
        expectStatus(res, 200);
        expectKeys(res.body, ['issuerUrl', 'clientId', 'redirectUri']);
        expectString(res.body.issuerUrl, 'issuerUrl');
      }),
    );

    results.push(
      await test('GET /sso/login requires org parameter', '§13', async () => {
        const res = await ctx.http.requestPublic('GET', '/sso/login');
        expectStatus(res, 400);
      }),
    );

    results.push(
      await test('DELETE /v1/sso/config returns 204', '§13', async () => {
        const res = await ctx.http.delete('/v1/sso/config');
        expectStatus(res, 204);
      }),
    );

    return results;
  },
};
