/**
 * The small amount of JOSE the OACP verifier needs, on `node:crypto` alone:
 * strict base64url (RFC 7515 §2, no padding, canonical), duplicate-free JSON
 * headers, key selection from a JWK Set (RFC 7517) and signature checks for
 * ES256 (RFC 7518 §3.4, IEEE P1363 r||s) and RS256 (RFC 7518 §3.3).
 */
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { parseJsonRejectingDuplicates } from '../canonical.js';

/** A JWK Set as published at `/.well-known/jwks.json`. */
export interface OacpJwks {
  keys: Array<Record<string, unknown>>;
}

const B64URL_CHARS = /^[A-Za-z0-9_-]*$/;

/** True when `value` uses only base64url characters and has a length base64url can produce. */
export function isBase64urlShaped(value: string): boolean {
  return B64URL_CHARS.test(value) && value.length % 4 !== 1;
}

/**
 * Decodes unpadded base64url, or returns null when the text is not the one
 * canonical encoding of its bytes (stray padding bits, padding, other
 * characters).
 */
export function decodeBase64urlStrict(value: string): Buffer | null {
  if (typeof value !== 'string' || !isBase64urlShaped(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.toString('base64url') === value ? bytes : null;
}

export function encodeBase64url(value: string | Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A JOSE header or claims set: a base64url JSON object without repeated member names. */
export function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  const bytes = decodeBase64urlStrict(segment);
  if (bytes === null) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  try {
    const value = parseJsonRejectingDuplicates(text);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

export type KeyLookup =
  | { ok: true; key: KeyObject }
  | { ok: false; reason: string };

const KEY_TYPE: Record<string, string> = { ES256: 'EC', RS256: 'RSA' };

/**
 * The one key in `jwks` with `kid`, usable for `alg`: `use` absent or `sig`,
 * `alg` absent or equal, `kty` matching the algorithm, P-256 with 32-byte
 * coordinates for ES256, a modulus of at least 2048 bits for RS256, and no
 * private members.
 */
export function selectVerificationKey(jwks: unknown, kid: string, alg: 'ES256' | 'RS256'): KeyLookup {
  if (!isPlainObject(jwks) || !Array.isArray(jwks['keys'])) return { ok: false, reason: 'the JWK Set has no keys array' };
  const matches = (jwks['keys'] as unknown[]).filter((key) => isPlainObject(key) && key['kid'] === kid);
  if (matches.length === 0) return { ok: false, reason: `no key with kid ${JSON.stringify(kid)}` };
  if (matches.length > 1) return { ok: false, reason: `several keys with kid ${JSON.stringify(kid)}` };
  const jwk = matches[0] as Record<string, unknown>;
  if (jwk['use'] !== undefined && jwk['use'] !== 'sig') return { ok: false, reason: 'the key is not a signing key' };
  if (jwk['alg'] !== undefined && jwk['alg'] !== alg) return { ok: false, reason: `the key is not for ${alg}` };
  if (jwk['kty'] !== KEY_TYPE[alg]) return { ok: false, reason: `the key type is not ${KEY_TYPE[alg]}` };
  if ('d' in jwk || 'p' in jwk) return { ok: false, reason: 'the JWK Set publishes private key material' };
  try {
    if (alg === 'ES256') {
      if (jwk['crv'] !== 'P-256') return { ok: false, reason: 'the key is not on P-256' };
      const x = decodeBase64urlStrict(jwk['x'] as string);
      const y = decodeBase64urlStrict(jwk['y'] as string);
      if (x?.length !== 32 || y?.length !== 32) return { ok: false, reason: 'the key coordinates are not 32 bytes' };
      return { ok: true, key: createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk['x'] as string, y: jwk['y'] as string }, format: 'jwk' }) };
    }
    const n = decodeBase64urlStrict(jwk['n'] as string);
    const e = decodeBase64urlStrict(jwk['e'] as string);
    if (n === null || e === null || n.length < 256) return { ok: false, reason: 'the RSA key is malformed or shorter than 2048 bits' };
    return { ok: true, key: createPublicKey({ key: { kty: 'RSA', n: jwk['n'] as string, e: jwk['e'] as string }, format: 'jwk' }) };
  } catch {
    return { ok: false, reason: 'the key cannot be imported' };
  }
}

/** Checks a JWS signature over the ASCII signing input. */
export function verifyJwsSignature(alg: 'ES256' | 'RS256', key: KeyObject, signingInput: string, signature: Buffer): boolean {
  try {
    if (alg === 'ES256') {
      if (signature.length !== 64) return false;
      return cryptoVerify('sha256', Buffer.from(signingInput, 'ascii'), { key, dsaEncoding: 'ieee-p1363' }, signature);
    }
    return cryptoVerify('sha256', Buffer.from(signingInput, 'ascii'), key, signature);
  } catch {
    return false;
  }
}
