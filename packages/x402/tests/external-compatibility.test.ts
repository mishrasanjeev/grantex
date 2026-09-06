import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import { PaymentRequiredV2Schema } from '@x402/core/schemas';
import { createX402Agent, HEADERS } from '../src/agent.js';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/uk-taxi-phv-base-mainnet-402.json', import.meta.url), 'utf8',
)) as {
  endpoint: string;
  requestBody: Record<string, unknown>;
  httpStatus: number;
  paymentRequiredHeader: string;
  responseBody: string;
};

describe('external Base mainnet x402 v2 compatibility boundary', () => {
  it('parses the captured production header and accepts its standard v2 schema', () => {
    const challenge = decodePaymentRequiredHeader(fixture.paymentRequiredHeader);
    expect(PaymentRequiredV2Schema.safeParse(challenge).success).toBe(true);
    expect(challenge.resource.url).toBe(fixture.endpoint);
    expect(challenge.accepts).toEqual([{
      scheme: 'exact',
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '20000',
      payTo: '0xDAAef0FD525278aAD0bA11066A96c338642A3d1A',
      maxTimeoutSeconds: 300,
      extra: { name: 'USD Coin', version: '2' },
    }]);
    expect(challenge.extensions).toHaveProperty('bazaar');
  });

  it.each([
    ['default client', {}],
    ['per-request wallet client', {
      walletId: 'pwal_compatibility_test', idempotencyKey: 'taxi-preflight-compatibility-0001',
    }],
  ])('rejects unsupported Base payments before authorization or retry: %s', async (_name, options) => {
    const networkFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      new Response(fixture.responseBody, {
        status: fixture.httpStatus,
        // Preserve the wire header casing and the empty JSON body from the live service.
        headers: { 'content-type': 'application/json', 'payment-required': fixture.paymentRequiredHeader },
      }),
    );
    const authorizePayment = vi.fn().mockRejectedValue(new Error('Authorization must not be reached'));
    const agent = createX402Agent({ authorizePayment, fetch: networkFetch });

    await expect(agent.fetch(fixture.endpoint, {
      ...options,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fixture.requestBody),
    })).rejects.toThrow(/No network\/scheme registered/);

    expect(authorizePayment).not.toHaveBeenCalled();
    expect(networkFetch).toHaveBeenCalledTimes(1);
    const request = networkFetch.mock.calls[0]![0] as Request;
    expect(request.url).toBe(fixture.endpoint);
    expect(request.method).toBe('POST');
    expect(await request.clone().json()).toEqual(fixture.requestBody);
    expect(request.headers.has(HEADERS.PAYMENT_SIGNATURE)).toBe(false);
  });
});
