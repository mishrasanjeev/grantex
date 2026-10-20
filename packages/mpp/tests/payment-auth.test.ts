/**
 * The "Payment" HTTP authentication scheme (draft-ryan-httpauth-payment-01):
 * challenge binding, WWW-Authenticate round trip, credential checks, the
 * receipt, problem details, and the 402 flow end to end through Express.
 */
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PAYMENT_PROBLEM_BASE,
  PaymentAuthError,
  bodyDigest,
  createPaymentChallenge,
  decodeChallengeRequest,
  formatPaymentChallenge,
  formatPaymentCredential,
  parsePaymentChallenges,
  parsePaymentCredential,
  parsePaymentReceipt,
  paymentChallengeId,
  paymentProblem,
  requirePayment,
  verifyPaymentCredential,
} from '../src/index.js';
import type { PaymentChallenge } from '../src/index.js';

const SECRET = 'test-only-challenge-secret';
const NOW = new Date('2026-10-20T12:00:00Z');

function challenge(overrides: Record<string, unknown> = {}): PaymentChallenge {
  return createPaymentChallenge({
    secret: SECRET,
    realm: 'api.merchant.example',
    method: 'tempo',
    intent: 'charge',
    request: { amount: '1000', currency: 'usd', recipient: 'acct-0001' },
    expiresIn: 300,
    now: NOW,
    ...overrides,
  });
}

function refusal(fn: () => unknown): PaymentAuthError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentAuthError);
    return error as PaymentAuthError;
  }
  throw new Error('expected a refusal');
}

describe('challenges', () => {
  it('binds the id to every parameter with HMAC-SHA256 over the seven slots (section 5.1.2.1.1)', () => {
    const c = challenge({ description: 'One report' });
    const slots = [c.realm, c.method, c.intent, c.request, c.expires, '', ''].join('|');
    expect(c.id).toBe(createHmac('sha256', SECRET).update(slots).digest('base64url'));
    expect(paymentChallengeId(SECRET, { ...c, id: undefined } as never)).toBe(c.id);
    // The request is base64url of the JCS-serialized method data.
    expect(Buffer.from(c.request, 'base64url').toString()).toBe('{"amount":"1000","currency":"usd","recipient":"acct-0001"}');
    expect(decodeChallengeRequest(c)).toEqual({ amount: '1000', currency: 'usd', recipient: 'acct-0001' });
  });

  it('formats WWW-Authenticate and parses it back, several challenges in one field', () => {
    const a = challenge();
    const b = challenge({ method: 'card', opaque: { order: 'o-1' }, body: '{"q":1}' });
    const field = `${formatPaymentChallenge(a)}, Bearer realm="other", ${formatPaymentChallenge(b)}`;
    expect(formatPaymentChallenge(a)).toMatch(/^Payment id="[A-Za-z0-9_-]{43}", realm="api.merchant.example", method="tempo", intent="charge", request="[A-Za-z0-9_-]+", expires="2026-10-20T12:05:00.000Z"$/);
    expect(parsePaymentChallenges(field)).toEqual([a, b]);
    expect(b.digest).toBe(bodyDigest('{"q":1}'));
  });

  it('ignores unknown parameters and unescapes quoted-strings', () => {
    const c = challenge({ description: 'say "hi" \\ there' });
    const parsed = parsePaymentChallenges(`${formatPaymentChallenge(c)}, future=token`);
    expect(parsed).toEqual([c]);
  });

  it('refuses a method that is not a lowercase id', () => {
    expect(refusal(() => challenge({ method: 'Tempo' })).code).toBe('method-unsupported');
  });
});

