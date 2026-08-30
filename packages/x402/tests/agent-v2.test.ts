import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import {
  GRANTEX_PREPAID_NETWORK,
  HEADERS,
  createX402Agent,
  type PrepaidAuthorizationRequest,
  type PrepaidAuthorizationResponse,
} from '../src/agent.js';

const requirements: PaymentRequired = {
  x402Version: 2,
  resource: {
    url: 'https://api.example.com/weather',
    description: 'Weather forecast',
    mimeType: 'application/json',
  },
  accepts: [{
    scheme: 'exact',
    network: GRANTEX_PREPAID_NETWORK,
    amount: '2500',
    asset: 'USDC',
    payTo: 'merchant:weather',
    maxTimeoutSeconds: 120,
    extra: { grantexScope: 'weather:read' },
  }],
};

function paymentRequiredResponse(value: PaymentRequired = requirements) {
  return new Response(null, {
    status: 402,
    headers: { [HEADERS.PAYMENT_REQUIRED]: encodePaymentRequiredHeader(value) },
  });
}

function authorizationResponse(token = 'signed-wallet-authorization') {
  return {
    authorization: token,
    reservationId: 'wres_test',
    walletId: 'pwal_test',
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    remainingAvailable: '7500',
    remainingCumulative: '17500',
  };
}

