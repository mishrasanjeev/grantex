import { describe, it, expect, vi, afterEach } from 'vitest';
import { Grantex } from '../src/client.js';

function makeFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

describe('DomainsClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('create() POSTs to /v1/domains', async () => {
    const createResponse = {
      id: 'dom_01',
      domain: 'example.com',
      verified: false,
      verificationToken: 'gx-verify-abc123',
      instructions: 'Add a TXT record...',
    };
    const mockFetch = makeFetch(201, createResponse);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.domains.create({ domain: 'example.com' });

    expect(result.id).toBe('dom_01');
    expect(result.domain).toBe('example.com');
    expect(result.verified).toBe(false);
    expect(result.verificationToken).toBe('gx-verify-abc123');

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/domains$/);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.domain).toBe('example.com');
  });

  it('list() GETs /v1/domains', async () => {
    const listResponse = {
      domains: [
        {
          id: 'dom_01',
          domain: 'example.com',
          verified: true,
          verifiedAt: '2026-03-01T00:00:00Z',
          createdAt: '2026-02-28T00:00:00Z',
        },
      ],
    };
    const mockFetch = makeFetch(200, listResponse);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.domains.list();

    expect(result.domains).toHaveLength(1);
    expect(result.domains[0]!.domain).toBe('example.com');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/domains$/);
    expect(init.method).toBe('GET');
  });

  it('verify() POSTs to /v1/domains/:id/verify', async () => {
    const verifyResponse = { verified: true, message: 'Domain verified successfully' };
    const mockFetch = makeFetch(200, verifyResponse);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.domains.verify('dom_01');

    expect(result.verified).toBe(true);
    expect(result.message).toBe('Domain verified successfully');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/domains\/dom_01\/verify$/);
    expect(init.method).toBe('POST');
  });

  it('delete() DELETEs /v1/domains/:id', async () => {
    const mockFetch = makeFetch(204, null);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    await expect(grantex.domains.delete('dom_01')).resolves.toBeUndefined();

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/domains\/dom_01$/);
    expect(init.method).toBe('DELETE');
  });
});
