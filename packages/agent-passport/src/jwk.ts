// SPDX-License-Identifier: Apache-2.0
//
// JWK helpers: the key rule. Two keys are the same key when their RFC 7638
// thumbprints are equal. The thumbprint covers the required members only
// (RFC 7638 section 3.2; RFC 8037 section 2 for OKP keys), so kid, alg, use
// and private members never change it.

import { createHash, createPublicKey, type KeyObject } from 'node:crypto';
import { b64urlDecode, isObject } from './base64url.ts';
import { malformed } from './errors.ts';

export interface Jwk {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  d?: string;
  n?: string;
  e?: string;
  k?: string;
  kid?: string;
  alg?: string;
  [member: string]: unknown;
}

/** Required members per key type, already in lexicographic order (RFC 7638 section 3.2, RFC 8037 section 2). */
const REQUIRED_MEMBERS: Record<string, readonly string[]> = {
  EC: ['crv', 'kty', 'x', 'y'],
  OKP: ['crv', 'kty', 'x'],
  RSA: ['e', 'kty', 'n'],
  oct: ['k', 'kty'],
};

/** Members that make a JWK private (RFC 7518 sections 6.2.2, 6.3.2 and 6.4.1; RFC 8037 section 2). */
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const;

// Printable ASCII without '"' and '\': JSON serialises such a string the same
// way in every language, so both libraries hash identical bytes.
const PLAIN_MEMBER = /^[\x20\x21\x23-\x5b\x5d-\x7e]*$/;

/** RFC 7638 JWK SHA-256 thumbprint, base64url without padding. */
export function jwkThumbprint(jwk: Jwk): string {
  if (!isObject(jwk) || typeof jwk.kty !== 'string' || !Object.hasOwn(REQUIRED_MEMBERS, jwk.kty)) {
    throw malformed('bad_key', 'JWK has no supported kty');
  }
  const members = REQUIRED_MEMBERS[jwk.kty] as readonly string[];
  const parts: string[] = [];
  for (const member of members) {
    const value = jwk[member];
    if (typeof value !== 'string' || !PLAIN_MEMBER.test(value)) {
      throw malformed('bad_key', `JWK member ${member} is missing or not a plain string`);
    }
    parts.push(`${JSON.stringify(member)}:${JSON.stringify(value)}`);
  }
  // RFC 7638 section 3: required members only, lexicographic order, no whitespace, UTF-8.
  return createHash('sha256').update(`{${parts.join(',')}}`, 'utf8').digest('base64url');
}

/** The key rule: two JWKs are the same key when their thumbprints are equal. */
export function keysEqual(a: Jwk, b: Jwk): boolean {
  return jwkThumbprint(a) === jwkThumbprint(b);
}

export function hasPrivateMembers(jwk: Record<string, unknown>): boolean {
  return PRIVATE_MEMBERS.some((member) => Object.hasOwn(jwk, member));
}

export type KeyKind = 'P-256' | 'Ed25519';

/** P-256 or Ed25519 with coordinates of the right length, else null. */
export function keyKind(jwk: unknown): KeyKind | null {
  if (!isObject(jwk)) return null;
  const x = typeof jwk.x === 'string' ? b64urlDecode(jwk.x) : null;
  if (jwk.kty === 'EC' && jwk.crv === 'P-256') {
    const y = typeof jwk.y === 'string' ? b64urlDecode(jwk.y) : null;
    return x?.length === 32 && y?.length === 32 ? 'P-256' : null;
  }
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') {
    return x?.length === 32 ? 'Ed25519' : null;
  }
  return null;
}

/** Import the public part of a P-256 or Ed25519 JWK, or return null (bad point, wrong type). */
export function importPublicKey(jwk: Record<string, unknown>): KeyObject | null {
  const kind = keyKind(jwk);
  if (kind === null) return null;
  const publicJwk =
    kind === 'P-256'
      ? { kty: 'EC', crv: 'P-256', x: jwk.x as string, y: jwk.y as string }
      : { kty: 'OKP', crv: 'Ed25519', x: jwk.x as string };
  try {
    return createPublicKey({ key: publicJwk, format: 'jwk' });
  } catch {
    // A point that is not on the curve: the caller refuses the key.
    return null;
  }
}
