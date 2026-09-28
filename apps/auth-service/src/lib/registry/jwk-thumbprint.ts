// SPDX-License-Identifier: Apache-2.0
/**
 * JSON Web Key (JWK) Thumbprints, RFC 7638, with SHA-256.
 *
 * The registry identifies every agent key by its thumbprint, and a grant's
 * `cnf.jkt` (RFC 9449 §6.1) is the same value, so two computations of it must
 * never disagree. The rules implemented here, from the RFC text:
 *
 *  - §3: the hash input is a JSON object holding only the required members of
 *    the key, ordered lexicographically by member name, with no whitespace.
 *  - §3.2: the required members are `crv`, `kty`, `x`, `y` for EC and `e`,
 *    `kty`, `n` for RSA; RFC 8037 §2 adds `crv`, `kty`, `x` for OKP. Every
 *    other member (`kid`, `alg`, `use`, `key_ops`, ...) is ignored, so its
 *    presence or absence cannot change the thumbprint.
 *  - §3.3: member names and values are represented without escaping; a value
 *    that would need escaping has no defined thumbprint.
 *
 * Stricter than the RFC in two places, both because the registry only ever
 * holds public signature keys: a JWK carrying private members is refused
 * rather than reduced to its public part (§3.2.1 allows that reduction, but
 * a caller who sends a private key has made a mistake worth reporting), and
 * symmetric (`oct`) keys are refused. Key material members must be base64url
 * without padding, as RFC 7518 §6.2.1 and §6.3.1 and RFC 8037 §2 require.
 */
import { createHash } from 'node:crypto';

/** RFC 7638 §3.2 and RFC 8037 §2: the required members, already in lexicographic order. */
export const THUMBPRINT_MEMBERS = {
  EC: ['crv', 'kty', 'x', 'y'],
  RSA: ['e', 'kty', 'n'],
  OKP: ['crv', 'kty', 'x'],
} as const;

type ThumbprintKty = keyof typeof THUMBPRINT_MEMBERS;

/** Members that only a private (or symmetric) key carries: RFC 7518 §6.2.2, §6.3.2, §6.4; RFC 8037 §2. */
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const;
/** Members holding base64url-encoded key material. */
const KEY_MATERIAL = new Set(['x', 'y', 'n', 'e']);
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** RFC 7638 §3.3 with RFC 8259 §7: quotation mark, reverse solidus and U+0000 through U+001F need escaping. */
const NEEDS_ESCAPING = /["\\\u0000-\u001f]/;
/** A lone surrogate has no UTF-8 encoding, so the hash input would be undefined. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

export class JwkThumbprintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwkThumbprintError';
  }
}

/** The RFC 7638 §3 hash input: the required members only, ordered, without whitespace. */
export function jwkThumbprintInput(jwk: unknown): string {
  if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) {
    throw new JwkThumbprintError('a JWK must be a JSON object');
  }
  const members = jwk as Record<string, unknown>;
  for (const name of PRIVATE_MEMBERS) {
    if (name in members) {
      throw new JwkThumbprintError(`the JWK carries the private member ${name}; only public keys have a registry thumbprint`);
    }
  }
  const kty = members['kty'];
  if (typeof kty !== 'string' || !Object.hasOwn(THUMBPRINT_MEMBERS, kty)) {
    throw new JwkThumbprintError('the JWK kty must be EC, RSA or OKP');
  }
  const parts = THUMBPRINT_MEMBERS[kty as ThumbprintKty].map((name) => {
    const value = members[name];
    if (typeof value !== 'string' || value.length === 0) {
      throw new JwkThumbprintError(`the JWK is missing its required member ${name}`);
    }
    if (NEEDS_ESCAPING.test(value) || LONE_SURROGATE.test(value)) {
      throw new JwkThumbprintError(`the JWK member ${name} has no defined thumbprint representation (RFC 7638 §3.3)`);
    }
    if (KEY_MATERIAL.has(name) && !BASE64URL.test(value)) {
      throw new JwkThumbprintError(`the JWK member ${name} must be base64url without padding`);
    }
    // Neither the name nor the value needs escaping, so this is the literal
    // representation §3.3 asks for.
    return `"${name}":"${value}"`;
  });
  return `{${parts.join(',')}}`;
}

/** The base64url-encoded SHA-256 JWK Thumbprint of a public JWK (RFC 7638 §3, §3.4). */
export function jwkThumbprint(jwk: unknown): string {
  return createHash('sha256').update(jwkThumbprintInput(jwk), 'utf8').digest('base64url');
}
