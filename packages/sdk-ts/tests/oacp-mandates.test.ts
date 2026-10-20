/**
 * verifyOacpMandate and checkOacpMandateChain against the shared mandate
 * vectors (spec/examples/oacp/oacp-mandates-v1.json), the same file the auth
 * service verifier runs, plus the status-list path with a Status List Token
 * signed by a key generated for this test.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  OACP_MANDATE_REFUSAL_CODES,
  checkOacpMandateChain,
  oacpCheckoutHash,
  oacpMandateHash,
  verifyOacpMandate,
  type OacpJwks,
  type OacpMandateType,
} from '../src/index.js';

interface Vectors {
  issuer: string;
  verify_at: number;
  expected_audience: string;
  jwks: OacpJwks;
  checkout: unknown;
  checkout_hash: string;
  cases: Array<{ name: string; mandate: string; expected_type?: OacpMandateType; expected_audience?: string; status?: number | 'unavailable'; expect: string | null }>;
  chains: Array<{ name: string; intent: string; cart: string; payment?: string; expect: string | null }>;
}

const VECTORS = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'spec', 'examples', 'oacp', 'oacp-mandates-v1.json'),
  'utf-8',
)) as Vectors;
const NOW = new Date(VECTORS.verify_at * 1000);
const base = { issuer: VECTORS.issuer, jwks: VECTORS.jwks, now: NOW, expectedAudience: VECTORS.expected_audience };

describe('OACP mandate vectors', () => {
  it('derives the AP2 checkout_hash from the RFC 8785 checkout', () => {
    expect(oacpCheckoutHash(VECTORS.checkout)).toBe(VECTORS.checkout_hash);
  });

  for (const c of VECTORS.cases) {
    it(`${c.name} -> ${c.expect ?? 'valid'}`, async () => {
      const result = await verifyOacpMandate(c.mandate, {
        ...base,
        ...(c.expected_type ? { expectedType: c.expected_type } : {}),
        ...(c.expected_audience ? { expectedAudience: c.expected_audience } : {}),
        status: c.status ?? 0,
      });
      if (c.expect === null) {
        expect(result).toMatchObject({ valid: true, status: 'valid', mandateHash: oacpMandateHash(c.mandate) });
      } else {
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.refusalCode).toBe(c.expect);
          expect(OACP_MANDATE_REFUSAL_CODES).toContain(result.refusalCode);
        }
      }
    });
  }

  for (const chain of VECTORS.chains) {
    it(`chain ${chain.name} -> ${chain.expect ?? 'consistent'}`, async () => {
      const verified = await Promise.all([chain.intent, chain.cart, chain.payment].map((m) =>
        m === undefined ? Promise.resolve(undefined) : verifyOacpMandate(m, { ...base, checkStatus: false })));
      const claims = verified.map((v) => {
        if (v === undefined) return undefined;
        expect(v.valid).toBe(true);
        return v.valid ? v.claims : undefined;
      });
      expect(checkOacpMandateChain({
        ...(claims[0] ? { intent: claims[0] } : {}),
        ...(claims[1] ? { cart: claims[1] } : {}),
        ...(claims[2] ? { payment: claims[2] } : {}),
      })).toBe(chain.expect);
    });
  }
});

describe('OACP mandate status list', () => {
  const intent = VECTORS.cases.find((c) => c.name === 'valid_intent')!.mandate;
  const claims = JSON.parse(Buffer.from(intent.split('.')[1]!, 'base64url').toString()) as { status: { status_list: { idx: number; uri: string } } };
  const { uri, idx } = claims.status.status_list;
  const statusKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwks: OacpJwks = { keys: [...VECTORS.jwks.keys, { ...statusKey.publicKey.export({ format: 'jwk' }), kid: 'status-test-es', alg: 'ES256', use: 'sig' }] };

  function token(status: number): string {
    const bytes = Buffer.alloc(16);
    bytes[Math.floor(idx / 4)]! |= status << ((idx % 4) * 2);
    const b64u = (v: string | Buffer) => Buffer.from(v).toString('base64url');
    const input = `${b64u(JSON.stringify({ alg: 'ES256', kid: 'status-test-es', typ: 'statuslist+jwt' }))}.${b64u(JSON.stringify({
      iss: VECTORS.issuer, sub: uri, iat: VECTORS.verify_at - 30, exp: VECTORS.verify_at + 3600, ttl: 30,
      status_list: { bits: 2, lst: deflateSync(bytes).toString('base64url') },
    }))}`;
    return `${input}.${b64u(sign('sha256', Buffer.from(input), { key: statusKey.privateKey, dsaEncoding: 'ieee-p1363' }))}`;
  }

  it('reads VALID, INVALID and SUSPENDED from a verified Status List Token, and fails closed without one', async () => {
    for (const [status, expected] of [[0, null], [1, 'mandate_revoked'], [2, 'mandate_suspended']] as const) {
      const result = await verifyOacpMandate(intent, { ...base, jwks, statusListFetcher: async (u) => { expect(u).toBe(uri); return token(status); } });
      expect(result.valid ? null : result.refusalCode).toBe(expected);
    }
    const none = await verifyOacpMandate(intent, { ...base, jwks });
    expect(none).toMatchObject({ valid: false, refusalCode: 'revocation_status_unavailable' });
    const broken = await verifyOacpMandate(intent, { ...base, jwks, statusListFetcher: async () => { throw new Error('offline'); } });
    expect(broken).toMatchObject({ valid: false, refusalCode: 'revocation_status_unavailable' });
  });
});

describe('OACP mandate vectors (additional cases)', () => {
  const EXTRA = JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'spec', 'examples', 'oacp', 'oacp-mandates-v1-extra.json'),
    'utf-8',
  )) as Vectors;
  for (const c of EXTRA.cases) {
    it(`${c.name} -> ${c.expect ?? 'valid'}`, async () => {
      const result = await verifyOacpMandate(c.mandate, {
        issuer: EXTRA.issuer, jwks: EXTRA.jwks, now: new Date(EXTRA.verify_at * 1000), expectedAudience: EXTRA.expected_audience,
        ...(c.expected_type ? { expectedType: c.expected_type } : {}), status: c.status ?? 0,
      });
      expect(result.valid ? null : result.refusalCode).toBe(c.expect);
    });
  }
});
