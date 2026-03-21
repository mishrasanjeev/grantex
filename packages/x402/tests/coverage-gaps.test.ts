/**
 * Tests covering all untested code paths identified in the coverage audit.
 * Organized by source file.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { issueGDT, parseExpiry } from '../src/gdt.js';
import { verifyGDT, decodeGDT } from '../src/verify.js';
import { generateKeyPair, importPrivateKey } from '../src/crypto.js';
import { createX402Agent, HEADERS } from '../src/agent.js';
import { x402Middleware } from '../src/middleware.js';
import { InMemoryRevocationRegistry, setRevocationRegistry } from '../src/revocation.js';
import { InMemoryAuditLog, setAuditLog, getAuditLog } from '../src/audit.js';
import { SignJWT } from 'jose';

describe('Coverage gaps — agent.ts', () => {
  beforeEach(() => {
    setAuditLog(new InMemoryAuditLog());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stub payment handler includes memo when present', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    // 402 with memo
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          amount: 0.001,
          currency: 'USDC',
          recipientAddress: '0xabc',
          chain: 'base',
          memo: 'weather-query-123',
        }),
        { status: 402, headers: { 'content-type': 'application/json' } },
      ),
    );
    mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }));

    // Use default stub handler (no custom paymentHandler)
    const agent = createX402Agent({ gdt: 'test' });
    await agent.fetch('https://api.example.com/data');

    // The retry should have a payment proof with memo embedded
    const retryHeaders = mockFetch.mock.calls[1]![1]!.headers as Headers;
    const proof = JSON.parse(Buffer.from(retryHeaders.get('X-Payment-Proof')!, 'base64url').toString());
    expect(proof.memo).toBe('weather-query-123');
  });

  it('falls back to header parsing when JSON body parsing fails', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    // 402 with content-type json but malformed body
    mockFetch.mockResolvedValueOnce(
      new Response('not json{{{', {
        status: 402,
        headers: {
          'content-type': 'application/json',
          'X-Payment-Amount': '0.005',
          'X-Payment-Currency': 'USDC',
          'X-Payment-Recipient': '0xfallback',
          'X-Payment-Chain': 'base',
        },
      }),
    );
    mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }));

    const paymentHandler = vi.fn().mockResolvedValue('proof');
    const agent = createX402Agent({ gdt: 'test', paymentHandler });
    await agent.fetch('https://api.example.com/data');

    expect(paymentHandler).toHaveBeenCalledWith(
      expect.objectContaining({ recipientAddress: '0xfallback', amount: 0.005 }),
    );
  });

  it('throws when 402 response has no recipient header', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    mockFetch.mockResolvedValueOnce(
      new Response(null, {
        status: 402,
        headers: { 'X-Payment-Amount': '0.001' },
      }),
    );

    const agent = createX402Agent({ gdt: 'test' });
    await expect(agent.fetch('https://api.example.com/data')).rejects.toThrow(
      '402 response missing X-Payment-Recipient header',
    );
  });

  it('handles payment handler throwing an error', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    mockFetch.mockResolvedValueOnce(
      new Response(null, {
        status: 402,
        headers: {
          'X-Payment-Amount': '0.001',
          'X-Payment-Currency': 'USDC',
          'X-Payment-Recipient': '0xrecipient',
          'X-Payment-Chain': 'base',
        },
      }),
    );

    const agent = createX402Agent({
      gdt: 'test',
      paymentHandler: async () => { throw new Error('wallet locked'); },
    });

    await expect(agent.fetch('https://api.example.com/data')).rejects.toThrow('wallet locked');
  });

  it('preserves HTTP method on 402 retry', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    mockFetch.mockResolvedValueOnce(
      new Response(null, {
        status: 402,
        headers: {
          'X-Payment-Amount': '0.001',
          'X-Payment-Currency': 'USDC',
          'X-Payment-Recipient': '0xrecipient',
          'X-Payment-Chain': 'base',
        },
      }),
    );
    mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }));

    const agent = createX402Agent({ gdt: 'test', paymentHandler: async () => 'proof' });
    await agent.fetch('https://api.example.com/data', { method: 'POST' });

    expect(mockFetch.mock.calls[1]![1]!.method).toBe('POST');
  });
});

describe('Coverage gaps — verify.ts error messages', () => {
  let principal: ReturnType<typeof generateKeyPair>;
  let agent: ReturnType<typeof generateKeyPair>;

  beforeEach(() => {
    setRevocationRegistry(new InMemoryRevocationRegistry());
    setAuditLog(new InMemoryAuditLog());
    principal = generateKeyPair();
    agent = generateKeyPair();
  });

  it('returns exact error for garbage JWT', async () => {
    const result = await verifyGDT('xxx', { resource: 'a:b', amount: 0, currency: 'USDC' });
    expect(result.error).toBe('Invalid JWT: unable to decode token');
  });

  it('returns exact error for missing claims', async () => {
    // Create a JWT with no iss/sub/jti
    const key = await importPrivateKey(principal.privateKey, principal.publicKey);
    const token = await new SignJWT({} as never)
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
      .setExpirationTime('1h')
      .sign(key);

    const result = await verifyGDT(token, { resource: 'a:b', amount: 0, currency: 'USDC' });
    expect(result.error).toBe('Invalid GDT: missing required claims (iss, sub, jti)');
  });

  it('returns exact error for scope mismatch', async () => {
    const token = await issueGDT({
      agentDID: agent.did, scope: ['weather:read'],
      spendLimit: { amount: 10, currency: 'USDC', period: '24h' },
      expiry: '24h', signingKey: principal.privateKey,
    });
    const result = await verifyGDT(token, { resource: 'finance:read', amount: 0.001, currency: 'USDC' });
    expect(result.error).toContain('Scope mismatch');
    expect(result.error).toContain('finance:read');
    expect(result.error).toContain('weather:read');
  });

  it('returns exact error for currency mismatch', async () => {
    const token = await issueGDT({
      agentDID: agent.did, scope: ['weather:read'],
      spendLimit: { amount: 10, currency: 'USDC', period: '24h' },
      expiry: '24h', signingKey: principal.privateKey,
    });
    const result = await verifyGDT(token, { resource: 'weather:read', amount: 0.001, currency: 'USDT' });
    expect(result.error).toContain('Currency mismatch');
    expect(result.error).toContain('USDT');
    expect(result.error).toContain('USDC');
  });

  it('returns exact error for spend limit exceeded', async () => {
    const token = await issueGDT({
      agentDID: agent.did, scope: ['weather:read'],
      spendLimit: { amount: 10, currency: 'USDC', period: '24h' },
      expiry: '24h', signingKey: principal.privateKey,
    });
    const result = await verifyGDT(token, { resource: 'weather:read', amount: 50, currency: 'USDC' });
    expect(result.error).toContain('Spend limit exceeded');
    expect(result.error).toContain('50');
    expect(result.error).toContain('10');
  });

  it('returns exact error for revoked token', async () => {
    const token = await issueGDT({
      agentDID: agent.did, scope: ['weather:read'],
      spendLimit: { amount: 10, currency: 'USDC', period: '24h' },
      expiry: '24h', signingKey: principal.privateKey,
    });
    const decoded = decodeGDT(token);
    const registry = new InMemoryRevocationRegistry();
    setRevocationRegistry(registry);
    await registry.revoke(decoded.jti);

    const result = await verifyGDT(token, { resource: 'weather:read', amount: 0.001, currency: 'USDC' });
    expect(result.error).toBe('Token has been revoked');
  });

  it('returns signature verification failed for wrong key', async () => {
    const attacker = generateKeyPair();
    const token = await issueGDT({
      agentDID: agent.did, scope: ['weather:read'],
      spendLimit: { amount: 10, currency: 'USDC', period: '24h' },
      expiry: '24h', signingKey: attacker.privateKey, principalDID: principal.did,
    });
    const result = await verifyGDT(token, { resource: 'weather:read', amount: 0.001, currency: 'USDC' });
    expect(result.error).toContain('Signature verification failed');
  });
});

describe('Coverage gaps — gdt.ts error messages', () => {
  const principal = generateKeyPair();
  const agent = generateKeyPair();

  it('rejects agentDID not starting with did:', async () => {
    await expect(issueGDT({
      agentDID: 'not-a-did', scope: ['a:b'],
      spendLimit: { amount: 1, currency: 'USDC', period: '24h' },
      expiry: '24h', signingKey: principal.privateKey,
    })).rejects.toThrow('agentDID must be a valid DID string');
  });

  it('rejects empty agentDID', async () => {
    await expect(issueGDT({
      agentDID: '', scope: ['a:b'],
      spendLimit: { amount: 1, currency: 'USDC', period: '24h' },
      expiry: '24h', signingKey: principal.privateKey,
    })).rejects.toThrow('agentDID must be a valid DID string');
  });

  it('rejects empty scope with exact message', async () => {
    await expect(issueGDT({
      agentDID: agent.did, scope: [],
      spendLimit: { amount: 1, currency: 'USDC', period: '24h' },
      expiry: '24h', signingKey: principal.privateKey,
    })).rejects.toThrow('scope must be a non-empty array');
  });

  it('rejects zero spend limit with exact message', async () => {
    await expect(issueGDT({
      agentDID: agent.did, scope: ['a:b'],
      spendLimit: { amount: 0, currency: 'USDC', period: '24h' },
      expiry: '24h', signingKey: principal.privateKey,
    })).rejects.toThrow('spendLimit.amount must be positive');
  });

  it('rejects wrong key length with exact message', async () => {
    await expect(issueGDT({
      agentDID: agent.did, scope: ['a:b'],
      spendLimit: { amount: 1, currency: 'USDC', period: '24h' },
      expiry: '24h', signingKey: new Uint8Array(16),
    })).rejects.toThrow('signingKey must be a 32-byte Ed25519 private key seed');
  });

  it('parseExpiry rejects invalid format with descriptive message', () => {
    expect(() => parseExpiry('banana')).toThrow('Invalid expiry format');
  });

  it('parseExpiry handles lowercase PT24H', () => {
    const now = Math.floor(Date.now() / 1000);
    const exp = parseExpiry('pt24h');
    expect(exp - now).toBeCloseTo(86400, -1);
  });

  it('parseExpiry parses date-only format', () => {
    const exp = parseExpiry('2030-06-15');
    expect(exp).toBe(Math.floor(new Date('2030-06-15').getTime() / 1000));
  });

  it('parseExpiry rejects invalid datetime', () => {
    expect(() => parseExpiry('2030-13-99')).toThrow('Invalid expiry datetime');
  });
});

describe('Coverage gaps — middleware.ts', () => {
  let validToken: string;

  beforeEach(async () => {
    setRevocationRegistry(new InMemoryRevocationRegistry());
    setAuditLog(new InMemoryAuditLog());
    const principal = generateKeyPair();
    const agent = generateKeyPair();
    validToken = await issueGDT({
      agentDID: agent.did, scope: ['weather:read'],
      spendLimit: { amount: 10, currency: 'USDC', period: '24h' },
      expiry: '24h', signingKey: principal.privateKey,
    });
  });

  it('reads GDT from lowercase header', async () => {
    const middleware = x402Middleware({ requiredScopes: ['weather:read'], extractAmount: () => 0.001 });
    const req = {
      headers: { 'x-grantex-gdt': validToken },
      path: '/api/weather', method: 'GET',
      get(name: string) { return (this.headers as Record<string, string>)[name.toLowerCase()]; },
    };
    const res = { statusCode: 200, body: null as unknown, status(c: number) { res.statusCode = c; return res; }, json(b: unknown) { res.body = b; } };
    const next = vi.fn();

    await middleware(req as never, res as never, next);
    expect(next).toHaveBeenCalled();
  });

  it('defaults amount to 0 when no header and no extractAmount', async () => {
    const middleware = x402Middleware({ requiredScopes: ['weather:read'] });
    const req = {
      headers: { 'x-grantex-gdt': validToken },
      path: '/api/weather', method: 'GET',
      get(name: string) { return (this.headers as Record<string, string>)[name.toLowerCase()]; },
    };
    const res = { statusCode: 200, body: null as unknown, status(c: number) { res.statusCode = c; return res; }, json(b: unknown) { res.body = b; } };
    const next = vi.fn();

    await middleware(req as never, res as never, next);
    expect(next).toHaveBeenCalled();
    const gdt = (req as Record<string, unknown>)['gdt'] as Record<string, unknown>;
    expect(gdt['remainingLimit']).toBe(10); // 10 - 0 = 10
  });

  it('derives resource scope from POST method as write', async () => {
    const principal = generateKeyPair();
    const agent = generateKeyPair();
    const token = await issueGDT({
      agentDID: agent.did, scope: ['weather:write'],
      spendLimit: { amount: 10, currency: 'USDC', period: '24h' },
      expiry: '24h', signingKey: principal.privateKey,
    });

    const middleware = x402Middleware({ extractAmount: () => 0 });
    const req = {
      headers: { 'x-grantex-gdt': token },
      path: '/api/weather/update', method: 'POST',
      get(name: string) { return (this.headers as Record<string, string>)[name.toLowerCase()]; },
    };
    const res = { statusCode: 200, body: null as unknown, status(c: number) { res.statusCode = c; return res; }, json(b: unknown) { res.body = b; } };
    const next = vi.fn();

    await middleware(req as never, res as never, next);
    expect(next).toHaveBeenCalled();
  });

  it('derives resource as unknown for path /api/', async () => {
    const principal = generateKeyPair();
    const agent = generateKeyPair();
    const token = await issueGDT({
      agentDID: agent.did, scope: ['unknown:read'],
      spendLimit: { amount: 10, currency: 'USDC', period: '24h' },
      expiry: '24h', signingKey: principal.privateKey,
    });

    const middleware = x402Middleware({ extractAmount: () => 0 });
    const req = {
      headers: { 'x-grantex-gdt': token },
      path: '/api/', method: 'GET',
      get(name: string) { return (this.headers as Record<string, string>)[name.toLowerCase()]; },
    };
    const res = { statusCode: 200, body: null as unknown, status(c: number) { res.statusCode = c; return res; }, json(b: unknown) { res.body = b; } };
    const next = vi.fn();

    // /api/ has no segment after 'api', so resource = 'unknown:read'
    await middleware(req as never, res as never, next);
    expect(next).toHaveBeenCalled();
  });

  it('handles verifyFn that throws', async () => {
    const middleware = x402Middleware({
      requiredScopes: ['weather:read'],
      verifyFn: async () => { throw new Error('boom'); },
    });
    const req = {
      headers: { 'x-grantex-gdt': 'any-token' },
      path: '/api/weather', method: 'GET',
      get(name: string) { return (this.headers as Record<string, string>)[name.toLowerCase()]; },
    };
    const res = { statusCode: 200, body: null as unknown, status(c: number) { res.statusCode = c; return res; }, json(b: unknown) { res.body = b; } };
    const next = vi.fn();

    await middleware(req as never, res as never, next);
    expect(res.statusCode).toBe(403);
    expect((res.body as Record<string, unknown>)['error']).toBe('GDT_VERIFICATION_ERROR');
  });
});

describe('Coverage gaps — audit.ts edge cases', () => {
  it('query with limit=0 returns all entries', async () => {
    const log = new InMemoryAuditLog();
    for (let i = 0; i < 5; i++) {
      await log.log({ eventType: 'issuance', agentDID: 'a', principalDID: 'p', scope: [], tokenId: `t-${i}` });
    }
    const results = await log.query({ limit: 0 });
    // limit 0 is falsy, so no slicing happens
    expect(results.length).toBe(5);
  });

  it('query with both eventType and agentDID filters', async () => {
    const log = new InMemoryAuditLog();
    await log.log({ eventType: 'issuance', agentDID: 'agent1', principalDID: 'p', scope: [], tokenId: 't1' });
    await log.log({ eventType: 'verification', agentDID: 'agent1', principalDID: 'p', scope: [], tokenId: 't2' });
    await log.log({ eventType: 'issuance', agentDID: 'agent2', principalDID: 'p', scope: [], tokenId: 't3' });

    const results = await log.query({ eventType: 'issuance', agentDID: 'agent1' });
    expect(results).toHaveLength(1);
    expect(results[0]!.tokenId).toBe('t1');
  });
});

describe('Coverage gaps — revocation edge cases', () => {
  it('revoke with empty string reason', async () => {
    const registry = new InMemoryRevocationRegistry();
    await registry.revoke('token-1', '');
    const list = await registry.listRevoked();
    expect(list[0]!.reason).toBe('');
  });
});