describe('official x402 v2 prepaid agent', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
  let authorizePayment: ReturnType<typeof vi.fn<
    (request: PrepaidAuthorizationRequest) => Promise<PrepaidAuthorizationResponse>
  >>;

  beforeEach(() => {
    fetchMock = vi.fn<typeof globalThis.fetch>();
    authorizePayment = vi.fn<
      (request: PrepaidAuthorizationRequest) => Promise<PrepaidAuthorizationResponse>
    >().mockResolvedValue(authorizationResponse());
  });

  it('passes through non-402 responses without reserving funds', async () => {
    fetchMock.mockResolvedValueOnce(new Response('OK', { status: 200 }));
    const agent = createX402Agent({ authorizePayment, fetch: fetchMock });

    const response = await agent.fetch('https://api.example.com/free');

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(authorizePayment).not.toHaveBeenCalled();
  });

  it('turns PAYMENT-REQUIRED into a Grantex reservation and PAYMENT-SIGNATURE retry', async () => {
    fetchMock
      .mockResolvedValueOnce(paymentRequiredResponse())
      .mockResolvedValueOnce(new Response('{"forecast":"sunny"}', { status: 200 }));
    const agent = createX402Agent({ authorizePayment, fetch: fetchMock });

    const response = await agent.fetch('https://api.example.com/weather');

    expect(response.status).toBe(200);
    expect(authorizePayment).toHaveBeenCalledTimes(1);
    const request = authorizePayment.mock.calls[0]![0] as PrepaidAuthorizationRequest;
    expect(request).toMatchObject({
      amount: '2500',
      asset: 'USDC',
      network: 'grantex:prepaid',
      recipient: 'merchant:weather',
      resource: 'https://api.example.com/weather',
      scope: 'weather:read',
      maxTimeoutSeconds: 120,
    });
    expect(request.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);

    const paidRequest = fetchMock.mock.calls[1]![0] as Request;
    const encoded = paidRequest.headers.get(HEADERS.PAYMENT_SIGNATURE);
    expect(encoded).toBeTruthy();
    expect(decodePaymentSignatureHeader(encoded!)).toEqual({
      x402Version: 2,
      resource: requirements.resource,
      accepted: requirements.accepts[0],
      payload: { authorization: 'signed-wallet-authorization' },
    });
    expect(paidRequest.headers.has('X-Payment-Proof')).toBe(false);
  });

  it('pins a configured or per-request wallet without leaking SDK options to fetch', async () => {
    fetchMock
      .mockResolvedValueOnce(paymentRequiredResponse())
      .mockResolvedValueOnce(new Response('OK', { status: 200 }));
    const agent = createX402Agent({ authorizePayment, walletId: 'pwal_default', fetch: fetchMock });

    await agent.fetch('https://api.example.com/weather', { walletId: 'pwal_override', method: 'POST' });

    expect(authorizePayment.mock.calls[0]![0]).toMatchObject({ walletId: 'pwal_override' });
    const firstRequest = fetchMock.mock.calls[0]![0] as Request;
    const paidRequest = fetchMock.mock.calls[1]![0] as Request;
    expect(firstRequest.method).toBe('POST');
    expect(paidRequest.method).toBe('POST');
    expect(firstRequest).not.toHaveProperty('walletId');
  });

  it('forwards a caller-stable idempotency key without leaking it to fetch', async () => {
    fetchMock
      .mockResolvedValueOnce(paymentRequiredResponse())
      .mockResolvedValueOnce(new Response('OK', { status: 200 }));
    const agent = createX402Agent({ authorizePayment, fetch: fetchMock });

    await agent.fetch('https://api.example.com/weather', {
      idempotencyKey: 'logical-order-1234567890',
    });

    expect(authorizePayment.mock.calls[0]![0]).toMatchObject({
      idempotencyKey: 'logical-order-1234567890',
    });
    const firstRequest = fetchMock.mock.calls[0]![0] as Request;
    expect(firstRequest).not.toHaveProperty('idempotencyKey');
    expect(() => agent.fetch('https://api.example.com/weather', { idempotencyKey: 'short' }))
      .toThrow('16 to 256');
  });

  it('preserves POST method, body, and caller headers on the paid retry', async () => {
    fetchMock
      .mockResolvedValueOnce(paymentRequiredResponse())
      .mockResolvedValueOnce(new Response('OK', { status: 200 }));
    const agent = createX402Agent({ authorizePayment, fetch: fetchMock });

    await agent.fetch('https://api.example.com/weather', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-Trace': 'trace-123' },
      body: JSON.stringify({ city: 'Delhi' }),
    });

    const initial = fetchMock.mock.calls[0]![0] as Request;
    const paid = fetchMock.mock.calls[1]![0] as Request;
    expect(initial.method).toBe('POST');
    expect(paid.method).toBe('POST');
    expect(await paid.clone().json()).toEqual({ city: 'Delhi' });
    expect(paid.headers.get('X-Request-Trace')).toBe('trace-123');
    expect(paid.headers.get(HEADERS.PAYMENT_SIGNATURE)).toBeTruthy();
  });

  it('selects the registered prepaid option when a server advertises multiple schemes', async () => {
    const multi = {
      ...requirements,
      accepts: [
        {
          scheme: 'exact', network: 'eip155:8453', amount: '2500', asset: 'USDC',
          payTo: '0xmerchant', maxTimeoutSeconds: 120, extra: {},
        },
        requirements.accepts[0]!,
      ],
    } as PaymentRequired;
    fetchMock
      .mockResolvedValueOnce(paymentRequiredResponse(multi))
      .mockResolvedValueOnce(new Response('OK', { status: 200 }));
    const agent = createX402Agent({ authorizePayment, fetch: fetchMock });

    await agent.fetch('https://api.example.com/weather');

    expect(authorizePayment).toHaveBeenCalledTimes(1);
    expect(authorizePayment.mock.calls[0]![0].network).toBe(GRANTEX_PREPAID_NETWORK);
  });

  it.each([
    [{ ...requirements, accepts: [{ ...requirements.accepts[0]!, amount: '1junk' }] }, 'positive integer'],
    [{ ...requirements, accepts: [{ ...requirements.accepts[0]!, maxTimeoutSeconds: 301 }] }, 'between 1 and 300'],
    [{ ...requirements, accepts: [{ ...requirements.accepts[0]!, extra: {} }] }, 'grantexScope'],
  ] as const)('rejects malformed or unsafe declarations before reserving funds', async (declaration, message) => {
    fetchMock.mockResolvedValueOnce(paymentRequiredResponse(declaration as unknown as PaymentRequired));
    const agent = createX402Agent({ authorizePayment, fetch: fetchMock });

    await expect(agent.fetch('https://api.example.com/weather')).rejects.toThrow(message);
    expect(authorizePayment).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed when reservation authorization fails or is malformed', async () => {
    fetchMock.mockResolvedValueOnce(paymentRequiredResponse());
    authorizePayment.mockRejectedValueOnce(new Error('wallet blocked'));
    const agent = createX402Agent({ authorizePayment, fetch: fetchMock });
    await expect(agent.fetch('https://api.example.com/weather')).rejects.toThrow('wallet blocked');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset().mockResolvedValueOnce(paymentRequiredResponse());
    authorizePayment.mockReset().mockResolvedValueOnce({} as PrepaidAuthorizationResponse);
    await expect(agent.fetch('https://api.example.com/weather')).rejects.toThrow('invalid wallet authorization');
  });

  it('requires an explicit authorization provider and never provides a fake default', () => {
    expect(() => createX402Agent(undefined as never)).toThrow('requires authorizePayment');
    expect(() => createX402Agent({} as never)).toThrow('requires authorizePayment');
  });
});
