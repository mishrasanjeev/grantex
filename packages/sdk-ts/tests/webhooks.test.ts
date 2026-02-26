import { createHmac } from 'node:crypto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Grantex } from '../src/client.js';
import { verifyWebhookSignature } from '../src/webhook.js';

function makeFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

const MOCK_WEBHOOK = {
  id: 'wh_01',
  url: 'https://example.com/hooks',
  events: ['grant.created', 'grant.revoked'],
  createdAt: '2026-02-26T00:00:00Z',
};

const MOCK_WEBHOOK_WITH_SECRET = { ...MOCK_WEBHOOK, secret: 'abc123secret' };

describe('WebhooksClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('create() POSTs to /v1/webhooks and returns endpoint with secret', async () => {
    const mockFetch = makeFetch(201, MOCK_WEBHOOK_WITH_SECRET);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.webhooks.create({
      url: 'https://example.com/hooks',
      events: ['grant.created', 'grant.revoked'],
    });

    expect(result.id).toBe('wh_01');
    expect(result.secret).toBe('abc123secret');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/webhooks$/);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['events']).toEqual(['grant.created', 'grant.revoked']);
  });

  it('list() GETs /v1/webhooks', async () => {
    vi.stubGlobal('fetch', makeFetch(200, { webhooks: [MOCK_WEBHOOK] }));

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.webhooks.list();

    expect(result.webhooks).toHaveLength(1);
    expect(result.webhooks[0]!.id).toBe('wh_01');
  });

  it('delete() DELETEs /v1/webhooks/:id', async () => {
    const mockFetch = makeFetch(204, null);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    await expect(grantex.webhooks.delete('wh_01')).resolves.toBeUndefined();

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/webhooks\/wh_01$/);
    expect(init.method).toBe('DELETE');
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 'test-webhook-secret';
  const payload = '{"id":"evt_01","type":"grant.created","data":{}}';

  function makeSignature(p: string, s: string): string {
    return 'sha256=' + createHmac('sha256', s).update(p).digest('hex');
  }

  it('returns true for a valid signature', () => {
    const sig = makeSignature(payload, secret);
    expect(verifyWebhookSignature(payload, sig, secret)).toBe(true);
  });

  it('returns false for an invalid signature', () => {
    expect(verifyWebhookSignature(payload, 'sha256=invalidsignature', secret)).toBe(false);
  });

  it('returns false when signed with wrong secret', () => {
    const sig = makeSignature(payload, 'different-secret');
    expect(verifyWebhookSignature(payload, sig, secret)).toBe(false);
  });

  it('accepts Buffer payload', () => {
    const buf = Buffer.from(payload);
    const sig = makeSignature(payload, secret);
    expect(verifyWebhookSignature(buf, sig, secret)).toBe(true);
  });
});
