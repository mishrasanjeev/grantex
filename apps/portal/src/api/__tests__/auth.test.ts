import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/constants', () => ({ API_BASE_URL: 'http://localhost:3000' }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function ok(data: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({ ok: true, status, json: () => Promise.resolve(data) });
}
function err(status: number, code: string, msg: string) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    statusText: msg,
    json: () => Promise.resolve({ code, message: msg }),
  });
}

import { getMe, signup, sendVerificationEmail, rotateKey } from '../auth';

describe('auth', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // ── getMe ──────────────────────────────────────────────────────────────

  it('getMe sends GET /v1/me and returns developer', async () => {
    const dev = { id: 'dev-1', name: 'Alice', email: 'alice@test.com' };
    ok(dev);
    const result = await getMe();
    expect(result).toEqual(dev);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/me', expect.objectContaining({ method: 'GET' }));
  });

  it('getMe throws on 401', async () => {
    err(401, 'UNAUTHORIZED', 'Invalid key');
    await expect(getMe()).rejects.toThrow('Invalid key');
  });

  // ── signup ─────────────────────────────────────────────────────────────

  it('signup sends POST /v1/signup with data', async () => {
    const req = { name: 'Bob', email: 'bob@test.com' };
    const resp = { developerId: 'dev-2', apiKey: 'key-123' };
    ok(resp);
    const result = await signup(req);
    expect(result).toEqual(resp);
    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('http://localhost:3000/v1/signup');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual(req);
  });

  it('signup throws on 409 conflict', async () => {
    err(409, 'CONFLICT', 'Email already registered');
    await expect(signup({ name: 'Bob', email: 'bob@test.com' } as any)).rejects.toThrow('Email already registered');
  });

  // ── sendVerificationEmail ──────────────────────────────────────────────

  it('sendVerificationEmail sends POST /v1/signup/verify', async () => {
    ok({ message: 'Verification email sent', expiresAt: '2026-04-04T00:00:00Z' });
    const result = await sendVerificationEmail('test@test.com');
    expect(result.message).toBe('Verification email sent');
    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('http://localhost:3000/v1/signup/verify');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ email: 'test@test.com' });
  });

  it('sendVerificationEmail throws on error', async () => {
    err(400, 'BAD_REQUEST', 'Invalid email');
    await expect(sendVerificationEmail('bad')).rejects.toThrow('Invalid email');
  });

  // ── rotateKey ──────────────────────────────────────────────────────────

  it('rotateKey sends POST /v1/keys/rotate', async () => {
    const resp = { apiKey: 'new-key-456' };
    ok(resp);
    const result = await rotateKey();
    expect(result).toEqual(resp);
    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('http://localhost:3000/v1/keys/rotate');
    expect(opts.method).toBe('POST');
  });

  it('rotateKey throws on 403', async () => {
    err(403, 'FORBIDDEN', 'Not allowed');
    await expect(rotateKey()).rejects.toThrow('Not allowed');
  });
});