describe('credentials', () => {
  const verify = (credential: ReturnType<typeof parsePaymentCredential>, extra: Record<string, unknown> = {}) =>
    verifyPaymentCredential(credential, { secret: SECRET, realm: 'api.merchant.example', methods: ['tempo', 'card'], now: NOW, ...extra });

  it('round-trips Authorization: Payment <base64url JSON> and verifies the echoed challenge', () => {
    const header = formatPaymentCredential({ challenge: challenge(), source: 'did:example:payer', payload: { proof: 'p' } });
    expect(header).toMatch(/^Payment [A-Za-z0-9_-]+$/);
    const credential = parsePaymentCredential(header);
    expect(verify(credential)).toEqual(credential);
    expect(credential.source).toBe('did:example:payer');
  });

  it('refuses a changed parameter, another realm, another secret, an expired challenge, another method', () => {
    const c = challenge();
    const changed = { challenge: { ...c, request: Buffer.from('{"amount":"1"}').toString('base64url') }, payload: {} };
    expect(refusal(() => verify(changed)).code).toBe('invalid-challenge');
    expect(refusal(() => verify({ challenge: c, payload: {} }, { realm: 'other.example' })).code).toBe('invalid-challenge');
    expect(refusal(() => verify({ challenge: c, payload: {} }, { secret: 'another-secret' })).code).toBe('invalid-challenge');
    expect(refusal(() => verify({ challenge: c, payload: {} }, { now: new Date('2026-10-20T12:05:00Z') })).code).toBe('payment-expired');
    expect(refusal(() => verify({ challenge: c, payload: {} }, { methods: ['card'] })).code).toBe('method-unsupported');
  });

  it('checks a bound body against the digest', () => {
    const c = challenge({ body: '{"q":1}' });
    expect(verify({ challenge: c, payload: {} }, { body: '{"q":1}' })).toBeDefined();
    expect(refusal(() => verify({ challenge: c, payload: {} }, { body: '{"q":2}' })).code).toBe('verification-failed');
    expect(refusal(() => verify({ challenge: c, payload: {} })).code).toBe('verification-failed');
  });

  it('refuses malformed credentials', () => {
    expect(refusal(() => parsePaymentCredential(undefined)).code).toBe('payment-required');
    expect(refusal(() => parsePaymentCredential('Bearer abc')).code).toBe('malformed-credential');
    expect(refusal(() => parsePaymentCredential('Payment !!!')).code).toBe('malformed-credential');
    expect(refusal(() => parsePaymentCredential(`Payment ${Buffer.from('{"payload":{}}').toString('base64url')}`)).code).toBe('malformed-credential');
    const noPayload = Buffer.from(JSON.stringify({ challenge: challenge() })).toString('base64url');
    expect(refusal(() => parsePaymentCredential(`Payment ${noPayload}`)).code).toBe('malformed-credential');
  });
});

describe('receipts and problems', () => {
  it('is the section 5.3 receipt and the section 8 problem details', () => {
    expect(paymentProblem('payment-expired', 'late')).toEqual({ type: `${PAYMENT_PROBLEM_BASE}payment-expired`, title: 'Payment expired', status: 402, detail: 'late' });
    expect(paymentProblem('method-unsupported', 'x').status).toBe(400);
    expect(() => parsePaymentReceipt(Buffer.from('{"status":"failed"}').toString('base64url'))).toThrow(PaymentAuthError);
  });
});

describe('the 402 flow through Express', () => {
  let base: string;
  let close: () => void;

  beforeAll(async () => {
    const app = express();
    app.get('/report', requirePayment({
      secret: SECRET,
      realm: 'api.merchant.example',
      offers: () => [{ method: 'tempo', intent: 'charge', request: { amount: '1000', currency: 'usd' } }],
      verifyPayload: (credential) => {
        const proof = (credential.payload as { proof?: string }).proof;
        if (proof !== 'valid-proof') throw new PaymentAuthError('verification-failed', 'the method proof does not verify');
        return { reference: 'tx-0001' };
      },
    }), (req, res) => {
      res.json({ report: 'synthetic', paid_by: req.payment?.credential.source ?? null });
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });

  afterAll(() => close());

  it('answers 402 with a challenge, then 200 with a receipt for a valid credential', async () => {
    const first = await fetch(`${base}/report`);
    expect(first.status).toBe(402);
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(first.headers.get('content-type')).toContain('application/problem+json');
    expect(await first.json()).toMatchObject({ type: `${PAYMENT_PROBLEM_BASE}payment-required`, status: 402 });
    const challenges = parsePaymentChallenges(first.headers.get('www-authenticate')!);
    expect(challenges).toHaveLength(1);
    expect(challenges[0]).toMatchObject({ method: 'tempo', intent: 'charge', realm: 'api.merchant.example' });

    const paid = await fetch(`${base}/report`, {
      headers: { authorization: formatPaymentCredential({ challenge: challenges[0]!, source: 'did:example:payer', payload: { proof: 'valid-proof' } }) },
    });
    expect(paid.status).toBe(200);
    expect(await paid.json()).toEqual({ report: 'synthetic', paid_by: 'did:example:payer' });
    expect(parsePaymentReceipt(paid.headers.get('payment-receipt')!)).toMatchObject({ status: 'success', method: 'tempo', reference: 'tx-0001' });
  });

  it('refuses a proof the method verifier rejects, with a fresh challenge and no receipt', async () => {
    const first = await fetch(`${base}/report`);
    const [c] = parsePaymentChallenges(first.headers.get('www-authenticate')!);
    const res = await fetch(`${base}/report`, { headers: { authorization: formatPaymentCredential({ challenge: c!, payload: { proof: 'forged' } }) } });
    expect(res.status).toBe(402);
    expect(res.headers.get('payment-receipt')).toBeNull();
    expect(res.headers.get('www-authenticate')).toMatch(/^Payment /);
    expect(await res.json()).toMatchObject({ type: `${PAYMENT_PROBLEM_BASE}verification-failed` });
  });

  it('refuses a challenge it did not issue', async () => {
    const forged = { ...challenge(), id: 'A'.repeat(43) };
    const res = await fetch(`${base}/report`, { headers: { authorization: formatPaymentCredential({ challenge: forged, payload: { proof: 'valid-proof' } }) } });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ type: `${PAYMENT_PROBLEM_BASE}invalid-challenge` });
  });
});
