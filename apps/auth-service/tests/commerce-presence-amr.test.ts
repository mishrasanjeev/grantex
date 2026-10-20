// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * G44: presence mode (`human_present` | `human_not_present`) and `amr` on the
 * consent record and the Commerce Passport.
 *
 * Before this change neither carried presence, so a relying party could not
 * tell a purchase the buyer confirms from one the buyer delegated. These
 * tests replay that: the passport now carries both claims, read back by the
 * verifier; a passport or consent row from before the change reads as
 * `human_not_present` with no methods (the stricter mode, never the looser).
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, type CryptoKey as KeyLike, type JWK } from 'jose';
import { sqlMock, mockRedis } from './helpers.js';
import { signCommercePassport, verifyCommercePassport, newCommercePassportJti } from '../src/lib/commerce/passport.js';
import { _resetCommercePassportKeyCacheForTests } from '../src/lib/commerce/passport-keys.js';
import {
  CONSENT_APPROVAL_AMR,
  DEFAULT_PRESENCE,
  canonicalPresentedPayload,
  isPresenceMode,
  type ConsentRecord,
} from '../src/lib/commerce/consent.js';

const KID = 'commerce-passport-20261020-presence';
let keys: { privateKey: KeyLike; publicKey: KeyLike };
let publicJwk: JWK;

beforeAll(async () => {
  keys = await generateKeyPair('ES256', { extractable: true });
  publicJwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: 'ES256', use: 'sig' } as JWK;
});

async function primeSigner(): Promise<void> {
  const { encrypt } = await import('../src/lib/vault-crypto.js');
  const privateJwk = await exportJWK(keys.privateKey);
  sqlMock.mockResolvedValueOnce([{
    kid: KID, algorithm: 'ES256', status: 'active', public_key_jwk: publicJwk, created_at: new Date(), retired_at: null,
  }]);
  sqlMock.mockResolvedValueOnce([{ encrypted_private_key_jwk: encrypt(JSON.stringify({ ...privateJwk, kid: KID, alg: 'ES256' })) }]);
}

const KID_SHAPED = 'commerce-passport-20261020-abcdefgh';

function consent(overrides: Partial<ConsentRecord> = {}): ConsentRecord {
  return {
    id: 'crec_PRESENCE', tenantId: 'cten_PRESENCE', merchantId: 'mch_PRESENCE', agentId: 'cag_PRESENCE',
    consentRequestId: 'req_PRESENCE', passportType: 'checkout', requestedScopes: ['commerce:checkout.create'],
    approvedScopes: null, maxAmount: 50000, currency: 'INR', consentTextVersion: '2026-05-01',
    presentedPayloadHash: null, status: 'requested', agentAuthMethod: 'jwt',
    expiresAt: '2026-10-20T10:10:00.000Z', approvedAt: null, deniedAt: null,
    userPrincipalId: null, userPrincipalHint: null, presence: 'human_present', amr: null,
    createdAt: '2026-10-20T10:00:00.000Z', ...overrides,
  };
}

describe('G44 presence and amr on the consent record', () => {
  it('names exactly the two AP2 presence modes and defaults to human_not_present', () => {
    expect(isPresenceMode('human_present')).toBe(true);
    expect(isPresenceMode('human_not_present')).toBe(true);
    expect(isPresenceMode('present')).toBe(false);
    expect(isPresenceMode(undefined)).toBe(false);
    expect(DEFAULT_PRESENCE).toBe('human_not_present');
    expect(CONSENT_APPROVAL_AMR).toEqual(['consent', 'otp']);
  });

  it('puts presence into the payload the buyer approves, so a changed mode changes the hash', () => {
    const present = JSON.parse(canonicalPresentedPayload(consent())) as Record<string, unknown>;
    expect(present['presence']).toBe('human_present');
    expect(canonicalPresentedPayload(consent({ presence: 'human_not_present' })))
      .not.toBe(canonicalPresentedPayload(consent()));
  });

  it('keeps the approved payload of a row written before presence existed byte-identical', () => {
    const legacy = canonicalPresentedPayload(consent({ presence: null }));
    expect(legacy).not.toContain('presence');
  });
});

describe('G44 presence and amr on the Commerce Passport', () => {
  it('signs presence and amr and the verifier reads them back', async () => {
    _resetCommercePassportKeyCacheForTests();
    await primeSigner();
    const now = Math.floor(Date.now() / 1000);
    const { jwt } = await signCommercePassport(sqlMock as never, {
      jti: newCommercePassportJti(), passportType: 'checkout', tenantId: 'cten_P', merchantId: 'mch_P',
      agentId: 'cag_P', consentRecordId: 'crec_P', subject: 'user_P', scopes: ['commerce:payment.initiate'],
      maxAmount: 50000, currency: 'INR', presence: 'human_present', amr: ['consent', 'otp'],
      environment: 'sandbox', issuedAt: now, notBefore: now, expiresAt: now + 600,
    });
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(claims['presence']).toBe('human_present');
    expect(claims['amr']).toEqual(['consent', 'otp']);
    sqlMock.mockResolvedValueOnce([{ public_key_jwk: publicJwk }]);
    const verified = await verifyCommercePassport(sqlMock as never, mockRedis as never, jwt, { mode: 'read_only' });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.passport.presence).toBe('human_present');
      expect(verified.passport.amr).toEqual(['consent', 'otp']);
    }
  });

  it('reads a passport issued before presence existed as human_not_present with no methods', async () => {
    const legacyKeys = await generateKeyPair('ES256', { extractable: true });
    const jwk = { ...(await exportJWK(legacyKeys.publicKey)), kid: KID_SHAPED, alg: 'ES256', use: 'sig' } as JWK;
    const now = Math.floor(Date.now() / 1000);
    const jwt = await new SignJWT({
      passport_type: 'checkout', tenant_id: 'cten_P', merchant_id: 'mch_P', agent_id: 'cag_P',
      consent_record_id: 'crec_P', scopes: ['commerce:payment.initiate'], env: 'sandbox', ver: '1',
    })
      .setProtectedHeader({ alg: 'ES256', kid: KID_SHAPED })
      .setIssuer('https://grantex.dev').setAudience('grantex-commerce').setSubject('user_P')
      .setJti('cpsp_LEGACY').setIssuedAt(now).setNotBefore(now).setExpirationTime(now + 600)
      .sign(legacyKeys.privateKey);
    sqlMock.mockResolvedValueOnce([{ public_key_jwk: jwk }]);
    const verified = await verifyCommercePassport(sqlMock as never, mockRedis as never, jwt, { mode: 'read_only' });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.passport.presence).toBe('human_not_present');
      expect(verified.passport.amr).toEqual([]);
    }
  });
});
