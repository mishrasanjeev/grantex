import { describe, it, expect, beforeEach, vi } from 'vitest';
import { x402Middleware } from '../src/middleware.js';
import { issueGDT } from '../src/gdt.js';
import { generateKeyPair } from '../src/crypto.js';
import { InMemoryRevocationRegistry, setRevocationRegistry } from '../src/revocation.js';
import { InMemoryAuditLog, setAuditLog } from '../src/audit.js';
import type { IssueGDTParams } from '../src/types.js';

// Mock Express request/response
function mockReq(headers: Record<string, string> = {}, path = '/api/weather/forecast', method = 'GET') {
  const normalised: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    normalised[k.toLowerCase()] = v;
  }
  return {
    headers: normalised,
    path,
    method,
    get(name: string): string | undefined {
      return normalised[name.toLowerCase()];
    },
  };
}

function mockRes() {
  const res: {
    statusCode: number;
    body: unknown;
    status: (code: number) => typeof res;
    json: (body: unknown) => void;
  } = {
    statusCode: 200,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
    },
  };
  return res;
}

describe('x402Middleware', () => {
  let principal: ReturnType<typeof generateKeyPair>;
  let agent: ReturnType<typeof generateKeyPair>;
  let baseParams: IssueGDTParams;
  let validToken: string;

  beforeEach(async () => {
    setRevocationRegistry(new InMemoryRevocationRegistry());
    setAuditLog(new InMemoryAuditLog());

    principal = generateKeyPair();
    agent = generateKeyPair();
    baseParams = {
      agentDID: agent.did,
      scope: ['weather:read'],
      spendLimit: { amount: 10, currency: 'USDC', period: '24h' },
      expiry: '24h',
      signingKey: principal.privateKey,
    };
    validToken = await issueGDT(baseParams);
  });

  describe('required mode (default)', () => {
    it('rejects requests without GDT header', async () => {
      const middleware = x402Middleware({ requiredScopes: ['weather:read'] });
      const req = mockReq();
      const res = mockRes();
      const next = vi.fn();

      await middleware(req as never, res as never, next);

      expect(res.statusCode).toBe(403);
      expect((res.body as Record<string, unknown>)['error']).toBe('MISSING_GDT');
      expect(next).not.toHaveBeenCalled();
    });

    it('passes valid GDT requests', async () => {
      const middleware = x402Middleware({ requiredScopes: ['weather:read'] });
      const req = mockReq({ 'X-Grantex-GDT': validToken, 'X-Payment-Amount': '0.001' });
      const res = mockRes();
      const next = vi.fn();

      await middleware(req as never, res as never, next);

      expect(next).toHaveBeenCalled();
      expect((req as Record<string, unknown>)['gdt']).toBeDefined();
    });

    it('rejects invalid GDT tokens', async () => {
      const middleware = x402Middleware({ requiredScopes: ['weather:read'] });
      const req = mockReq({ 'X-Grantex-GDT': 'invalid.jwt.token' });
      const res = mockRes();
      const next = vi.fn();

      await middleware(req as never, res as never, next);

      expect(res.statusCode).toBe(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects wrong scope', async () => {
      const middleware = x402Middleware({ requiredScopes: ['finance:read'] });
      const req = mockReq({ 'X-Grantex-GDT': validToken, 'X-Payment-Amount': '0.001' });
      const res = mockRes();
      const next = vi.fn();

      await middleware(req as never, res as never, next);

      expect(res.statusCode).toBe(403);
      expect((res.body as Record<string, unknown>)['error']).toBe('INVALID_GDT');
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects spend limit exceeded', async () => {
      const middleware = x402Middleware({ requiredScopes: ['weather:read'] });
      const req = mockReq({ 'X-Grantex-GDT': validToken, 'X-Payment-Amount': '50' });
      const res = mockRes();
      const next = vi.fn();

      await middleware(req as never, res as never, next);

      expect(res.statusCode).toBe(403);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('optional mode', () => {
    it('passes requests without GDT header', async () => {
      const middleware = x402Middleware({ required: false });
      const req = mockReq();
      const res = mockRes();
      const next = vi.fn();

      await middleware(req as never, res as never, next);

      expect(next).toHaveBeenCalled();
    });

    it('still validates GDT when present', async () => {
      const middleware = x402Middleware({ required: false, requiredScopes: ['weather:read'] });
      const req = mockReq({ 'X-Grantex-GDT': 'bad-token' });
      const res = mockRes();
      const next = vi.fn();

      await middleware(req as never, res as never, next);

      expect(res.statusCode).toBe(403);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('custom extractAmount', () => {
    it('uses custom amount extraction', async () => {
      const middleware = x402Middleware({
        requiredScopes: ['weather:read'],
        extractAmount: () => 0.005,
      });
      const req = mockReq({ 'X-Grantex-GDT': validToken });
      const res = mockRes();
      const next = vi.fn();

      await middleware(req as never, res as never, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('multiple required scopes', () => {
    it('passes when all scopes are granted', async () => {
      const multiToken = await issueGDT({
        ...baseParams,
        scope: ['weather:read', 'weather:write'],
      });

      const middleware = x402Middleware({
        requiredScopes: ['weather:read', 'weather:write'],
      });
      const req = mockReq({ 'X-Grantex-GDT': multiToken, 'X-Payment-Amount': '0.001' });
      const res = mockRes();
      const next = vi.fn();

      await middleware(req as never, res as never, next);

      expect(next).toHaveBeenCalled();
    });

    it('rejects when some scopes are missing', async () => {
      const middleware = x402Middleware({
        requiredScopes: ['weather:read', 'weather:write'],
      });
      const req = mockReq({ 'X-Grantex-GDT': validToken, 'X-Payment-Amount': '0.001' });
      const res = mockRes();
      const next = vi.fn();

      await middleware(req as never, res as never, next);

      expect(res.statusCode).toBe(403);
      expect((res.body as Record<string, unknown>)['error']).toBe('INSUFFICIENT_SCOPE');
    });
  });

  describe('custom verifyFn', () => {
    it('uses custom verify function', async () => {
      const customVerify = vi.fn().mockResolvedValue({
        valid: true,
        agentDID: 'did:key:custom',
        principalDID: 'did:key:custom-principal',
        remainingLimit: 100,
        tokenId: 'custom-token',
        scopes: ['weather:read'],
        expiresAt: '2030-01-01T00:00:00Z',
      });

      const middleware = x402Middleware({
        requiredScopes: ['weather:read'],
        verifyFn: customVerify,
      });
      const req = mockReq({ 'X-Grantex-GDT': 'any-token', 'X-Payment-Amount': '1' });
      const res = mockRes();
      const next = vi.fn();

      await middleware(req as never, res as never, next);

      expect(customVerify).toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });
  });
});
