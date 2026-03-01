import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VerifiedGrant } from '@grantex/sdk';

vi.mock('@grantex/sdk', () => ({
  verifyGrantToken: vi.fn(),
}));

import { verifyGrantToken } from '@grantex/sdk';
import { StripeAdapter } from '../../src/adapters/stripe.js';
import { GrantexAdapterError } from '../../src/errors.js';

const MOCK_GRANT: VerifiedGrant = {
  tokenId: 'tok_1', grantId: 'grnt_1', principalId: 'user_1',
  agentDid: 'did:grantex:agent:a1', developerId: 'dev_1',
  scopes: ['payments:read', 'payments:initiate:max_500'],
  issuedAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

describe('StripeAdapter', () => {
  const adapter = new StripeAdapter({
    jwksUri: 'https://auth.example.com/.well-known/jwks.json',
    credentials: 'sk_test_123',
  });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyGrantToken).mockResolvedValue(MOCK_GRANT);
  });

  describe('listPaymentIntents', () => {
    it('lists payment intents', async () => {
      const intents = { data: [{ id: 'pi_1', amount: 5000 }] };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve(intents),
      }));

      const result = await adapter.listPaymentIntents('token');
      expect(result.success).toBe(true);
      expect(result.data).toEqual(intents);

      const url = vi.mocked(fetch).mock.calls[0]![0] as string;
      expect(url).toContain('/v1/payment_intents');
    });

    it('passes query filters', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve({ data: [] }),
      }));

      await adapter.listPaymentIntents('token', {
        limit: 10,
        customer: 'cus_123',
      });

      const url = vi.mocked(fetch).mock.calls[0]![0] as string;
      expect(url).toContain('limit=10');
      expect(url).toContain('customer=cus_123');
    });

    it('throws SCOPE_MISSING without payments:read', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue({
        ...MOCK_GRANT, scopes: ['payments:initiate:max_500'],
      });

      await expect(adapter.listPaymentIntents('token'))
        .rejects.toThrow(GrantexAdapterError);
    });
  });

  describe('createPaymentIntent', () => {
    it('creates payment intent within constraint', async () => {
      const created = { id: 'pi_new', amount: 10000, currency: 'usd' };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve(created),
      }));

      const result = await adapter.createPaymentIntent('token', {
        amount: 10000, // $100 in cents
        currency: 'usd',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(created);

      const fetchCall = vi.mocked(fetch).mock.calls[0]!;
      expect(fetchCall[1]?.method).toBe('POST');
      expect(fetchCall[1]?.headers).toHaveProperty('Content-Type', 'application/x-www-form-urlencoded');
    });

    it('allows payment at exact max ($500 = 50000 cents)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve({ id: 'pi_exact' }),
      }));

      const result = await adapter.createPaymentIntent('token', {
        amount: 50000, // exactly $500
        currency: 'usd',
      });

      expect(result.success).toBe(true);
    });

    it('rejects payment over max constraint ($600 > $500)', async () => {
      try {
        await adapter.createPaymentIntent('token', {
          amount: 60000, // $600 in cents
          currency: 'usd',
        });
        expect.fail('should throw');
      } catch (err) {
        expect((err as GrantexAdapterError).code).toBe('CONSTRAINT_VIOLATED');
        expect((err as GrantexAdapterError).message).toContain('600');
        expect((err as GrantexAdapterError).message).toContain('500');
      }
    });

    it('allows any amount when scope has no constraint', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue({
        ...MOCK_GRANT, scopes: ['payments:read', 'payments:initiate'],
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve({ id: 'pi_big' }),
      }));

      const result = await adapter.createPaymentIntent('token', {
        amount: 10000000, // $100,000
        currency: 'usd',
      });

      expect(result.success).toBe(true);
    });

    it('sends metadata as form-encoded bracket notation', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve({ id: 'pi_meta' }),
      }));

      await adapter.createPaymentIntent('token', {
        amount: 5000,
        currency: 'usd',
        metadata: { orderId: 'ord_123', source: 'agent' },
      });

      const body = vi.mocked(fetch).mock.calls[0]![1]?.body as string;
      expect(body).toContain('metadata%5BorderId%5D=ord_123');
      expect(body).toContain('metadata%5Bsource%5D=agent');
    });

    it('throws SCOPE_MISSING without payments:initiate', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue({
        ...MOCK_GRANT, scopes: ['payments:read'],
      });

      await expect(adapter.createPaymentIntent('token', {
        amount: 1000, currency: 'usd',
      })).rejects.toThrow(GrantexAdapterError);
    });

    it('throws UPSTREAM_ERROR on Stripe failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false, status: 402, text: () => Promise.resolve('Card declined'),
      }));

      try {
        await adapter.createPaymentIntent('token', {
          amount: 1000, currency: 'usd',
        });
        expect.fail('should throw');
      } catch (err) {
        expect((err as GrantexAdapterError).code).toBe('UPSTREAM_ERROR');
      }
    });
  });
});
