import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unmock the real implementation
vi.unmock('../src/lib/webhook.js');

import { signWebhookPayload, enqueueWebhookDeliveries } from '../src/lib/webhook.js';
import { sqlMock } from './setup.js';

beforeEach(() => {
  sqlMock.mockReset();
  sqlMock.mockResolvedValue([]);
});

describe('signWebhookPayload', () => {
  it('generates correct HMAC-SHA256 signature', () => {
    const secret = 'my-secret';
    const payload = '{"type":"grant.created"}';
    const sig = signWebhookPayload(secret, payload);

    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('produces consistent signatures for same inputs', () => {
    const sig1 = signWebhookPayload('secret', 'payload');
    const sig2 = signWebhookPayload('secret', 'payload');
    expect(sig1).toBe(sig2);
  });

  it('produces different signatures for different secrets', () => {
    const sig1 = signWebhookPayload('secret-a', 'payload');
    const sig2 = signWebhookPayload('secret-b', 'payload');
    expect(sig1).not.toBe(sig2);
  });

  it('produces different signatures for different payloads', () => {
    const sig1 = signWebhookPayload('secret', 'payload-a');
    const sig2 = signWebhookPayload('secret', 'payload-b');
    expect(sig1).not.toBe(sig2);
  });
});

describe('enqueueWebhookDeliveries', () => {
  const event = {
    id: 'evt_123',
    type: 'grant.created',
    createdAt: '2026-03-08T00:00:00Z',
    data: { grantId: 'grnt_1' },
  };

  it('creates delivery rows for matching webhooks', async () => {
    // First SQL call: SELECT matching webhooks
    sqlMock.mockResolvedValueOnce([
      { id: 'wh_1', url: 'https://example.com/hook', secret: 'sec_1' },
    ]);
    // Second SQL call: INSERT delivery row
    sqlMock.mockResolvedValueOnce([]);

    await enqueueWebhookDeliveries('dev_1', event);

    // SELECT + 1 INSERT
    expect(sqlMock).toHaveBeenCalledTimes(2);
  });

  it('creates a delivery row for each matching webhook', async () => {
    sqlMock.mockResolvedValueOnce([
      { id: 'wh_1', url: 'https://a.com/hook', secret: 'sec_1' },
      { id: 'wh_2', url: 'https://b.com/hook', secret: 'sec_2' },
    ]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);

    await enqueueWebhookDeliveries('dev_1', event);

    // SELECT + 2 INSERTs
    expect(sqlMock).toHaveBeenCalledTimes(3);
  });

  it('does nothing when no matching webhooks', async () => {
    sqlMock.mockResolvedValueOnce([]); // No webhooks match

    await enqueueWebhookDeliveries('dev_1', event);

    // Only the SELECT call
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });
});
