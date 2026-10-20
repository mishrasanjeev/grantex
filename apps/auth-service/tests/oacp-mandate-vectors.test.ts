// SPDX-License-Identifier: Apache-2.0
/**
 * The OACP mandate JWT profile against the shared vectors
 * (spec/examples/oacp/oacp-mandates-v1.json): every case refuses with exactly
 * the expected code, every chain case with the expected chain refusal, and
 * the issuer's signer produces what the verifier accepts. The SDK verifiers
 * run the same file.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  oacpCheckoutHash,
  oacpMandateChainRefusal,
  oacpMandateHash,
  signOacpMandate,
  verifyOacpMandate,
  type OacpCartClaims,
  type OacpIntentClaims,
  type OacpMandateStatusValue,
  type OacpMandateType,
  type OacpPaymentClaims,
} from '../src/lib/commerce/oacp-mandate-jwt.js';

interface Vectors {
  issuer: string;
  verify_at: number;
  expected_audience: string;
  jwks: { keys: Array<Record<string, unknown>> };
  checkout: unknown;
  checkout_canonical: string;
  checkout_hash: string;
  cases: Array<{ name: string; mandate: string; expected_type?: OacpMandateType; expected_audience?: string; status?: OacpMandateStatusValue; expect: string | null }>;
  chains: Array<{ name: string; intent: string; cart: string; payment?: string; expect: string | null }>;
}

const vectors = JSON.parse(readFileSync(join(__dirname, '../../../spec/examples/oacp/oacp-mandates-v1.json'), 'utf8')) as Vectors;

function verify(mandate: string, extra: { expected_type?: OacpMandateType | undefined; expected_audience?: string | undefined; status?: OacpMandateStatusValue | undefined } = {}) {
  return verifyOacpMandate({
    mandate,
    jwks: vectors.jwks,
    issuer: vectors.issuer,
    now_seconds: vectors.verify_at,
    status: extra.status ?? 0,
    expected_type: extra.expected_type,
    expected_audience: extra.expected_audience ?? vectors.expected_audience,
  });
}

describe('OACP mandate vectors', () => {
  it('derives the AP2 checkout_hash from the RFC 8785 checkout', () => {
    expect(oacpCheckoutHash(vectors.checkout)).toBe(vectors.checkout_hash);
  });

  for (const c of vectors.cases) {
    it(`case ${c.name} -> ${c.expect ?? 'valid'}`, () => {
      const result = verify(c.mandate, c);
      expect(result.refusal_code).toBe(c.expect);
      expect(result.valid).toBe(c.expect === null);
    });
  }

  for (const chain of vectors.chains) {
    it(`chain ${chain.name} -> ${chain.expect ?? 'consistent'}`, () => {
      const intent = verify(chain.intent, { expected_type: 'intent' });
      const cart = verify(chain.cart, { expected_type: 'cart' });
      const payment = chain.payment ? verify(chain.payment, { expected_type: 'payment' }) : null;
      expect([intent.valid, cart.valid, payment?.valid ?? true]).toEqual([true, true, true]);
      expect(oacpMandateChainRefusal({
        intent: intent.claims as unknown as OacpIntentClaims,
        cart: cart.claims as unknown as OacpCartClaims,
        payment: (payment?.claims ?? undefined) as unknown as OacpPaymentClaims | undefined,
      })).toBe(chain.expect);
    });
  }

  it('signs what it verifies, and refuses a non-OACP or non-P-256 signing key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pub = publicKey.export({ format: 'jwk' });
    const kid = 'oacp-20261020-0123456789abcdef';
    const claims = JSON.parse(Buffer.from(vectors.cases[0]!.mandate.split('.')[1]!, 'base64url').toString()) as OacpIntentClaims;
    const signed = signOacpMandate('intent', claims, { kid, privateKey, publicJwk: {} });
    expect(verifyOacpMandate({
      mandate: signed,
      jwks: { keys: [{ kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y, kid, alg: 'ES256', use: 'sig' }] },
      issuer: vectors.issuer, now_seconds: vectors.verify_at, status: 0,
    })).toMatchObject({ valid: true, mandate_type: 'intent' });
    expect(oacpMandateHash(signed)).toMatch(/^[0-9a-f]{64}$/);
    expect(() => signOacpMandate('intent', claims, { kid: 'commerce-passport-x', privateKey, publicJwk: {} })).toThrow();
    const ed = generateKeyPairSync('ed25519');
    expect(() => signOacpMandate('intent', claims, { kid, privateKey: ed.privateKey, publicJwk: {} })).toThrow();
  });
});
