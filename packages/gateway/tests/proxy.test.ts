import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VerifiedGrant } from '@grantex/sdk';
import { proxyRequest } from '../src/proxy.js';
import { GatewayError } from '../src/errors.js';

const MOCK_GRANT: VerifiedGrant = {
  tokenId: 'tok_1', grantId: 'grnt_1', principalId: 'user_1',
  agentDid: 'did:grantex:agent:a1', developerId: 'dev_1',
  scopes: ['calendar:read'],
  issuedAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

function mockReq(overrides: Record<string, unknown> = {}) {
  return {
    url: '/calendar/events',
    method: 'GET',
    headers: { 'content-type': 'application/json', authorization: 'Bearer xxx' },
    body: undefined,
    ...overrides,
  } as never;
}

function mockReply() {
  const r = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) { r.statusCode = code; return r; },
    header(key: string, value: string) { r.headers[key] = value; return r; },
    send(body: unknown) { r.body = body; return r; },
  };
  return r as never;
}

describe('proxyRequest', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('proxies GET request to upstream', async () => {
    const responseHeaders = new Map([['content-type', 'application/json']]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      headers: { entries: () => responseHeaders.entries() },
      text: () => Promise.resolve('{"data":"ok"}'),
    }));

    const req = mockReq();
    const reply = mockReply();

    await proxyRequest(req, reply, MOCK_GRANT, {
      upstream: 'https://api.internal.com',
    });

    const fetchCall = vi.mocked(fetch).mock.calls[0]!;
    expect(fetchCall[0]).toBe('https://api.internal.com/calendar/events');

    const headers = fetchCall[1]?.headers as Record<string, string>;
    expect(headers['X-Grantex-Principal']).toBe('user_1');
    expect(headers['X-Grantex-Agent']).toBe('did:grantex:agent:a1');
    expect(headers['X-Grantex-GrantId']).toBe('grnt_1');
    // Authorization should be stripped
    expect(headers['authorization']).toBeUndefined();
  });

  it('adds upstream headers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      headers: { entries: () => [].values() },
      text: () => Promise.resolve(''),
    }));

    await proxyRequest(mockReq(), mockReply(), MOCK_GRANT, {
      upstream: 'https://api.internal.com',
      upstreamHeaders: { 'X-Internal-Auth': 'secret-key' },
    });

    const headers = vi.mocked(fetch).mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers['X-Internal-Auth']).toBe('secret-key');
  });

  it('strips trailing slash from upstream', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      headers: { entries: () => [].values() },
      text: () => Promise.resolve(''),
    }));

    await proxyRequest(mockReq(), mockReply(), MOCK_GRANT, {
      upstream: 'https://api.internal.com/',
    });

    const url = vi.mocked(fetch).mock.calls[0]![0] as string;
    expect(url).toBe('https://api.internal.com/calendar/events');
  });

  it('forwards upstream status code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 201,
      headers: { entries: () => [].values() },
      text: () => Promise.resolve('{"created":true}'),
    }));

    const reply = mockReply();
    await proxyRequest(mockReq(), reply, MOCK_GRANT, {
      upstream: 'https://api.internal.com',
    });

    expect((reply as { statusCode: number }).statusCode).toBe(201);
  });

  it('forwards POST body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      headers: { entries: () => [].values() },
      text: () => Promise.resolve(''),
    }));

    const req = mockReq({ method: 'POST', body: { summary: 'Meeting' } });
    await proxyRequest(req, mockReply(), MOCK_GRANT, {
      upstream: 'https://api.internal.com',
    });

    const fetchCall = vi.mocked(fetch).mock.calls[0]!;
    expect(fetchCall[1]?.body).toBe(JSON.stringify({ summary: 'Meeting' }));
  });

  it('throws UPSTREAM_ERROR on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    await expect(
      proxyRequest(mockReq(), mockReply(), MOCK_GRANT, {
        upstream: 'https://api.internal.com',
      }),
    ).rejects.toThrow(GatewayError);
  });

  it('does not send body for GET requests', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      headers: { entries: () => [].values() },
      text: () => Promise.resolve(''),
    }));

    await proxyRequest(mockReq(), mockReply(), MOCK_GRANT, {
      upstream: 'https://api.internal.com',
    });

    const fetchCall = vi.mocked(fetch).mock.calls[0]!;
    expect(fetchCall[1]?.body).toBeUndefined();
  });
});
