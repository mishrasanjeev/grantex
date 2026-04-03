/**
 * E2E Tests: Webhook Management
 *
 * Tests webhook creation, listing, deletion, secret uniqueness,
 * invalid event types, and duplicate webhook handling.
 * Run: npx vitest run tests/e2e/webhooks.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Grantex } from '@grantex/sdk';

const BASE_URL = process.env.E2E_BASE_URL ?? 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app';

let grantex: Grantex;
let apiKey: string;

beforeAll(async () => {
  const account = await Grantex.signup({ name: `e2e-webhook-${Date.now()}`, mode: 'sandbox' }, { baseUrl: BASE_URL });
  apiKey = account.apiKey;
  grantex = new Grantex({ apiKey, baseUrl: BASE_URL });
});

describe('E2E: Webhook CRUD', () => {
  let webhookId: string;
  let webhookSecret: string;
  let secondWebhookId: string;
  let secondWebhookSecret: string;

  it('creates a webhook with multiple events', async () => {
    const webhook = await grantex.webhooks.create({
      url: 'https://example.com/webhook/grantex',
      events: ['grant.created', 'grant.revoked'],
    });
    webhookId = webhook.id;
    webhookSecret = webhook.secret;

    expect(webhook.id).toBeDefined();
    expect(typeof webhook.id).toBe('string');
    expect(webhook.url).toBe('https://example.com/webhook/grantex');
    expect(webhook.events).toEqual(['grant.created', 'grant.revoked']);
    expect(webhook.events).toHaveLength(2);
    expect(webhook.secret).toBeDefined();
    expect(typeof webhook.secret).toBe('string');
    expect(webhook.secret.length).toBeGreaterThan(0);
    expect(webhook.createdAt).toBeDefined();
  });

  it('creates a second webhook with a single event', async () => {
    const webhook = await grantex.webhooks.create({
      url: 'https://example.com/webhook/tokens',
      events: ['token.issued'],
    });
    secondWebhookId = webhook.id;
    secondWebhookSecret = webhook.secret;

    expect(webhook.id).toBeDefined();
    expect(webhook.id).not.toBe(webhookId);
    expect(webhook.events).toEqual(['token.issued']);
    expect(webhook.url).toBe('https://example.com/webhook/tokens');
  });

  it('each webhook gets a unique secret', async () => {
    expect(webhookSecret).not.toBe(secondWebhookSecret);
  });

  it('lists all webhooks for the developer', async () => {
    const result = await grantex.webhooks.list();
    expect(result).toBeDefined();
    expect(result.webhooks).toBeDefined();
    expect(Array.isArray(result.webhooks)).toBe(true);
    expect(result.webhooks.length).toBeGreaterThanOrEqual(2);

    // First webhook should be in the list
    const first = result.webhooks.find((w: any) => w.id === webhookId);
    expect(first).toBeDefined();
    expect(first!.url).toBe('https://example.com/webhook/grantex');
    expect(first!.events).toEqual(['grant.created', 'grant.revoked']);

    // Second webhook should also be present
    const second = result.webhooks.find((w: any) => w.id === secondWebhookId);
    expect(second).toBeDefined();
    expect(second!.url).toBe('https://example.com/webhook/tokens');
  });

  it('deletes the first webhook', async () => {
    await grantex.webhooks.delete(webhookId);

    // Verify it's gone
    const result = await grantex.webhooks.list();
    const found = result.webhooks.find((w: any) => w.id === webhookId);
    expect(found).toBeUndefined();

    // Second webhook should still exist
    const second = result.webhooks.find((w: any) => w.id === secondWebhookId);
    expect(second).toBeDefined();
  });

  it('returns 404 when deleting an already-deleted webhook', async () => {
    await expect(grantex.webhooks.delete(webhookId)).rejects.toThrow();
  });

  it('deletes the second webhook', async () => {
    await grantex.webhooks.delete(secondWebhookId);
    const result = await grantex.webhooks.list();
    expect(result.webhooks.length).toBe(0);
  });
});

describe('E2E: Webhook Validation', () => {
  it('rejects invalid event types', async () => {
    await expect(
      grantex.webhooks.create({
        url: 'https://example.com/bad',
        events: ['invalid.event.type'],
      }),
    ).rejects.toThrow();
  });

  it('rejects empty events array', async () => {
    await expect(
      grantex.webhooks.create({
        url: 'https://example.com/empty',
        events: [],
      }),
    ).rejects.toThrow();
  });

  it('rejects mix of valid and invalid events', async () => {
    await expect(
      grantex.webhooks.create({
        url: 'https://example.com/mixed',
        events: ['grant.created', 'nonexistent.event'],
      }),
    ).rejects.toThrow();
  });

  it('creates a webhook with all valid event types', async () => {
    const webhook = await grantex.webhooks.create({
      url: 'https://example.com/all-events',
      events: ['grant.created', 'grant.revoked', 'token.issued'],
    });
    expect(webhook.events).toEqual(['grant.created', 'grant.revoked', 'token.issued']);
    expect(webhook.events).toHaveLength(3);

    // Cleanup
    await grantex.webhooks.delete(webhook.id);
  });
});

describe('E2E: Webhook Deliveries', () => {
  it('returns deliveries endpoint for a valid webhook', async () => {
    const webhook = await grantex.webhooks.create({
      url: 'https://example.com/deliveries-test',
      events: ['grant.created'],
    });

    // Query deliveries via raw fetch (may not be in SDK)
    const res = await fetch(`${BASE_URL}/v1/webhooks/${webhook.id}/deliveries`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { deliveries: any[]; total: number; page: number; pageSize: number };
    expect(body.deliveries).toBeDefined();
    expect(Array.isArray(body.deliveries)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(typeof body.page).toBe('number');
    expect(typeof body.pageSize).toBe('number');

    // Cleanup
    await grantex.webhooks.delete(webhook.id);
  });

  it('returns 404 for deliveries of non-existent webhook', async () => {
    const res = await fetch(`${BASE_URL}/v1/webhooks/wh_nonexistent_000/deliveries`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(404);
  });
});
