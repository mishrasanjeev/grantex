import { describe, it, expect, vi, beforeEach } from 'vitest';

// Undo the setup.ts mock of events.js so we test the real implementation
vi.unmock('../src/lib/events.js');

// Use vi.hoisted so mocks are available inside vi.mock factories (which are hoisted)
const { mockEnqueue, mockPublish } = vi.hoisted(() => ({
  mockEnqueue: vi.fn().mockResolvedValue(undefined),
  mockPublish: vi.fn().mockResolvedValue(0),
}));

vi.mock('../src/lib/webhook.js', () => ({
  enqueueWebhookDeliveries: mockEnqueue,
}));

vi.mock('../src/redis/client.js', () => ({
  getRedis: () => ({ publish: mockPublish }),
}));

vi.mock('ulid', () => ({ ulid: () => 'TESTULID01' }));

import { emitEvent } from '../src/lib/events.js';

beforeEach(() => {
  mockEnqueue.mockClear();
  mockEnqueue.mockResolvedValue(undefined);
  mockPublish.mockClear();
  mockPublish.mockResolvedValue(0);
});

describe('emitEvent', () => {
  it('enqueues webhook deliveries with the correct event', async () => {
    await emitEvent('dev_1', 'grant.created', { grantId: 'grnt_1' });

    expect(mockEnqueue).toHaveBeenCalledOnce();
    expect(mockEnqueue).toHaveBeenCalledWith('dev_1', expect.objectContaining({
      id: 'evt_TESTULID01',
      type: 'grant.created',
      data: { grantId: 'grnt_1' },
    }));
  });

  it('publishes to Redis pub/sub channel', async () => {
    await emitEvent('dev_1', 'token.issued', { tokenId: 'tok_1' });

    expect(mockPublish).toHaveBeenCalledOnce();
    expect(mockPublish).toHaveBeenCalledWith(
      'grantex:events:dev_1',
      expect.stringContaining('"token.issued"'),
    );
    const payload = JSON.parse(mockPublish.mock.calls[0]![1] as string);
    expect(payload.data.tokenId).toBe('tok_1');
  });

  it('does not throw if Redis publish fails', async () => {
    mockPublish.mockRejectedValueOnce(new Error('Redis down'));

    await expect(
      emitEvent('dev_1', 'grant.revoked', { grantId: 'grnt_1' }),
    ).resolves.toBeUndefined();

    expect(mockEnqueue).toHaveBeenCalledOnce();
  });

  it('creates a unique event ID', async () => {
    await emitEvent('dev_1', 'grant.created', {});

    expect(mockEnqueue).toHaveBeenCalledWith('dev_1', expect.objectContaining({
      id: 'evt_TESTULID01',
    }));
  });

  it('includes ISO timestamp', async () => {
    const before = new Date().toISOString();
    await emitEvent('dev_1', 'grant.created', {});
    const after = new Date().toISOString();

    const event = mockEnqueue.mock.calls[0]![1] as { createdAt: string };
    expect(event.createdAt >= before).toBe(true);
    expect(event.createdAt <= after).toBe(true);
  });

  it('supports budget.threshold event type', async () => {
    await emitEvent('dev_1', 'budget.threshold', { grantId: 'grnt_1', pct: 80 });

    expect(mockEnqueue).toHaveBeenCalledWith('dev_1', expect.objectContaining({
      type: 'budget.threshold',
    }));
  });

  it('supports budget.exhausted event type', async () => {
    await emitEvent('dev_1', 'budget.exhausted', { grantId: 'grnt_1' });

    expect(mockEnqueue).toHaveBeenCalledWith('dev_1', expect.objectContaining({
      type: 'budget.exhausted',
    }));
  });

  it('passes event data through unchanged', async () => {
    const data = { grantId: 'grnt_1', scopes: ['read'], nested: { a: 1 } };
    await emitEvent('dev_1', 'grant.created', data);

    expect(mockEnqueue).toHaveBeenCalledWith('dev_1', expect.objectContaining({
      data,
    }));
  });
});
