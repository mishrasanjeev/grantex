import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/constants', () => ({ API_BASE_URL: 'http://localhost:3000' }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function ok(data: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({ ok: true, status, json: () => Promise.resolve(data) });
}
function noContent() {
  mockFetch.mockResolvedValueOnce({ ok: true, status: 204, json: () => Promise.resolve(undefined) });
}
function err(status: number, code: string, msg: string) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    statusText: msg,
    json: () => Promise.resolve({ code, message: msg }),
  });
}

import { listWebhooks, createWebhook, deleteWebhook, listDeliveries } from '../webhooks';

describe('webhooks', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // ── listWebhooks ──────────────────────────────────────────────────────

  it('listWebhooks sends GET /v1/webhooks and unwraps .webhooks', async () => {
    ok({ webhooks: [{ id: 'wh1', url: 'https://example.com/hook', events: ['grant.created'] }] });
    const result = await listWebhooks();
    expect(result).toEqual([{ id: 'wh1', url: 'https://example.com/hook', events: ['grant.created'] }]);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/webhooks', expect.objectContaining({ method: 'GET' }));
  });

  it('listWebhooks throws on error', async () => {
    err(500, 'INTERNAL', 'Failed');
    await expect(listWebhooks()).rejects.toThrow('Failed');
  });

  // ── createWebhook ─────────────────────────────────────────────────────

  it('createWebhook sends POST /v1/webhooks with url and events', async () => {
    const data = { url: 'https://example.com/hook', events: ['grant.created', 'grant.revoked'] };
    const resp = { id: 'wh2', ...data, secret: 'whsec_123', createdAt: '2026-04-01' };
    ok(resp);
    const result = await createWebhook(data);
    expect(result).toEqual(resp);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/v1/webhooks');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual(data);
  });

  it('createWebhook throws on 400', async () => {
    err(400, 'VALIDATION', 'URL required');
    await expect(createWebhook({ url: '', events: [] })).rejects.toThrow('URL required');
  });

  // ── deleteWebhook ─────────────────────────────────────────────────────

  it('deleteWebhook sends DELETE /v1/webhooks/:id', async () => {
    noContent();
    await deleteWebhook('wh1');
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/webhooks/wh1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('deleteWebhook encodes id', async () => {
    noContent();
    await deleteWebhook('wh/1');
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3000/v1/webhooks/wh%2F1');
  });

  it('deleteWebhook throws on error', async () => {
    err(404, 'NOT_FOUND', 'Webhook not found');
    await expect(deleteWebhook('missing')).rejects.toThrow('Webhook not found');
  });

  // ── listDeliveries ────────────────────────────────────────────────────

  it('listDeliveries sends GET /v1/webhooks/:id/deliveries without opts', async () => {
    const data = { deliveries: [], total: 0, page: 1, pageSize: 20 };
    ok(data);
    const result = await listDeliveries('wh1');
    expect(result).toEqual(data);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/v1/webhooks/wh1/deliveries',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('listDeliveries with page and pageSize', async () => {
    ok({ deliveries: [], total: 0, page: 2, pageSize: 10 });
    await listDeliveries('wh1', { page: 2, pageSize: 10 });
    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain('page=2');
    expect(url).toContain('pageSize=10');
  });

  it('listDeliveries with status filter', async () => {
    ok({ deliveries: [], total: 0, page: 1, pageSize: 20 });
    await listDeliveries('wh1', { status: 'failed' });
    expect(mockFetch.mock.calls[0][0]).toContain('status=failed');
  });

  it('listDeliveries encodes webhookId', async () => {
    ok({ deliveries: [], total: 0, page: 1, pageSize: 20 });
    await listDeliveries('wh/1');
    expect(mockFetch.mock.calls[0][0]).toContain('/v1/webhooks/wh%2F1/deliveries');
  });

  it('listDeliveries throws on error', async () => {
    err(404, 'NOT_FOUND', 'Webhook not found');
    await expect(listDeliveries('missing')).rejects.toThrow('Webhook not found');
  });
});
