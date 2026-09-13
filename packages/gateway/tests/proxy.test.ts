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

    const headers = fetchCall[1]?.headers as Headers;
    expect(headers.get('X-Grantex-Principal')).toBe('user_1');
    expect(headers.get('X-Grantex-Agent')).toBe('did:grantex:agent:a1');
    expect(headers.get('X-Grantex-GrantId')).toBe('grnt_1');
    // Authorization should be stripped
    expect(headers.get('authorization')).toBeNull();
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

    const headers = vi.mocked(fetch).mock.calls[0]![1]?.headers as Headers;
    expect(headers.get('X-Internal-Auth')).toBe('secret-key');
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

  it('forwards a non-JSON body verbatim instead of re-encoding it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      headers: { entries: () => [].values() },
      text: () => Promise.resolve(''),
    }));

    // The `*` content-type parser hands non-JSON bodies through as raw strings.
    const req = mockReq({
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'summary=Meeting&when=today',
    });
    await proxyRequest(req, mockReply(), MOCK_GRANT, {
      upstream: 'https://api.internal.com',
    });

    const body = vi.mocked(fetch).mock.calls[0]![1]?.body;
    expect(body).toBe('summary=Meeting&when=today');
    // JSON.stringify would have produced a quoted, escaped string.
    expect(body).not.toBe('"summary=Meeting&when=today"');
  });

  it('does not forward a content-length that describes the original body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      headers: { entries: () => [].values() },
      text: () => Promise.resolve(''),
    }));

    const req = mockReq({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': '9999',
      },
      body: { summary: 'Meeting' },
    });
    await proxyRequest(req, mockReply(), MOCK_GRANT, {
      upstream: 'https://api.internal.com',
    });

    const headers = vi.mocked(fetch).mock.calls[0]![1]?.headers as Headers;
    // fetch derives the length from what it actually sends.
    expect(headers.get('content-length')).toBeNull();
  });

  it('relays a binary body byte for byte', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      headers: { entries: () => [].values() },
      text: () => Promise.resolve(''),
    }));

    // Bytes that are not valid UTF-8. Decoding them to a string would replace
    // each with U+FFFD and the original could never be recovered.
    const binary = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x00, 0x80]);
    const req = mockReq({
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip' },
      body: binary,
    });
    await proxyRequest(req, mockReply(), MOCK_GRANT, {
      upstream: 'https://api.internal.com',
    });

    const sent = vi.mocked(fetch).mock.calls[0]![1]?.body;
    expect(Buffer.isBuffer(sent)).toBe(true);
    expect(Buffer.compare(sent as Buffer, binary)).toBe(0);
    expect(Buffer.from(String(sent), 'utf-8').equals(binary)).toBe(false);
  });

  it('forwards content-encoding, because the body is relayed unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      headers: { entries: () => [].values() },
      text: () => Promise.resolve(''),
    }));

    const req = mockReq({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: Buffer.from([0x1f, 0x8b, 0x08]),
    });
    await proxyRequest(req, mockReply(), MOCK_GRANT, {
      upstream: 'https://api.internal.com',
    });

    const headers = vi.mocked(fetch).mock.calls[0]![1]?.headers as Headers;
    // Dropping this would leave the upstream unable to decode the payload.
    expect(headers.get('content-encoding')).toBe('gzip');
  });

  it('strips hop-by-hop request headers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      headers: { entries: () => [].values() },
      text: () => Promise.resolve(''),
    }));

    const req = mockReq({
      headers: {
        'content-type': 'application/json',
        connection: 'keep-alive',
        'transfer-encoding': 'chunked',
        'proxy-authorization': 'Basic abc',
        upgrade: 'websocket',
        'x-custom': 'kept',
      },
    });
    await proxyRequest(req, mockReply(), MOCK_GRANT, {
      upstream: 'https://api.internal.com',
    });

    const headers = vi.mocked(fetch).mock.calls[0]![1]?.headers as Headers;
    expect(headers.get('connection')).toBeNull();
    expect(headers.get('transfer-encoding')).toBeNull();
    expect(headers.get('proxy-authorization')).toBeNull();
    expect(headers.get('upgrade')).toBeNull();
    expect(headers.get('x-custom')).toBe('kept');
  });

  it('drops upstream content-encoding and content-length from the response', async () => {
    // fetch already decoded the body, so the declared encoding and length no
    // longer describe what the client receives.
    const responseHeaders = new Map([
      ['content-type', 'application/json'],
      ['content-encoding', 'gzip'],
      ['content-length', '42'],
      ['x-upstream', 'kept'],
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      headers: { entries: () => responseHeaders.entries() },
      text: () => Promise.resolve('{"data":"decoded plaintext"}'),
    }));

    const reply = mockReply();
    await proxyRequest(mockReq(), reply, MOCK_GRANT, {
      upstream: 'https://api.internal.com',
    });

    const forwarded = (reply as unknown as { headers: Record<string, string> }).headers;
    expect(forwarded['content-encoding']).toBeUndefined();
    expect(forwarded['content-length']).toBeUndefined();
    expect(forwarded['content-type']).toBe('application/json');
    expect(forwarded['x-upstream']).toBe('kept');
  });

  it('a client cannot spoof the Grantex context headers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      headers: { entries: () => [].values() },
      text: () => Promise.resolve(''),
    }));

    // Node lower-cases inbound header names, so a spoof arrives exactly like
    // this; the old plain-object build kept it as a second key that fetch
    // merged into `user_attacker, user_1`.
    const req = mockReq({
      headers: {
        'content-type': 'application/json',
        'x-grantex-principal': 'user_attacker',
        'x-grantex-agent': 'did:grantex:agent:attacker',
        'x-grantex-grantid': 'grnt_attacker',
        'x-grantex-role': 'admin',
      },
    });
    await proxyRequest(req, mockReply(), MOCK_GRANT, {
      upstream: 'https://api.internal.com',
    });

    const headers = vi.mocked(fetch).mock.calls[0]![1]?.headers;
    expect(headers).toBeInstanceOf(Headers);
    const sent = headers as Headers;
    expect(sent.get('x-grantex-principal')).toBe('user_1');
    expect(sent.get('x-grantex-agent')).toBe('did:grantex:agent:a1');
    expect(sent.get('x-grantex-grantid')).toBe('grnt_1');
    // Anything else in the reserved namespace is dropped, not relayed.
    expect(sent.get('x-grantex-role')).toBeNull();
    expect(sent.get('content-type')).toBe('application/json');
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
