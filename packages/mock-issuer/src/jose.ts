// SPDX-License-Identifier: Apache-2.0
//
// The compact JWS the mock signs and checks itself: its status list tokens,
// Bitstring Status List credentials, attestations and possession proofs.
// @grantex/agent-passport signs and verifies passports and computes the
// thumbprint and hash rules; it exports no general JWS signer, so the mock
// keeps this small one of its own rather than reach into that package's
// private modules. Compact serialisation (RFC 7515 section 7.1), strict
// base64url without padding (RFC 7515 section 2), and the two algorithms an
// Agent Passport can bind: ES256 (RFC 7518 section 3.4, P-256, R || S) and
// EdDSA (RFC 8037 section 3.1, Ed25519).

import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import type { Jwk } from '@grantex/agent-passport';

export type SigningAlg = 'ES256' | 'EdDSA';
export type KeyKind = 'P-256' | 'Ed25519';

export const ALG_FOR_KIND: Record<KeyKind, SigningAlg> = { 'P-256': 'ES256', Ed25519: 'EdDSA' };
const KIND_FOR_ALG: Record<SigningAlg, KeyKind> = { ES256: 'P-256', EdDSA: 'Ed25519' };

/** Header members that carry or point at a key (RFC 7515 sections 4.1.2 to 4.1.6). */
export const KEY_HEADER_MEMBERS = ['jku', 'jwk', 'x5u', 'x5c'] as const;

/** Members that make a JWK private (RFC 7518 sections 6.2.2, 6.3.2 and 6.4.1; RFC 8037 section 2). */
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const;

const ALPHABET = /^[A-Za-z0-9_-]*$/;

/** Decode strict base64url, or return null. Padding and non-canonical encodings are refused. */
function b64urlDecode(text: string): Buffer | null {
  if (!ALPHABET.test(text) || text.length % 4 === 1) return null;
  const bytes = Buffer.from(text, 'base64url');
  return bytes.toString('base64url') === text ? bytes : null;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function b64urlObject(text: string): Record<string, unknown> | null {
  const bytes = b64urlDecode(text);
  if (bytes === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(UTF8.decode(bytes));
  } catch {
    // Not UTF-8 or not JSON: parseJws returns null and the caller refuses the input.
    return null;
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function hasPrivateMembers(jwk: Record<string, unknown>): boolean {
  return PRIVATE_MEMBERS.some((member) => Object.hasOwn(jwk, member));
}

/** P-256 or Ed25519 with coordinates of the right length, else null. */
export function keyKind(jwk: unknown): KeyKind | null {
  if (typeof jwk !== 'object' || jwk === null) return null;
  const k = jwk as Record<string, unknown>;
  const x = typeof k.x === 'string' ? b64urlDecode(k.x) : null;
  if (k.kty === 'EC' && k.crv === 'P-256') {
    const y = typeof k.y === 'string' ? b64urlDecode(k.y) : null;
    return x?.length === 32 && y?.length === 32 ? 'P-256' : null;
  }
  if (k.kty === 'OKP' && k.crv === 'Ed25519') return x?.length === 32 ? 'Ed25519' : null;
  return null;
}

/** Import the public part of a P-256 or Ed25519 JWK, or return null (bad point, wrong type). */
export function importPublicKey(jwk: Record<string, unknown>): KeyObject | null {
  const kind = keyKind(jwk);
  if (kind === null) return null;
  const publicJwk = kind === 'P-256'
    ? { kty: 'EC', crv: 'P-256', x: jwk.x as string, y: jwk.y as string }
    : { kty: 'OKP', crv: 'Ed25519', x: jwk.x as string };
  try {
    return createPublicKey({ key: publicJwk, format: 'jwk' });
  } catch {
    // A point that is not on the curve: the caller refuses the key.
    return null;
  }
}

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
  const header = b64urlObject(h);
  const payload = b64urlObject(p);
  const signature = b64urlDecode(s);
  if (header === null || payload === null || signature === null) return null;
  return { header, payload, signingInput: `${h}.${p}`, signature };
}

/** Sign header and payload as given with a private P-256 or Ed25519 JWK. */
export function signJws(header: Record<string, unknown>, payload: Record<string, unknown>, privateJwk: Jwk): string {
  const kind = keyKind(privateJwk);
  if (kind === null || typeof privateJwk.d !== 'string') {
    throw new TypeError('the signing key must be a private P-256 or Ed25519 JWK');
  }
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const jwk: Record<string, string> = { kty: privateJwk.kty, crv: privateJwk.crv as string, x: privateJwk.x as string };
  if (kind === 'P-256') jwk.y = privateJwk.y as string;
  jwk.d = privateJwk.d;
  const key = createPrivateKey({ key: jwk, format: 'jwk' });
  const data = Buffer.from(signingInput, 'ascii');
  const signature = kind === 'P-256'
    ? sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' })
    : sign(null, data, key);
  return `${signingInput}.${signature.toString('base64url')}`;
}

/** Check a signature. False for a wrong signature, a wrong key type or a key that cannot be imported. */
export function verifySignature(alg: SigningAlg, jwk: Record<string, unknown>, jws: ParsedJws): boolean {
  if (hasPrivateMembers(jwk) || keyKind(jwk) !== KIND_FOR_ALG[alg]) return false;
  const key = importPublicKey(jwk);
  if (key === null) return false;
  // ES256 is R || S, 64 octets for P-256 (RFC 7518 section 3.4); an Ed25519 signature is 64 octets too.
  if (jws.signature.length !== 64) return false;
  const data = Buffer.from(jws.signingInput, 'ascii');
  return alg === 'ES256'
    ? verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, jws.signature)
    : verify(null, data, key, jws.signature);
}
