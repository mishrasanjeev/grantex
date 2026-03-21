import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  generateKeyPair,
  issueGDT,
  verifyGDT,
  decodeGDT,
  InMemoryRevocationRegistry,
  setRevocationRegistry,
  getRevocationRegistry,
  InMemoryAuditLog,
  setAuditLog,
  getAuditLog,
  x402Middleware,
  createX402Agent,
  HEADERS,
} from '../src/index.js';

describe('Integration tests', () => {
  beforeEach(() => {
    setRevocationRegistry(new InMemoryRevocationRegistry());
    setAuditLog(new InMemoryAuditLog());
  });

  describe('full GDT lifecycle', () => {
    it('issue → verify → revoke → verify fails', async () => {
      const principal = generateKeyPair();
      const agent = generateKeyPair();

      // Issue
      const token = await issueGDT({
        agentDID: agent.did,
        scope: ['weather:read'],
        spendLimit: { amount: 10, currency: 'USDC', period: '24h' },
        expiry: '24h',
        signingKey: principal.privateKey,
      });

      // Verify — should pass
      const result1 = await verifyGDT(token, {
        resource: 'weather:read',
        amount: 0.001,
        currency: 'USDC',
      });
      expect(result1.valid).toBe(true);
      expect(result1.agentDID).toBe(agent.did);
      expect(result1.principalDID).toBe(principal.did);

      // Revoke
      const decoded = decodeGDT(token);
      await getRevocationRegistry().revoke(decoded.jti, 'compromised');

      // Verify — should fail
      const result2 = await verifyGDT(token, {
        resource: 'weather:read',
        amount: 0.001,
        currency: 'USDC',
      });
      expect(result2.valid).toBe(false);
      expect(result2.error).toContain('revoked');
    });

    it('audit log captures full lifecycle', async () => {
      const principal = generateKeyPair();
      const agent = generateKeyPair();

      const token = await issueGDT({
        agentDID: agent.did,
        scope: ['weather:read'],
        spendLimit: { amount: 10, currency: 'USDC', period: '24h' },
        expiry: '24h',
        signingKey: principal.privateKey,
      });

      // Successful verification
      await verifyGDT(token, { resource: 'weather:read', amount: 0.001, currency: 'USDC' });

      // Failed verification (scope mismatch)
      await verifyGDT(token, { resource: 'finance:read', amount: 0.001, currency: 'USDC' });

      const auditLog = getAuditLog() as InMemoryAuditLog;
      const all = await auditLog.export();

      // Should have: 1 issuance + 1 verification + 1 rejection
      expect(all.filter((e) => e.eventType === 'issuance')).toHaveLength(1);
      expect(all.filter((e) => e.eventType === 'verification')).toHaveLength(1);
      expect(all.filter((e) => e.eventType === 'rejection')).toHaveLength(1);
    });
  });

  describe('multiple agents, same principal', () => {
    it('issues separate GDTs for different agents', async () => {
      const principal = generateKeyPair();
      const agent1 = generateKeyPair();
      const agent2 = generateKeyPair();

      const token1 = await issueGDT({
        agentDID: agent1.did,
        scope: ['weather:read'],
        spendLimit: { amount: 10, currency: 'USDC', period: '24h' },
        expiry: '24h',
        signingKey: principal.privateKey,
      });

      const token2 = await issueGDT({
        agentDID: agent2.did,
        scope: ['news:read'],
        spendLimit: { amount: 5, currency: 'USDC', period: '24h' },
        expiry: '24h',
        signingKey: principal.privateKey,
      });

      // Agent 1 can access weather but not news
      const r1a = await verifyGDT(token1, { resource: 'weather:read', amount: 0.001, currency: 'USDC' });
      expect(r1a.valid).toBe(true);
      const r1b = await verifyGDT(token1, { resource: 'news:read', amount: 0.001, currency: 'USDC' });
      expect(r1b.valid).toBe(false);

      // Agent 2 can access news but not weather
      const r2a = await verifyGDT(token2, { resource: 'news:read', amount: 0.001, currency: 'USDC' });
      expect(r2a.valid).toBe(true);
      const r2b = await verifyGDT(token2, { resource: 'weather:read', amount: 0.001, currency: 'USDC' });
      expect(r2b.valid).toBe(false);

      // Both from same principal
      expect(decodeGDT(token1).iss).toBe(principal.did);
      expect(decodeGDT(token2).iss).toBe(principal.did);
    });
  });

  describe('middleware + real GDT', () => {
    it('passes valid GDT through middleware', async () => {
      const principal = generateKeyPair();
      const agent = generateKeyPair();

      const token = await issueGDT({
        agentDID: agent.did,
        scope: ['weather:read'],
        spendLimit: { amount: 10, currency: 'USDC', period: '24h' },
        expiry: '24h',
        signingKey: principal.privateKey,
      });

      const middleware = x402Middleware({
        requiredScopes: ['weather:read'],
        extractAmount: () => 0.001,
      });

      const req = {
        headers: { 'x-grantex-gdt': token },
        path: '/api/weather/forecast',
        method: 'GET',
        get(name: string) {
          return (this.headers as Record<string, string>)[name.toLowerCase()];
        },
      };
      const res = {
        statusCode: 200,
        body: null as unknown,
        status(code: number) { res.statusCode = code; return res; },
        json(body: unknown) { res.body = body; },
      };
      const next = vi.fn();

      await middleware(req as never, res as never, next);

      expect(next).toHaveBeenCalled();
      expect((req as Record<string, unknown>)['gdt']).toBeDefined();
      const gdt = (req as Record<string, unknown>)['gdt'] as Record<string, unknown>;
      expect(gdt['valid']).toBe(true);
      expect(gdt['agentDID']).toBe(agent.did);
    });
  });

  describe('x402 agent with real GDT', () => {
    it('attaches GDT and handles 402 flow', async () => {
      const principal = generateKeyPair();
      const agent = generateKeyPair();

      const token = await issueGDT({
        agentDID: agent.did,
        scope: ['weather:read'],
        spendLimit: { amount: 10, currency: 'USDC', period: '24h' },
        expiry: '24h',
        signingKey: principal.privateKey,
      });

      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      // First call → 402
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 402,
          headers: {
            'X-Payment-Amount': '0.001',
            'X-Payment-Currency': 'USDC',
            'X-Payment-Recipient': '0xRecipient',
            'X-Payment-Chain': 'base',
          },
        }),
      );
      // Retry → 200
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ forecast: 'sunny' }), { status: 200 }),
      );

      const x402 = createX402Agent({
        gdt: token,
        paymentHandler: async () => 'proof123',
      });

      const res = await x402.fetch('https://api.example.com/weather');
      expect(res.status).toBe(200);

      // Verify GDT was attached on both calls
      const firstHeaders = mockFetch.mock.calls[0]![1]!.headers as Headers;
      expect(firstHeaders.get('X-Grantex-GDT')).toBe(token);

      const retryHeaders = mockFetch.mock.calls[1]![1]!.headers as Headers;
      expect(retryHeaders.get('X-Grantex-GDT')).toBe(token);
      expect(retryHeaders.get('X-Payment-Proof')).toBe('proof123');

      vi.unstubAllGlobals();
    });
  });
});
