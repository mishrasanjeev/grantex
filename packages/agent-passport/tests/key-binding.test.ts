// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KB_MAX_AGE_SECONDS,
  KB_JWT_TYP,
  PassportError,
  createKeyBindingJwt,
  externalCredentialHash,
  issuePassport,
  selectDisclosures,
  verifyPassport,
  type Jwk,
  type VerifyPassportOptions,
} from '../src/index.ts';
import { decodeJwsUnverified, signJws } from '../src/jws.ts';
import { NOW, PROFILE_CLAIMS, ed25519KeyPair, p256KeyPair, passportParams, resolverFor } from './helpers.ts';

const issuer = p256KeyPair('mock-issuer-2026');
const holder = p256KeyPair();
const AUD = 'https://merchant.example';
const NONCE = 'n-0S6_WzA2Mj';

function options(compact: string, extra: Partial<VerifyPassportOptions> = {}): VerifyPassportOptions {
  return {
    compact,
    issuerKeys: resolverFor(issuer.publicJwk),
    now: NOW,
    keyBinding: { aud: AUD, nonce: NONCE },
    statusCheckedBy: 'caller',
    ...extra,
  };
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; reason: string }> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PassportError);
    const e = error as PassportError;
    return { code: e.code, reason: e.reason };
  }
  throw new Error('expected a refusal');
}

function present(disclose: string[] = ['provider', 'agent'], key: Jwk = holder.privateJwk, iat = NOW): string {
  const issued = issuePassport(passportParams(issuer, holder));
  const sdJwt = selectDisclosures(issued.compact, disclose);
  return createKeyBindingJwt({ sdJwt, holderKey: key, aud: AUD, nonce: NONCE, iat });
}

