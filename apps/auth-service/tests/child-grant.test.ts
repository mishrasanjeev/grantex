// SPDX-License-Identifier: Apache-2.0
/**
 * Per-merchant child grants (spec/passport-binding.md §8), without a
 * database: the request parameters (RFC 8693 §2.1), the merchant origin, the
 * commerce constraints of an authorization request (RFC 9396 §2, §5), their
 * attenuation for a child (RFC 9396 §6) and the child's lifetime; and the
 * flag off, where POST /v1/token answers a token exchange exactly as before.
 * The exchange itself runs against real Postgres in
 * tests/child-grant-postgres.integration.test.ts.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { tokenExchangeDuration, tokenExchangeTotal } from '../src/lib/metrics.js';
import {
  CHILD_GRANT_MAX_LIFETIME_SECONDS,
  ChildGrantError,
  TOKEN_EXCHANGE_GRANT_TYPE,
  attenuateConstraints,
  childGrantExpiry,
  isMerchantOrigin,
  parseAuthorizeCommerceDetails,
  parseStoredConstraints,
  parseTokenExchangeRequest,
} from '../src/lib/registry/child-grant.js';
import { authHeader, buildTestApp, mockRedis, seedAuth, sqlMock } from './helpers.js';

const ACCESS_TOKEN = 'urn:ietf:params:oauth:token-type:access_token';
const COMMERCE = 'urn:grantex:commerce:v1';
const MERCHANT = 'https://merchant.example';
const OTHER = 'https://shop.merchant.example';

function refusal(run: () => unknown): ChildGrantError {
  try {
    run();
  } catch (err) {
    if (err instanceof ChildGrantError) return err;
    throw err;
  }
  throw new Error('expected a ChildGrantError');
}

describe('isMerchantOrigin (RFC 6454 §6.2 serialization, https only)', () => {
  it('accepts an https origin as it serializes', () => {
    for (const value of [MERCHANT, 'https://merchant.example:8443', 'https://xn--mnchen-3ya.example']) {
      expect(isMerchantOrigin(value), value).toBe(true);
    }
  });

  it('refuses anything that is not exactly an https origin', () => {
    for (const value of [
      'https://merchant.example/', 'https://merchant.example/checkout', 'http://merchant.example',
      'https://Merchant.example', 'https://merchant.example:443', 'https://user@merchant.example',
      'https://merchant.example?x=1', 'https://merchant.example#f', 'merchant.example', '', 42, null,
    ]) {
      expect(isMerchantOrigin(value), String(value)).toBe(false);
    }
  });
});

describe('parseAuthorizeCommerceDetails', () => {
  it('reads one urn:grantex:commerce:v1 entry with allowed_merchants and optional limits', () => {
    expect(parseAuthorizeCommerceDetails([{
      type: COMMERCE,
      allowed_merchants: [MERCHANT, OTHER],
      amount_range: { currency: 'EUR', min: '1.00', max: '250.00' },
      budget: { amount: '500.00', currency: 'EUR' },
    }])).toEqual({
      allowed_merchants: [MERCHANT, OTHER],
      amount_range: { currency: 'EUR', min: '1.00', max: '250.00' },
      budget: { amount: '500.00', currency: 'EUR' },
    });
    expect(parseAuthorizeCommerceDetails([{ type: COMMERCE, allowed_merchants: [MERCHANT] }]))
      .toEqual({ allowed_merchants: [MERCHANT] });
  });

  it('refuses with invalid_authorization_details (RFC 9396 §5)', () => {
    const cases: unknown[] = [
      'not-an-array',
      [],
      [{ type: 'urn:grantex:tools:v1', connector: 'checkout' }],
      [{ type: COMMERCE, allowed_merchants: [MERCHANT] }, { type: COMMERCE, allowed_merchants: [OTHER] }],
      [{ type: COMMERCE }],
      [{ type: COMMERCE, allowed_merchants: [] }],
      [{ type: COMMERCE, allowed_merchants: ['https://merchant.example/checkout'] }],
      [{ type: COMMERCE, allowed_merchants: [MERCHANT, MERCHANT] }],
      [{ type: COMMERCE, allowed_merchants: [MERCHANT], unknown_member: true }],
      [{ type: COMMERCE, allowed_merchants: [MERCHANT], passport: { issuer: 'https://issuer.example' } }],
      [{ type: COMMERCE, allowed_merchants: [MERCHANT], amount_range: { currency: 'EUR' } }],
      [{ type: COMMERCE, allowed_merchants: [MERCHANT], amount_range: { currency: 'eur', max: '1.00' } }],
      [{ type: COMMERCE, allowed_merchants: [MERCHANT], amount_range: { currency: 'EUR', max: 250 } }],
      [{ type: COMMERCE, allowed_merchants: [MERCHANT], amount_range: { currency: 'EUR', min: '5.00', max: '1.00' } }],
      [{ type: COMMERCE, allowed_merchants: [MERCHANT], budget: { amount: '-1', currency: 'EUR' } }],
      [{ type: COMMERCE, allowed_merchants: Array.from({ length: 51 }, (_, i) => `https://m${i}.merchant.example`) }],
    ];
    for (const value of cases) {
      const err = refusal(() => parseAuthorizeCommerceDetails(value));
      expect(err.error, JSON.stringify(value)).toBe('invalid_authorization_details');
      expect(err.statusCode).toBe(400);
    }
  });
});

describe('parseStoredConstraints', () => {
  it('is null for a grant without constraints and throws on a corrupt value', () => {
    expect(parseStoredConstraints(null)).toBeNull();
    expect(parseStoredConstraints(undefined)).toBeNull();
    expect(parseStoredConstraints({ allowed_merchants: [MERCHANT] })).toEqual({ allowed_merchants: [MERCHANT] });
    expect(parseStoredConstraints(JSON.stringify({ allowed_merchants: [MERCHANT] }))).toEqual({ allowed_merchants: [MERCHANT] });
    expect(() => parseStoredConstraints({ allowed_merchants: 'x' })).toThrow();
    expect(() => parseStoredConstraints([])).toThrow();
  });
});

describe('parseTokenExchangeRequest (RFC 8693 §2.1)', () => {
  const base = {
    grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
    subject_token: 'eyJ.subject.token',
    subject_token_type: ACCESS_TOKEN,
  };

  it('names the merchant with resource or audience', () => {
    expect(parseTokenExchangeRequest({ ...base, resource: MERCHANT })).toMatchObject({ merchant: MERCHANT, subjectToken: 'eyJ.subject.token' });
    expect(parseTokenExchangeRequest({ ...base, audience: MERCHANT })).toMatchObject({ merchant: MERCHANT });
    // The same target named both ways, or twice, is one target.
    expect(parseTokenExchangeRequest({ ...base, audience: MERCHANT, resource: [MERCHANT, MERCHANT] })).toMatchObject({ merchant: MERCHANT });
  });

  it('reads scope, requested_token_type and authorization_details', () => {
    const parsed = parseTokenExchangeRequest({
      ...base, resource: MERCHANT, scope: 'read', requested_token_type: ACCESS_TOKEN,
      authorization_details: JSON.stringify([{ type: COMMERCE, amount_range: { currency: 'EUR', max: '20.00' } }]),
    });
    expect(parsed.scopes).toEqual(['read']);
    expect(parsed.authorizationDetails).toEqual([{ type: COMMERCE, amount_range: { currency: 'EUR', max: '20.00' } }]);
    expect(parseTokenExchangeRequest({ ...base, resource: MERCHANT }).scopes).toBeUndefined();
  });

  it('refuses a request that is not valid, with the RFC 8693 §2.2.2 error', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...base, subject_token: undefined, resource: MERCHANT }, 'invalid_request'],
      [{ ...base, subject_token_type: 'urn:ietf:params:oauth:token-type:id_token', resource: MERCHANT }, 'invalid_request'],
      [{ ...base, requested_token_type: 'urn:ietf:params:oauth:token-type:refresh_token', resource: MERCHANT }, 'invalid_request'],
      [{ ...base, actor_token: 'eyJ.actor', actor_token_type: ACCESS_TOKEN, resource: MERCHANT }, 'invalid_request'],
      [{ ...base, subject_token: ['a', 'b'], resource: MERCHANT }, 'invalid_request'],
      [{ ...base }, 'invalid_request'],
      [{ ...base, resource: [MERCHANT, OTHER] }, 'invalid_target'],
      [{ ...base, resource: MERCHANT, audience: OTHER }, 'invalid_target'],
      [{ ...base, resource: 'https://merchant.example/checkout' }, 'invalid_target'],
      [{ ...base, resource: MERCHANT, scope: '' }, 'invalid_scope'],
      [{ ...base, resource: MERCHANT, scope: 'read  write' }, 'invalid_scope'],
      [{ ...base, resource: MERCHANT, authorization_details: '{not json' }, 'invalid_authorization_details'],
      [{ ...base, resource: MERCHANT, authorization_details: { type: COMMERCE } }, 'invalid_authorization_details'],
    ];
    for (const [body, error] of cases) {
      expect(refusal(() => parseTokenExchangeRequest(body)).error, JSON.stringify(body)).toBe(error);
    }
  });
});

describe('attenuateConstraints (decision 3; RFC 9396 §6)', () => {
  const parent = {
    allowed_merchants: [MERCHANT, OTHER],
    amount_range: { currency: 'EUR', min: '1.00', max: '250.00' },
    budget: { amount: '500.00', currency: 'EUR' },
  };

  it('narrows allowed_merchants to the one merchant and keeps the parent limits', () => {
    expect(attenuateConstraints(parent, MERCHANT, undefined)).toEqual({ ...parent, allowed_merchants: [MERCHANT] });
  });

  it('takes narrower limits the request asks for', () => {
    expect(attenuateConstraints(parent, OTHER, [{
      type: COMMERCE,
      allowed_merchants: [OTHER],
      amount_range: { currency: 'EUR', min: '2.00', max: '20.00' },
      budget: { amount: '100', currency: 'EUR' },
    }])).toEqual({
      allowed_merchants: [OTHER],
      amount_range: { currency: 'EUR', min: '2.00', max: '20.00' },
      budget: { amount: '100', currency: 'EUR' },
    });
    // A parent without a limit is not narrowed by leaving the limit out, and
    // any limit the child asks for is narrower.
    expect(attenuateConstraints({ allowed_merchants: [MERCHANT] }, MERCHANT, [{
      type: COMMERCE, amount_range: { currency: 'EUR', max: '5.00' },
    }])).toEqual({ allowed_merchants: [MERCHANT], amount_range: { currency: 'EUR', max: '5.00' } });
  });

  it('refuses a merchant outside allowed_merchants with audience_mismatch', () => {
    for (const [constraints, merchant] of [
      [parent, 'https://elsewhere.example'],
      [null, MERCHANT],
    ] as const) {
      const err = refusal(() => attenuateConstraints(constraints, merchant, undefined));
      expect(err.code).toBe('audience_mismatch');
      expect(err.statusCode).toBe(400);
    }
  });

  it('refuses any widening with invalid_authorization_details', () => {
    const wider: unknown[] = [
      [{ type: COMMERCE, allowed_merchants: [MERCHANT, OTHER] }],
      [{ type: COMMERCE, allowed_merchants: [OTHER] }],
      [{ type: COMMERCE, amount_range: { currency: 'EUR', max: '250.01' } }],
      [{ type: COMMERCE, amount_range: { currency: 'EUR', min: '0.50', max: '10.00' } }],
      [{ type: COMMERCE, amount_range: { currency: 'USD', max: '10.00' } }],
      [{ type: COMMERCE, budget: { amount: '500.000001', currency: 'EUR' } }],
      [{ type: COMMERCE, budget: { amount: '10', currency: 'USD' } }],
      [{ type: 'urn:grantex:tools:v1', connector: 'checkout' }],
      [{ type: COMMERCE, passport: { issuer: 'https://issuer.example' } }],
      [{ type: COMMERCE }, { type: COMMERCE }],
    ];
    for (const requested of wider) {
      const err = refusal(() => attenuateConstraints(parent, MERCHANT, requested));
      expect(err.error, JSON.stringify(requested)).toBe('invalid_authorization_details');
      expect(err.code).toBe('invalid_authorization_details');
      expect(err.statusCode).toBe(400);
    }
  });
});

describe('childGrantExpiry', () => {
  const now = 1_790_000_000;
  it('is at most 900 s, and never after the subject token, the grant or the passport', () => {
    expect(CHILD_GRANT_MAX_LIFETIME_SECONDS).toBe(900);
    const far = now + 86_400;
    expect(childGrantExpiry({ now, subjectExp: far, grantExpiresAt: far, notAfter: far })).toBe(now + 900);
    expect(childGrantExpiry({ now, subjectExp: now + 300, grantExpiresAt: far, notAfter: far })).toBe(now + 300);
    expect(childGrantExpiry({ now, subjectExp: far, grantExpiresAt: now + 200, notAfter: far })).toBe(now + 200);
    expect(childGrantExpiry({ now, subjectExp: far, grantExpiresAt: far, notAfter: now + 100 })).toBe(now + 100);
  });
});

describe('POST /v1/token with PASSPORT_BOUND_GRANTS_ENABLED off', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const exchange = {
    grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
    subject_token: 'eyJ.subject.token',
    subject_token_type: ACCESS_TOKEN,
    resource: MERCHANT,
  };

  for (const value of [undefined, 'TRUE', '1']) {
    it(`answers a JSON token exchange as a code exchange without a code (flag=${String(value)})`, async () => {
      if (value !== undefined) vi.stubEnv('PASSPORT_BOUND_GRANTS_ENABLED', value);
      seedAuth();
      const res = await app.inject({ method: 'POST', url: '/v1/token', headers: authHeader(), payload: exchange });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ message: 'code and agentId are required', code: 'BAD_REQUEST' });
    });

    it(`answers a form-encoded body 415, as it always has (flag=${String(value)})`, async () => {
      if (value !== undefined) vi.stubEnv('PASSPORT_BOUND_GRANTS_ENABLED', value);
      seedAuth();
      const res = await app.inject({
        method: 'POST', url: '/v1/token',
        headers: { ...authHeader(), 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams(exchange).toString(),
      });
      expect(res.statusCode).toBe(415);
    });
  }

  it('with the flag on, refuses an invalid token exchange before reading anything', async () => {
    vi.stubEnv('PASSPORT_BOUND_GRANTS_ENABLED', 'true');
    seedAuth();
    const res = await app.inject({
      method: 'POST', url: '/v1/token',
      headers: { ...authHeader(), 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ ...exchange, resource: 'https://merchant.example/checkout' }).toString(),
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_target', code: 'invalid_target' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('with the flag on, a form-encoded code exchange is still 415', async () => {
    vi.stubEnv('PASSPORT_BOUND_GRANTS_ENABLED', 'true');
    seedAuth();
    const res = await app.inject({
      method: 'POST', url: '/v1/token',
      headers: { ...authHeader(), 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ code: 'c', agentId: 'ag_1' }).toString(),
    });
    expect(res.statusCode).toBe(415);
  });
});

describe('POST /v1/token token exchange: proof of the bound key (RFC 9449), flag on', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const TOKEN_ENDPOINT = 'https://grantex.dev/v1/token';
  const exchange = {
    grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
    subject_token: 'eyJ.subject.token',
    subject_token_type: ACCESS_TOKEN,
    resource: MERCHANT,
  };

  async function proof(claims: Record<string, unknown> = {}): Promise<string> {
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const jwk = await exportJWK(publicKey);
    return new SignJWT({ htm: 'POST', htu: TOKEN_ENDPOINT, jti: randomUUID(), iat: Math.floor(Date.now() / 1000), ...claims })
      .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk })
      .sign(privateKey);
  }

  async function send(headers: Record<string, string> = {}) {
    vi.stubEnv('PASSPORT_BOUND_GRANTS_ENABLED', 'true');
    seedAuth();
    const res = await app.inject({
      method: 'POST', url: '/v1/token',
      headers: { ...authHeader(), 'content-type': 'application/x-www-form-urlencoded', ...headers },
      payload: new URLSearchParams(exchange).toString(),
    });
    return res;
  }

  it('refuses an exchange without a DPoP proof, before reading the subject token', async () => {
    const res = await send();
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_dpop_proof', code: 'invalid_dpop_proof', reason: 'dpop_proof_missing' });
    expect(res.json<Record<string, unknown>>()['error_description']).toEqual(expect.any(String));
    expect(res.headers['cache-control']).toBe('no-store');
    // Only the API key was looked up: nothing about the subject was read.
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a proof for another method or another URI', async () => {
    for (const [claims, reason] of [
      [{ htm: 'GET' }, 'dpop_htm_mismatch'],
      [{ htu: 'https://grantex.dev/oauth/token' }, 'dpop_htu_mismatch'],
    ] as const) {
      const res = await send({ dpop: await proof(claims) });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json(), JSON.stringify(claims)).toMatchObject({ error: 'invalid_dpop_proof', code: 'invalid_dpop_proof', reason });
    }
  });

  it('refuses a replayed proof (the jti store already holds it)', async () => {
    mockRedis.set.mockResolvedValue(null);
    const res = await send({ dpop: await proof() });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_dpop_proof', reason: 'dpop_proof_replayed' });
  });

  it('records the exchange in the token exchange metrics, refusals included', async () => {
    // prom-client is mocked (tests/setup.ts): the counter's inc and the
    // histogram's timer are spies.
    const endTimer = vi.fn();
    vi.mocked(tokenExchangeDuration.startTimer).mockReturnValueOnce(endTimer as never);
    vi.mocked(tokenExchangeTotal.inc).mockClear();
    const res = await send();
    expect(res.statusCode, res.body).toBe(400);
    // The mocked counters share one inc: keep the calls with a status label.
    expect(statusCalls()).toEqual([{ status: 'failed' }]);
    expect(endTimer).toHaveBeenCalledTimes(1);
  });
});

function statusCalls(): unknown[] {
  return vi.mocked(tokenExchangeTotal.inc).mock.calls
    .map((call) => call[0] as unknown)
    .filter((labels) => typeof labels === 'object' && labels !== null && 'status' in labels);
}
