// SPDX-License-Identifier: Apache-2.0
/**
 * TAP body objects (agenticConsumer, agenticPaymentContainer) bound to a TAP
 * message signature, and the Grantex consent record object (G49).
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AgentHttpSigError,
  DEFAULT_TAP_BODY_MEMBERS,
  InMemoryNonceStore,
  buildAgenticConsumer,
  buildAgenticPaymentContainer,
  buildGrantexConsentRecord,
  canonicalJson,
  publicJwk,
  signWithProfile,
  verifyTapBodyObjects,
  verifyWithProfile,
  withTapBodyObjects,
} from '../src/index.js';
import type { AgentJwk, GrantexConsentSource } from '../src/index.js';

const NOW = 1_790_000_000;
const ID_TOKEN = 'eyJhbGciOiJQUzI1NiJ9.eyJzdWIiOiJzaG9wcGVyLTAxIn0.c2lnbmF0dXJlLXBsYWNlaG9sZGVy';
const keys: Record<string, AgentJwk> = {
  ed25519: generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }),
  p256: generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }),
};

const consent: GrantexConsentSource = {
  id: 'ccr_01J9EXAMPLE',
  merchantId: 'mer_example',
  agentId: 'shopper-01',
  passportType: 'checkout',
  status: 'granted',
  approvedScopes: ['commerce:checkout'],
  maxAmount: 250000,
  currency: 'INR',
  consentTextVersion: '2026-05-01',
  presentedPayloadHash: 'sha-256:placeholder',
  approvedAt: '2026-10-20T10:00:00.000Z',
  expiresAt: '2026-10-20T10:10:00.000Z',
};

describe('RFC 8785 canonical JSON', () => {
  it('sorts members by UTF-16 code units (section 3.2.3 example)', () => {
    const names = ['€', '\r', 'דּ', '1', '😀', '\u0080', 'ö'];
    const value = Object.fromEntries(names.map((n, i) => [n, i]));
    const text = canonicalJson(value);
    // Integer-like keys come first in a JavaScript object, so read the order from the text.
    const expected = ['\r', '1', '\u0080', 'ö', '€', '😀', 'דּ'];
    const positions = expected.map((k) => text.indexOf(`${JSON.stringify(k)}:`));
    expect(positions.every((at, i) => at >= 0 && (i === 0 || at > positions[i - 1]!))).toBe(true);
    expect(canonicalJson({ b: [true, null, 'x'], a: 1, u: undefined })).toBe('{"a":1,"b":[true,null,"x"]}');
  });
});

for (const [name, key] of Object.entries(keys)) {
  describe(`TAP body objects (${name})`, () => {
    it('are bound to the message signature nonce and kid, and verify', async () => {
      const req = {
        method: 'POST',
        url: 'https://merchant.example/v1/checkout',
        headers: { 'content-type': 'application/json' } as Record<string, string>,
      };
      // The nonce is chosen first so the body objects and the signature share it.
      const nonce = 'b1c3e5f7-0000-4000-8000-000000000001';
      const consumer = buildAgenticConsumer({ key, kid: 'primary-key-01', nonce, idToken: ID_TOKEN, contextualData: { countryCode: 'IN', zip: '560001' } });
      const container = buildAgenticPaymentContainer({ key, kid: 'primary-key-01', nonce, paymentCredentialsHash: 'hash-placeholder' });
      const record = buildGrantexConsentRecord(consent, { nonce, now: new Date('2026-10-20T10:05:00Z') });
      const body = JSON.stringify(withTapBodyObjects({ cart_id: 'c-1001' }, { consumer, paymentContainer: container, consentRecord: record }));
      const signed = signWithProfile({ ...req, body }, {
        profile: 'tap', key, keyid: 'primary-key-01', nonce, created: NOW,
        components: ['@method', '@authority', '@path', 'content-digest'],
      });
      const message = { ...req, headers: { ...req.headers, ...signed.headers }, body };
      const pub = publicJwk(key);
      const verified = await verifyWithProfile(message, {
        profile: 'tap', expectedAuthority: 'merchant.example', now: NOW + 1, nonceStore: new InMemoryNonceStore(),
        resolveKey: (ref) => (ref.keyid === 'primary-key-01' ? pub : null), requiredComponents: ['content-digest'],
      });
      if (!verified.ok) throw new Error(verified.reason);
      const out = await verifyTapBodyObjects(JSON.parse(body), {
        nonce: verified.nonce!, keyid: verified.keyid, resolveKey: (kid) => (kid === 'primary-key-01' ? pub : null),
      });
      expect(out.consumer).toEqual({ present: true, verified: true, problems: [] });
      expect(out.paymentContainer).toEqual({ present: true, verified: true, problems: [], usableForPayment: true });
      expect(out.consentRecord).toEqual({ present: true, nonceMatches: true, consentId: 'ccr_01J9EXAMPLE' });
      expect(consumer['alg']).toBe(name === 'p256' ? 'ES256' : 'EdDSA');
    });
  });
}

describe('TAP body object failures', () => {
  const key = keys.ed25519!;
  const pub = publicJwk(key);
  const nonce = 'n-1';
  const base = { nonce, keyid: 'k1', resolveKey: (kid: string) => (kid === 'k1' ? pub : null) };
  const consumer = buildAgenticConsumer({ key, kid: 'k1', nonce, idToken: ID_TOKEN });
  const container = buildAgenticPaymentContainer({ key, kid: 'k1', nonce, credentialHash: 'hash-placeholder' });

  it('a nonce that differs from the message signature: consumer soft, container unusable', async () => {
    const out = await verifyTapBodyObjects({ agenticConsumer: consumer, agenticPaymentContainer: container }, { ...base, nonce: 'n-2' });
    expect(out.consumer).toMatchObject({ verified: false, problems: ['nonce_mismatch'] });
    expect(out.paymentContainer).toMatchObject({ usableForPayment: false, problems: ['nonce_mismatch'] });
  });

  it('a changed member breaks the signature', async () => {
    const tampered = { ...container, credentialHash: 'other' };
    const out = await verifyTapBodyObjects({ agenticPaymentContainer: tampered }, base);
    expect(out.paymentContainer).toMatchObject({ usableForPayment: false, problems: ['signature_invalid'] });
    expect(out.consumer.present).toBe(false);
  });

  it('missing fields, an unknown key, an unsupported algorithm', async () => {
    const { signature: _drop, ...unsigned } = container;
    expect((await verifyTapBodyObjects({ agenticPaymentContainer: unsigned }, base)).paymentContainer.problems).toEqual(['missing_fields']);
    expect((await verifyTapBodyObjects({ agenticPaymentContainer: container }, { ...base, resolveKey: () => null })).paymentContainer).toMatchObject({
      usableForPayment: false,
      problems: ['key_unavailable'],
    });
    expect((await verifyTapBodyObjects({ agenticConsumer: { ...consumer, alg: 'PS256' } }, base)).consumer.problems).toEqual(['algorithm_unsupported']);
  });

  it('a kid that differs from the message keyid is reported', async () => {
    const other = buildAgenticConsumer({ key, kid: 'k2', nonce, idToken: ID_TOKEN });
    const out = await verifyTapBodyObjects({ agenticConsumer: other }, { ...base, resolveKey: () => pub });
    expect(out.consumer.problems).toEqual(['kid_mismatch']);
  });

  it('the canonicalization and the body members are configurable (UNCONFIRMED in the specification)', async () => {
    const canonicalize = (o: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify(o));
    const custom = buildAgenticPaymentContainer({ key, kid: 'k1', nonce, canonicalize });
    const members = { ...DEFAULT_TAP_BODY_MEMBERS, paymentContainer: 'payment_container' };
    const body = withTapBodyObjects({}, { paymentContainer: custom }, members);
    expect(Object.keys(body)).toEqual(['payment_container']);
    expect((await verifyTapBodyObjects(body, { ...base, members, canonicalize })).paymentContainer.usableForPayment).toBe(true);
    expect((await verifyTapBodyObjects(body, { ...base, members })).paymentContainer.usableForPayment).toBe(false);
  });

  it('refuses malformed input at build time', () => {
    expect(() => buildAgenticConsumer({ key, kid: 'k1', nonce, idToken: 'not-a-jwt' })).toThrow(AgentHttpSigError);
    expect(() => buildAgenticConsumer({ key, kid: 'k1', nonce, idToken: ID_TOKEN, contextualData: { countryCode: 'india' } })).toThrow(/alpha-2/);
    expect(() => withTapBodyObjects({ agenticConsumer: 1 }, { consumer })).toThrow(/already has/);
  });
});

describe('Grantex consent record object', () => {
  it('carries the granted consent without a principal identifier', () => {
    const record = buildGrantexConsentRecord(
      { ...consent, userPrincipalId: 'user-secret' } as GrantexConsentSource,
      { nonce: 'n-1', now: new Date('2026-10-20T10:05:00Z') },
    );
    expect(record).toEqual({
      type: 'grantex-consent-record',
      consent_id: 'ccr_01J9EXAMPLE',
      merchant_id: 'mer_example',
      agent_id: 'shopper-01',
      passport_type: 'checkout',
      scopes: ['commerce:checkout'],
      max_amount: 250000,
      currency: 'INR',
      consent_text_version: '2026-05-01',
      presented_payload_hash: 'sha-256:placeholder',
      approved_at: '2026-10-20T10:00:00.000Z',
      expires_at: '2026-10-20T10:10:00.000Z',
      nonce: 'n-1',
    });
    expect(JSON.stringify(record)).not.toContain('user-secret');
  });

  it('refuses a consent that is not granted, has no scopes, or has expired', () => {
    const at = { nonce: 'n-1', now: new Date('2026-10-20T10:05:00Z') };
    expect(() => buildGrantexConsentRecord({ ...consent, status: 'requested' }, at)).toThrow(/granted/);
    expect(() => buildGrantexConsentRecord({ ...consent, approvedScopes: [] }, at)).toThrow(/scopes/);
    expect(() => buildGrantexConsentRecord(consent, { nonce: 'n-1', now: new Date('2026-10-20T10:10:00Z') })).toThrow(/expired/);
  });
});