describe('key binding (RFC 9901 section 4.3)', () => {
  it('creates a kb+jwt over the presented disclosures with sd_hash, aud, nonce and iat', () => {
    const presentation = present();
    const parts = presentation.split('~');
    const kbJwt = parts.at(-1) as string;
    const sdJwt = presentation.slice(0, presentation.length - kbJwt.length);
    const { header, payload } = decodeJwsUnverified(kbJwt);
    expect(KB_JWT_TYP).toBe('kb+jwt');
    expect(header).toEqual({ alg: 'ES256', typ: 'kb+jwt' });
    expect(payload).toEqual({
      iat: NOW,
      aud: AUD,
      nonce: NONCE,
      sd_hash: createHash('sha256').update(sdJwt, 'ascii').digest('base64url'),
    });
    // Two disclosures selected, and the SD-JWT part ends with a tilde (section 4.3.1).
    expect(parts).toHaveLength(4);
    expect(sdJwt.endsWith('~')).toBe(true);
  });

  it('verifies a presentation and reports the key binding', async () => {
    const presentation = present();
    const result = await verifyPassport(options(presentation));
    expect(result.keyBinding).toEqual({ aud: AUD, nonce: NONCE, iat: NOW });
    expect(result.disclosed).toEqual({ provider: PROFILE_CLAIMS.provider, agent: PROFILE_CLAIMS.agent });
    // The hash rule ignores the KB-JWT and the disclosures.
    expect(result.externalCredentialHash).toBe(externalCredentialHash(`${presentation.split('~')[0]}~`));
  });

  it('works with an Ed25519 holder key when EdDSA is enabled', async () => {
    const edHolder = ed25519KeyPair();
    const issued = issuePassport(passportParams(issuer, edHolder));
    const presentation = createKeyBindingJwt({ sdJwt: issued.compact, holderKey: edHolder.privateJwk, aud: AUD, nonce: NONCE, iat: NOW });
    expect(await refusal(verifyPassport(options(presentation)))).toEqual({
      code: 'passport_not_accepted',
      reason: 'eddsa_not_enabled',
    });
    expect((await verifyPassport(options(presentation, { allowEdDSA: true }))).keyBinding?.aud).toBe(AUD);
  });

  it('requires a KB-JWT when key binding is asked for', async () => {
    const issued = issuePassport(passportParams(issuer, holder));
    expect(await refusal(verifyPassport(options(issued.compact)))).toEqual({
      code: 'key_unproven',
      reason: 'key_binding_missing',
    });
  });

  it('refuses a KB-JWT signed by a key other than cnf', async () => {
    const other = p256KeyPair();
    expect(await refusal(verifyPassport(options(present(['agent'], other.privateJwk))))).toEqual({
      code: 'key_binding_mismatch',
      reason: 'kb_signature_mismatch',
    });
  });

  it('refuses the wrong audience with audience_mismatch', async () => {
    expect(await refusal(verifyPassport(options(present(), { keyBinding: { aud: 'https://other.example', nonce: NONCE } })))).toEqual({
      code: 'audience_mismatch',
      reason: 'audience_mismatch',
    });
  });

  it('refuses the wrong nonce', async () => {
    expect(await refusal(verifyPassport(options(present(), { keyBinding: { aud: AUD, nonce: 'other' } })))).toEqual({
      code: 'key_unproven',
      reason: 'nonce_mismatch',
    });
  });

  it('refuses a KB-JWT outside the iat window', async () => {
    const stale = present(['agent'], holder.privateJwk, NOW - DEFAULT_KB_MAX_AGE_SECONDS - 1);
    expect(await refusal(verifyPassport(options(stale)))).toEqual({ code: 'key_unproven', reason: 'kb_stale' });
    const edge = present(['agent'], holder.privateJwk, NOW - DEFAULT_KB_MAX_AGE_SECONDS);
    expect((await verifyPassport(options(edge))).keyBinding?.iat).toBe(NOW - DEFAULT_KB_MAX_AGE_SECONDS);
    const future = present(['agent'], holder.privateJwk, NOW + 1);
    expect(await refusal(verifyPassport(options(future)))).toEqual({ code: 'key_unproven', reason: 'kb_stale' });
    const custom = present(['agent'], holder.privateJwk, NOW - 20);
    expect(await refusal(verifyPassport(options(custom, { keyBinding: { aud: AUD, nonce: NONCE, maxAgeSeconds: 10 } })))).toEqual({
      code: 'key_unproven',
      reason: 'kb_stale',
    });
  });

  it('refuses a presentation whose disclosures changed after the KB-JWT was made (sd_hash)', async () => {
    const presentation = present(['provider', 'agent']);
    const parts = presentation.split('~');
    // Drop the provider disclosure: the issuer signature still holds, the sd_hash does not.
    const trimmed = [parts[0], parts[2], parts[3]].join('~');
    expect(await refusal(verifyPassport(options(trimmed)))).toEqual({
      code: 'key_binding_mismatch',
      reason: 'sd_hash_mismatch',
    });
    const reordered = [parts[0], parts[2], parts[1], parts[3]].join('~');
    expect(await refusal(verifyPassport(options(reordered)))).toEqual({
      code: 'key_binding_mismatch',
      reason: 'sd_hash_mismatch',
    });
  });

  it('refuses a KB-JWT with the wrong typ, an unexpected alg or missing claims', async () => {
    const issued = issuePassport(passportParams(issuer, holder));
    const sdJwt = selectDisclosures(issued.compact, ['agent']);
    const sdHash = createHash('sha256').update(sdJwt, 'ascii').digest('base64url');
    const good = { iat: NOW, aud: AUD, nonce: NONCE, sd_hash: sdHash };
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ alg: 'ES256', typ: 'JWT' }, good],
      [{ alg: 'ES256' }, good],
      [{ alg: 'ES256', typ: 'kb+jwt', jwk: holder.publicJwk }, good],
      [{ alg: 'ES256', typ: 'kb+jwt' }, { ...good, sd_hash: undefined }],
      [{ alg: 'ES256', typ: 'kb+jwt' }, { ...good, nonce: 7 }],
      [{ alg: 'ES256', typ: 'kb+jwt' }, { ...good, iat: 'now' }],
      [{ alg: 'ES256', typ: 'kb+jwt' }, { ...good, aud: [AUD] }],
    ];
    for (const [header, payload] of cases) {
      const kb = signJws(header, JSON.parse(JSON.stringify(payload)) as Record<string, unknown>, holder.privateJwk);
      expect(await refusal(verifyPassport(options(`${sdJwt}${kb}`)))).toEqual({
        code: 'key_unproven',
        reason: 'kb_malformed',
      });
    }
  });

  it('refuses to create a KB-JWT over a string that is not an SD-JWT without key binding', () => {
    const issued = issuePassport(passportParams(issuer, holder));
    expect(() =>
      createKeyBindingJwt({ sdJwt: issued.issuerJwt, holderKey: holder.privateJwk, aud: AUD, nonce: NONCE }),
    ).toThrow(PassportError);
    expect(() =>
      createKeyBindingJwt({ sdJwt: issued.compact, holderKey: holder.publicJwk, aud: AUD, nonce: NONCE }),
    ).toThrow(PassportError);
  });

  it('selectDisclosures keeps only the named top-level claims', () => {
    const issued = issuePassport(passportParams(issuer, holder));
    const sdJwt = selectDisclosures(issued.compact, ['verification']);
    const parts = sdJwt.split('~');
    expect(parts).toHaveLength(3);
    expect(parts[1]).toBe(issued.disclosures.find((d) => d.name === 'verification')?.encoded);
    expect(selectDisclosures(issued.compact, [])).toBe(`${issued.issuerJwt}~`);
  });
});
