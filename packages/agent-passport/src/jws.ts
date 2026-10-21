// SPDX-License-Identifier: Apache-2.0
//
// Compact JWS (RFC 7515 section 7.1) with the two algorithms the profile
// allows: ES256 (RFC 7518 section 3.4, P-256, R || S signature) and EdDSA
// (RFC 8037 section 3.1, Ed25519).

import { createPrivateKey, sign, verify } from 'node:crypto';
import { b64urlDecode, b64urlEncode, b64urlJson, isObject } from './base64url.ts';
import { PassportError, malformed } from './errors.ts';
import { hasPrivateMembers, importPublicKey, keyKind, type Jwk, type KeyKind } from './jwk.ts';

export type SigningAlg = 'ES256' | 'EdDSA';

export const ALG_FOR_KIND: Record<KeyKind, SigningAlg> = { 'P-256': 'ES256', Ed25519: 'EdDSA' };
export const KIND_FOR_ALG: Record<SigningAlg, KeyKind> = { ES256: 'P-256', EdDSA: 'Ed25519' };

/**
 * Header members that carry or point at a key (RFC 7515 sections 4.1.2 to
 * 4.1.6). Issuer keys come only from the relying party's resolver, never from
 * the token, so a token that names one is refused.
 */
export const KEY_HEADER_MEMBERS = ['jku', 'jwk', 'x5u', 'x5c'] as const;

export interface ParsedJws {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
}

/** Split and decode a compact JWS without checking its signature, or return null. */
export function parseJws(jws: string): ParsedJws | null {
  const segments = jws.split('.');
  if (segments.length !== 3) return null;
  const [h, p, s] = segments as [string, string, string];
  const header = b64urlJson(h);
  const payload = b64urlJson(p);
  const signature = b64urlDecode(s);
  if (!header || !payload || signature === null) return null;
  if (!isObject(header.value) || !isObject(payload.value)) return null;
  return { header: header.value, payload: payload.value, signingInput: `${h}.${p}`, signature };
}

/** Decode a compact JWS without checking it. For tests and diagnostics only. */
export function decodeJwsUnverified(jws: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const parsed = parseJws(jws);
  if (parsed === null) throw malformed('bad_encoding', 'not a compact JWS');
  return { header: parsed.header, payload: parsed.payload };
}

/** Sign header and payload as given with a private P-256 or Ed25519 JWK. */
export function signJws(header: Record<string, unknown>, payload: Record<string, unknown>, privateJwk: Jwk): string {
  const kind = keyKind(privateJwk);
  if (kind === null || typeof privateJwk.d !== 'string') {
    throw malformed('bad_key', 'signing key must be a private P-256 or Ed25519 JWK');
  }
  const signingInput = `${b64urlEncode(JSON.stringify(header))}.${b64urlEncode(JSON.stringify(payload))}`;
  let key;
  try {
    const jwk: Record<string, string> = { kty: privateJwk.kty, crv: privateJwk.crv as string, x: privateJwk.x as string };
    if (kind === 'P-256') jwk.y = privateJwk.y as string;
    jwk.d = privateJwk.d;
    key = createPrivateKey({ key: jwk, format: 'jwk' });
  } catch (cause) {
    throw new PassportError('passport_malformed', 'bad_key', 'signing key cannot be imported', { cause });
  }
  const signature =
    kind === 'P-256'
      ? sign('sha256', Buffer.from(signingInput, 'ascii'), { key, dsaEncoding: 'ieee-p1363' })
      : sign(null, Buffer.from(signingInput, 'ascii'), key);
  return `${signingInput}.${b64urlEncode(signature)}`;
}

/** Check a signature. False for a wrong signature, a wrong key type or a key that cannot be imported. */
export function verifySignature(alg: SigningAlg, jwk: Record<string, unknown>, jws: ParsedJws): boolean {
  if (hasPrivateMembers(jwk) || keyKind(jwk) !== KIND_FOR_ALG[alg]) return false;
  const key = importPublicKey(jwk);
  if (key === null) return false;
  const data = Buffer.from(jws.signingInput, 'ascii');
  if (alg === 'ES256') {
    // RFC 7518 section 3.4: the signature is R || S, 64 octets for P-256.
    if (jws.signature.length !== 64) return false;
    return verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, jws.signature);
  }
  if (jws.signature.length !== 64) return false;
  return verify(null, data, key, jws.signature);
}
