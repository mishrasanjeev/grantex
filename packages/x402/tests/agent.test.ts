import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createX402Agent, HEADERS } from '../src/agent.js';
import { InMemoryAuditLog, setAuditLog } from '../src/audit.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('x402 Agent', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    setAuditLog(new InMemoryAuditLog());
  });

  describe('createX402Agent', () => {
    it('passes through non-402 responses', async () => {
      mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }));

      const agent = createX402Agent({ gdt: 'test-gdt' });
      const res = await agent.fetch('https://api.example.com/data');

      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Check GDT header was attached
      const headers = mockFetch.mock.calls[0]![1]!.headers as Headers;
      expect(headers.get(HEADERS.GDT)).toBe('test-gdt');
    });

    it('handles 402 → pay → retry flow', async () => {
      // First call returns 402
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 402,
          headers: {
            [HEADERS.PAYMENT_AMOUNT]: '0.001',
            [HEADERS.PAYMENT_CURRENCY]: 'USDC',
            [HEADERS.PAYMENT_RECIPIENT]: '0x1234567890abcdef',
            [HEADERS.PAYMENT_CHAIN]: 'base',
          },
        }),
      );

      // Second call (retry with payment) returns 200
      mockFetch.mockResolvedValueOnce(new Response('{"data":"weather"}', { status: 200 }));

      const paymentHandler = vi.fn().mockResolvedValue('mock-payment-proof');
      const agent = createX402Agent({ gdt: 'test-gdt', paymentHandler });

      const res = await agent.fetch('https://api.example.com/weather');

      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(paymentHandler).toHaveBeenCalledWith({
        amount: 0.001,
        currency: 'USDC',
        recipientAddress: '0x1234567890abcdef',
        chain: 'base',
      });

      // Check retry includes payment proof
      const retryHeaders = mockFetch.mock.calls[1]![1]!.headers as Headers;
      expect(retryHeaders.get(HEADERS.PAYMENT_PROOF)).toBe('mock-payment-proof');
      expect(retryHeaders.get(HEADERS.GDT)).toBe('test-gdt');
    });

    it('handles 402 with JSON body', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            amount: 0.005,
            currency: 'USDC',
            recipientAddress: '0xabc',
            chain: 'base',
            memo: 'weather-forecast',
          }),
          {
            status: 402,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
      mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }));

      const paymentHandler = vi.fn().mockResolvedValue('proof');
      const agent = createX402Agent({ gdt: 'test-gdt', paymentHandler });

      await agent.fetch('https://api.example.com/data');

      expect(paymentHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 0.005,
          recipientAddress: '0xabc',
          memo: 'weather-forecast',
        }),
      );
    });

    it('uses per-request GDT override', async () => {
      mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }));

      const agent = createX402Agent({ gdt: 'default-gdt' });
      await agent.fetch('https://api.example.com/data', { gdt: 'override-gdt' });

      const headers = mockFetch.mock.calls[0]![1]!.headers as Headers;
      expect(headers.get(HEADERS.GDT)).toBe('override-gdt');
    });

    it('works without GDT', async () => {
      mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }));

      const agent = createX402Agent();
      await agent.fetch('https://api.example.com/data');

      const headers = mockFetch.mock.calls[0]![1]!.headers as Headers;
      expect(headers.get(HEADERS.GDT)).toBeNull();
    });

    it('uses default stub payment handler', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 402,
          headers: {
            [HEADERS.PAYMENT_AMOUNT]: '0.001',
            [HEADERS.PAYMENT_CURRENCY]: 'USDC',
            [HEADERS.PAYMENT_RECIPIENT]: '0xrecipient',
            [HEADERS.PAYMENT_CHAIN]: 'base',
          },
        }),
      );
      mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }));

      const agent = createX402Agent({ gdt: 'test-gdt' });
      const res = await agent.fetch('https://api.example.com/data');

      expect(res.status).toBe(200);
      // Payment proof is a base64url-encoded JSON
      const retryHeaders = mockFetch.mock.calls[1]![1]!.headers as Headers;
      const proof = retryHeaders.get(HEADERS.PAYMENT_PROOF)!;
      expect(proof).toBeDefined();
      const decoded = JSON.parse(Buffer.from(proof, 'base64url').toString());
      expect(decoded.chain).toBe('base');
      expect(decoded.amount).toBe(0.001);
    });
  });
});
