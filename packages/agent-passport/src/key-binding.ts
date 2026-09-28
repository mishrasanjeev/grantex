// SPDX-License-Identifier: Apache-2.0
//
// Key Binding JWT (RFC 9901 section 4.3): the holder proves possession of the
// cnf key for one relying party (aud) and one request (nonce), over exactly
// the disclosures it presents (sd_hash).

import { isSafeInt } from './base64url.ts';
import { PassportError, malformed } from './errors.ts';
import { ALG_FOR_KIND, KEY_HEADER_MEMBERS, parseJws, signJws, verifySignature, type SigningAlg } from './jws.ts';
import { hasPrivateMembers, keyKind, type Jwk } from './jwk.ts';
import { decodeDisclosure, sha256b64url, splitSdJwt } from './sd-jwt.ts';

/** RFC 9901 section 4.3: the typ of a KB-JWT. */
export const KB_JWT_TYP = 'kb+jwt';

/** How old a KB-JWT may be when no maxAgeSeconds is given. */
export const DEFAULT_KB_MAX_AGE_SECONDS = 300;

export interface CreateKeyBindingParams {
  /** The SD-JWT to present, ending with '~' and without a KB-JWT (see selectDisclosures). */
  sdJwt: string;
  /** The holder's private key: the key in the passport's cnf claim. */
  holderKey: Jwk;
  aud: string;
  nonce: string;
  /** Seconds since the epoch; defaults to now. */
  iat?: number;
}

export interface KeyBindingRequirement {
  /** The relying party's identifier, compared with aud. */
  aud: string;
  /** The nonce this relying party issued for the request. */
  nonce: string;
  /** Oldest acceptable iat, in seconds before now. Defaults to DEFAULT_KB_MAX_AGE_SECONDS. */
  maxAgeSeconds?: number;
}

export interface KeyBindingResult {
  aud: string;
  nonce: string;
  iat: number;
}

/** Append a KB-JWT to an SD-JWT: SD-JWT+KB (RFC 9901 section 4). */
export function createKeyBindingJwt(params: CreateKeyBindingParams): string {
  const { sdJwt, holderKey, aud, nonce } = params;
  const { issuerJwt, disclosures, kbJwt } = splitSdJwt(sdJwt);
  if (kbJwt !== '' || !sdJwt.endsWith('~') || parseJws(issuerJwt) === null) {
    throw malformed('not_sd_jwt', 'a KB-JWT is made over an SD-JWT that ends with ~ and has no KB-JWT yet');
  }
  for (const encoded of disclosures) decodeDisclosure(encoded);
  const kind = keyKind(holderKey);
  if (kind === null || typeof holderKey.d !== 'string') {
    throw malformed('bad_key', 'the holder key must be a private P-256 or Ed25519 JWK');
  }
  if (typeof aud !== 'string' || aud === '' || typeof nonce !== 'string' || nonce === '') {
    throw malformed('bad_claim', 'aud and nonce are non-empty strings');
  }
  const iat = params.iat ?? Math.floor(Date.now() / 1000);
  // RFC 9901 section 4.3.1: sd_hash over the US-ASCII bytes of the SD-JWT as presented,
  // the issuer-signed JWT and the selected disclosures, each followed by '~'.
  const payload = { iat, aud, nonce, sd_hash: sha256b64url(sdJwt) };
  return sdJwt + signJws({ alg: ALG_FOR_KIND[kind], typ: KB_JWT_TYP }, payload, holderKey);
}

/**
 * Verify the KB-JWT of a presentation against the cnf key (RFC 9901 section
 * 7.3). The caller has already verified the issuer-signed JWT and the cnf key.
 */
export function verifyKeyBinding(args: {
  compact: string;
  kbJwt: string;
  cnfJwk: Jwk;
  requirement: KeyBindingRequirement;
  now: number;
  clockSkewSeconds: number;
  allowEdDSA: boolean;
}): KeyBindingResult {
  const { compact, kbJwt, cnfJwk, requirement, now, clockSkewSeconds, allowEdDSA } = args;
  if (kbJwt === '') {
    throw new PassportError('key_unproven', 'key_binding_missing', 'this relying party requires a Key Binding JWT');
  }
  const unproven = (message: string) => new PassportError('key_unproven', 'kb_malformed', message);
  const jws = parseJws(kbJwt);
  if (jws === null) throw unproven('the KB-JWT is not a compact JWS');
  const { header, payload } = jws;
  if (header.typ !== KB_JWT_TYP) throw unproven('the KB-JWT typ must be kb+jwt');
  if (KEY_HEADER_MEMBERS.some((m) => Object.hasOwn(header, m)) || Object.hasOwn(header, 'crit')) {
    // The KB-JWT is checked against the cnf key only (RFC 9901 section 7.3 step 5.3).
    throw unproven('the KB-JWT header must not name a key or critical extensions');
  }
  const kind = keyKind(cnfJwk);
  const alg = header.alg;
  if (kind === null || alg !== ALG_FOR_KIND[kind]) throw unproven('the KB-JWT alg does not fit the cnf key');
  if (alg === 'EdDSA' && !allowEdDSA) {
    throw new PassportError('passport_not_accepted', 'eddsa_not_enabled', 'EdDSA is not enabled (allowEdDSA)');
  }
  if (
    !isSafeInt(payload.iat) ||
    typeof payload.aud !== 'string' ||
    typeof payload.nonce !== 'string' ||
    typeof payload.sd_hash !== 'string'
  ) {
    throw unproven('the KB-JWT needs iat, aud (a string), nonce and sd_hash');
  }
  if (hasPrivateMembers(cnfJwk) || !verifySignature(alg as SigningAlg, cnfJwk, jws)) {
    throw new PassportError('key_binding_mismatch', 'kb_signature_mismatch', 'the KB-JWT is not signed by the cnf key');
  }
  if (payload.aud !== requirement.aud) {
    throw new PassportError('audience_mismatch', 'audience_mismatch', 'the KB-JWT is for another audience');
  }
  if (payload.nonce !== requirement.nonce) {
    throw new PassportError('key_unproven', 'nonce_mismatch', 'the KB-JWT nonce is not the one issued');
  }
  const maxAge = requirement.maxAgeSeconds ?? DEFAULT_KB_MAX_AGE_SECONDS;
  if (payload.iat > now + clockSkewSeconds || payload.iat < now - maxAge - clockSkewSeconds) {
    throw new PassportError('key_unproven', 'kb_stale', 'the KB-JWT iat is outside the accepted window');
  }
  const presented = compact.slice(0, compact.length - kbJwt.length);
  if (payload.sd_hash !== sha256b64url(presented)) {
    throw new PassportError('key_binding_mismatch', 'sd_hash_mismatch', 'the KB-JWT was made over other disclosures');
  }
  return { aud: payload.aud, nonce: payload.nonce, iat: payload.iat };
}

