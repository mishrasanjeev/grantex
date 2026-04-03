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

import { api, ApiError, setApiKey, getApiKey } from '../client';

describe('client', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    setApiKey(null);
  });

  // ── setApiKey / getApiKey ──────────────────────────────────────────────

  it('getApiKey returns null by default', () => {
    expect(getApiKey()).toBeNull();
  });

  it('setApiKey stores key and getApiKey retrieves it', () => {
    setApiKey('test-key-123');
    expect(getApiKey()).toBe('test-key-123');
  });

  it('setApiKey(null) clears the key', () => {
    setApiKey('key');
    setApiKey(null);
    expect(getApiKey()).toBeNull();
  });

  // ── api.get ────────────────────────────────────────────────────────────

  it('api.get sends GET request with correct URL', async () => {
    ok({ foo: 'bar' });
    const result = await api.get('/v1/test');
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/test', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: undefined,
    });
    expect(result).toEqual({ foo: 'bar' });
  });

  it('api.get includes Authorization header when api key is set', async () => {
    setApiKey('my-key');
    ok({ data: 1 });
    await api.get('/v1/secure');
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/secure', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer my-key',
      },
      body: undefined,
    });
  });

  // ── api.post ───────────────────────────────────────────────────────────

  it('api.post sends POST with JSON body', async () => {
    ok({ id: '1' });
    const result = await api.post('/v1/items', { name: 'test' });
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test' }),
    });
    expect(result).toEqual({ id: '1' });
  });

  it('api.post sends POST without body when body is undefined', async () => {
    ok({ ok: true });
    await api.post('/v1/action');
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: undefined,
    });
  });

  // ── api.patch ──────────────────────────────────────────────────────────

  it('api.patch sends PATCH with body', async () => {
    ok({ updated: true });
    await api.patch('/v1/items/1', { name: 'updated' });
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/items/1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'updated' }),
    });
  });

  // ── api.put ────────────────────────────────────────────────────────────

  it('api.put sends PUT with body', async () => {
    ok({ replaced: true });
    await api.put('/v1/items/1', { name: 'replaced' });
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/items/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'replaced' }),
    });
  });

  // ── api.del ────────────────────────────────────────────────────────────

  it('api.del sends DELETE request and returns undefined for 204', async () => {
    noContent();
    const result = await api.del('/v1/items/1');
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/items/1', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: undefined,
    });
    expect(result).toBeUndefined();
  });

  // ── Error handling ─────────────────────────────────────────────────────

  it('throws ApiError on non-ok response', async () => {
    err(401, 'UNAUTHORIZED', 'Invalid API key');
    await expect(api.get('/v1/me')).rejects.toThrow(ApiError);
    try {
      err(401, 'UNAUTHORIZED', 'Invalid API key');
      await api.get('/v1/me');
    } catch (e) {
      const error = e as ApiError;
      expect(error.status).toBe(401);
      expect(error.code).toBe('UNAUTHORIZED');
      expect(error.message).toBe('Invalid API key');
      expect(error.name).toBe('ApiError');
    }
  });

  it('uses UNKNOWN code when error json has no code', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: () => Promise.resolve({ message: 'something broke' }),
    });
    try {
      await api.get('/v1/fail');
    } catch (e) {
      const error = e as ApiError;
      expect(error.code).toBe('UNKNOWN');
      expect(error.message).toBe('something broke');
    }
  });

  it('falls back to statusText when json parsing fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: () => Promise.reject(new Error('not json')),
    });
    try {
      await api.get('/v1/fail');
    } catch (e) {
      const error = e as ApiError;
      expect(error.code).toBe('UNKNOWN');
      expect(error.message).toBe('Bad Gateway');
    }
  });
});
