import type { SuiteDefinition, SuiteContext, TestResult } from '../types.js';
import { test, expectStatus, expectKeys, expectString, expectArray } from '../helpers.js';

export const webhooksSuite: SuiteDefinition = {
  name: 'webhooks',
  description: 'Webhook registration and management',
  optional: true,
  run: async (ctx: SuiteContext): Promise<TestResult[]> => {
    const results: TestResult[] = [];
    let webhookId = '';

    results.push(
      await test('POST /v1/webhooks creates webhook (201)', '§11', async () => {
        const res = await ctx.http.post<{
          id: string;
          url: string;
          events: string[];
          secret: string;
        }>('/v1/webhooks', {
          url: 'https://example.com/webhook',
          events: ['grant.created', 'grant.revoked'],
        });
        expectStatus(res, 201);
        expectKeys(res.body, ['id', 'url', 'events', 'secret']);
        expectString(res.body.id, 'id');
        expectString(res.body.secret, 'secret');
        webhookId = res.body.id;
        ctx.cleanup.trackWebhook(webhookId);
      }),
    );

    results.push(
      await test('GET /v1/webhooks lists webhooks', '§11', async () => {
        const res = await ctx.http.get<{ webhooks: unknown[] }>('/v1/webhooks');
        expectStatus(res, 200);
        expectKeys(res.body, ['webhooks']);
        expectArray(res.body.webhooks, 'webhooks');
      }),
    );

    results.push(
      await test('DELETE /v1/webhooks/:id returns 204', '§11', async () => {
        if (!webhookId) throw new Error('No webhook created');
        const res = await ctx.http.delete(`/v1/webhooks/${webhookId}`);
        expectStatus(res, 204);
      }),
    );

    return results;
  },
};
