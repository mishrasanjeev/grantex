// SPDX-License-Identifier: Apache-2.0
/**
 * RSA-PSS (RFC 9421 section 3.3.1, `rsa-pss-sha512`): sign and verify round
 * trips under the tap and web-bot-auth profiles and for TAP body objects,
 * the 2048-bit minimum, and the grantex profile staying P-256 / Ed25519 only.
 * The RFC's own RSA-PSS signatures are verified in rfc9421.test.ts (PSS is
 * randomized, so they are verification vectors).
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AgentHttpSigError,
  InMemoryNonceStore,
  buildAgenticPaymentContainer,
  jwkThumbprint,
  publicJwk,
  sign,
  signWithProfile,
  verify,
  verifySignatureValue,
  verifyTapBodyObjects,
  verifyWithProfile,
} from '../src/index.js';
import type { AgentJwk } from '../src/index.js';

const NOW = 1_790_000_000;
const rsa = (bits: number): AgentJwk => generateKeyPairSync('rsa', { modulusLength: bits }).privateKey.export({ format: 'jwk' });
const key = rsa(2048);
const request = () => ({
  method: 'POST',
  url: 'https://merchant.example/v1/checkout',
  headers: { 'content-type': 'application/json' } as Record<string, string>,
  body: '{"cart_id":"c-1001"}',
});

describe('rsa-pss-sha512', () => {
  it('signs and verifies under the tap profile, with a randomized signature each time', async () => {
    const req = request();
    const a = signWithProfile(req, { profile: 'tap', key, keyid: 'rsa-key-01', created: NOW, nonce: 'n-1' });
    const b = signWithProfile(req, { profile: 'tap', key, keyid: 'rsa-key-01', created: NOW, nonce: 'n-1' });
    expect(a.alg).toBe('rsa-pss-sha512');
    expect(a.headers['Signature-Input']).toContain('alg="rsa-pss-sha512"');
    expect(a.signatureBase).toBe(b.signatureBase);
    expect(a.headers.Signature).not.toBe(b.headers.Signature);
    const out = await verifyWithProfile({ ...req, headers: { ...req.headers, ...a.headers } }, {
      profile: 'tap', expectedAuthority: 'merchant.example', now: NOW + 1, nonceStore: new InMemoryNonceStore(),
      resolveKey: (ref) => (ref.keyid === 'rsa-key-01' ? publicJwk(key) : null),
    });
    expect(out).toMatchObject({ ok: true, alg: 'rsa-pss-sha512' });
    const tampered = { ...req, url: 'https://merchant.example/v1/other', headers: { ...req.headers, ...a.headers } };
    expect(await verifyWithProfile(tampered, {
      profile: 'tap', expectedAuthority: 'merchant.example', now: NOW + 1, nonceStore: new InMemoryNonceStore(), resolveKey: () => publicJwk(key),
    })).toMatchObject({ ok: false, reason: 'signature_mismatch' });
  });

  it('signs and verifies under the web-bot-auth profile with the RFC 7638 RSA thumbprint as keyid', async () => {
    const req = request();
    const s = signWithProfile(req, { profile: 'web-bot-auth', key, created: NOW, signatureAgent: { url: 'https://agents.example' } });
    expect(s.keyid).toBe(jwkThumbprint(key));
    const out = await verifyWithProfile({ ...req, headers: { ...req.headers, ...s.headers } }, {
      profile: 'web-bot-auth', expectedAuthority: 'merchant.example', now: NOW + 1, nonceStore: new InMemoryNonceStore(),
      resolveKey: () => publicJwk(key),
    });
    expect(out).toMatchObject({ ok: true, alg: 'rsa-pss-sha512' });
  });

  it('refuses keys under 2048 bits, to sign and to verify', async () => {
    const small = rsa(1024);
    expect(() => signWithProfile(request(), { profile: 'tap', key: small, created: NOW })).toThrow(/2048-bit/);
    const req = request();
    const s = signWithProfile(req, { profile: 'tap', key, keyid: 'k', created: NOW });
    expect(await verifyWithProfile({ ...req, headers: { ...req.headers, ...s.headers } }, {
      profile: 'tap', expectedAuthority: 'merchant.example', now: NOW + 1, nonceStore: new InMemoryNonceStore(), resolveKey: () => ({ kty: 'RSA', n: small.n, e: small.e }),
    })).toMatchObject({ ok: false, reason: 'key_mismatch' });
    expect(() => publicJwk(small)).toThrow(AgentHttpSigError);
    expect(verifySignatureValue({ kty: 'RSA', n: small.n, e: small.e }, 'x', new Uint8Array(128))).toBe(false);
  });

  it('keeps the grantex profile to P-256 and Ed25519', async () => {
    expect(() => sign(request(), { key, agentPassport: 'p', agentGrant: 'g' })).toThrow(/P-256 or Ed25519/);
    const ed = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
    const req = request();
    const s = sign(req, { key: ed, agentPassport: 'passport-placeholder', agentGrant: 'grant-placeholder', created: NOW });
    expect(await verify({ ...req, headers: { ...req.headers, ...s.headers } }, {
      expectedAuthority: 'merchant.example', now: NOW + 1, nonceStore: new InMemoryNonceStore(), resolveKey: () => publicJwk(key),
    })).toMatchObject({ ok: false, reason: 'key_mismatch' });
  });

  it('signs TAP body objects with PS512', async () => {
    const container = buildAgenticPaymentContainer({ key, kid: 'rsa-key-01', nonce: 'n-1', paymentCredentialsHash: 'h' });
    expect(container['alg']).toBe('PS512');
    const out = await verifyTapBodyObjects({ agenticPaymentContainer: container }, { nonce: 'n-1', keyid: 'rsa-key-01', resolveKey: () => publicJwk(key) });
    expect(out.paymentContainer.usableForPayment).toBe(true);
  });
});
