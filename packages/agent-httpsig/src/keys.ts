// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * Agent keys as JWKs: P-256 (RFC 7518 section 6.2) and Ed25519 (RFC 8037
 * section 2), their RFC 7638 thumbprints, and the two RFC 9421 algorithms
 * the profile allows (sections 3.3.4 and 3.3.6).
 */
import { constants, createHash, createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import type { KeyObject, webcrypto } from 'node:crypto';
import { AgentHttpSigError } from './errors.js';

export type SignatureAlgorithm = 'ecdsa-p256-sha256' | 'ed25519' | 'rsa-pss-sha512';

/** The smallest RSA modulus accepted, in bits. */
export const MIN_RSA_MODULUS_BITS = 2048;
const MAX_RSA_MODULUS_BITS = 8192;
/** RFC 9421 section 3.3.1: RSASSA-PSS, SHA-512, MGF1 with SHA-512, a 64-octet salt. */
const PSS = { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 64 } as const;

/** A P-256, Ed25519 or RSA key in JWK form, public or private (with `d`). */
export interface AgentJwk {
  kty?: string | undefined;
  crv?: string | undefined;
  x?: string | undefined;
  y?: string | undefined;
  d?: string | undefined;
  /** RSA (RFC 7518 section 6.3). */
  n?: string | undefined;
  e?: string | undefined;
  p?: string | undefined;
  q?: string | undefined;
  dp?: string | undefined;
  dq?: string | undefined;
  qi?: string | undefined;
  alg?: string | undefined;
}

function fail(message: string): never {
  throw new AgentHttpSigError(message);
}

/** base64url without padding (RFC 7515 section 2), decoded strictly. */
function decodeB64url(value: unknown, member: string, octets: number): Uint8Array {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) fail(`JWK member ${member} is not base64url`);
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== octets || bytes.toString('base64url') !== value) {
    fail(`JWK member ${member} is not ${octets} octets of canonical base64url`);
  }
  return new Uint8Array(bytes);
}

/** A positive integer in canonical base64url: no leading zero octet, at most `maxOctets`. */
function decodeB64urlInt(value: unknown, member: string, maxOctets: number): Uint8Array {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9_-]*$/.test(value)) fail(`JWK member ${member} is not base64url`);
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length === 0 || bytes.length > maxOctets || bytes[0] === 0 || bytes.toString('base64url') !== value) {
    fail(`JWK member ${member} is not a canonical base64url integer`);
  }
  return new Uint8Array(bytes);
}

/** RFC 9421 section 3.3.1 keys: a modulus of 2048 to 8192 bits and an odd exponent of at least 3. */
function checkRsaPublic(jwk: AgentJwk): void {
  const n = decodeB64urlInt(jwk.n, 'n', MAX_RSA_MODULUS_BITS / 8);
  const e = decodeB64urlInt(jwk.e, 'e', 8);
  const bits = (n.length - 1) * 8 + (32 - Math.clz32(n[0]!));
  if (bits < MIN_RSA_MODULUS_BITS) fail(`an RSA key must have at least a ${MIN_RSA_MODULUS_BITS}-bit modulus`);
  const exponent = e.reduce((acc, byte) => acc * 256n + BigInt(byte), 0n);
  if (exponent < 3n || exponent % 2n === 0n) fail('an RSA public exponent must be odd and at least 3');
}

/** The algorithm for a key, from its kty and crv (RFC 9421 section 3.2 step 6.3). */
export function algorithmFor(jwk: AgentJwk): SignatureAlgorithm {
  let alg: SignatureAlgorithm;
  let allowed: string[];
  if (jwk.kty === 'EC' && jwk.crv === 'P-256') {
    decodeB64url(jwk.x, 'x', 32);
    decodeB64url(jwk.y, 'y', 32);
    alg = 'ecdsa-p256-sha256';
    allowed = ['ES256'];
  } else if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') {
    decodeB64url(jwk.x, 'x', 32);
    if (jwk.y !== undefined) fail('an Ed25519 JWK has no y');
    alg = 'ed25519';
    allowed = ['EdDSA', 'Ed25519'];
  } else if (jwk.kty === 'RSA') {
    checkRsaPublic(jwk);
    alg = 'rsa-pss-sha512';
    allowed = ['PS512'];
  } else {
    return fail('only P-256 (kty EC), Ed25519 (kty OKP) and RSA (kty RSA) keys are supported');
  }
  // Section 3.2 step 6.5: an algorithm named in the key must agree.
  if (jwk.alg !== undefined && !allowed.includes(jwk.alg)) fail(`JWK alg ${jwk.alg} does not match its key type`);
  return alg;
}

/** The public members of a P-256, Ed25519 or RSA JWK. */
export function publicJwk(jwk: AgentJwk): AgentJwk {
  algorithmFor(jwk);
  if (jwk.kty === 'RSA') return { kty: 'RSA', n: jwk.n!, e: jwk.e! };
  return jwk.kty === 'EC'
    ? { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! }
    : { kty: 'OKP', crv: 'Ed25519', x: jwk.x! };
}

/**
 * RFC 7638 section 3: SHA-256 over the required members in lexicographic
 * order with no whitespace (crv, kty, x, y for EC, section 3.2; crv, kty, x
 * for OKP, RFC 8037 Appendix A.3), base64url without padding.
 */
export function jwkThumbprint(jwk: AgentJwk): string {
  algorithmFor(jwk);
  // RFC 7638 section 3.2: e, kty, n for RSA.
  if (jwk.kty === 'RSA') {
    return createHash('sha256').update(`{"e":"${jwk.e}","kty":"RSA","n":"${jwk.n}"}`, 'utf8').digest('base64url');
  }
  const canonical =
    jwk.kty === 'EC'
      ? `{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`
      : `{"crv":"Ed25519","kty":"OKP","x":"${jwk.x}"}`;
  return createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

/** A private key whose public half is the JWK's own x (and y). */
export function privateKeyObject(jwk: AgentJwk): { key: KeyObject; alg: SignatureAlgorithm } {
  const alg = algorithmFor(jwk);
  if (alg === 'rsa-pss-sha512') {
    for (const member of ['d', 'p', 'q', 'dp', 'dq', 'qi'] as const) decodeB64urlInt(jwk[member], member, MAX_RSA_MODULUS_BITS / 8);
    let rsaKey: KeyObject;
    let derivedRsa: webcrypto.JsonWebKey;
    try {
      rsaKey = createPrivateKey({
        key: { kty: 'RSA', n: jwk.n!, e: jwk.e!, d: jwk.d!, p: jwk.p!, q: jwk.q!, dp: jwk.dp!, dq: jwk.dq!, qi: jwk.qi! } as webcrypto.JsonWebKey,
        format: 'jwk',
      });
      derivedRsa = createPublicKey(rsaKey).export({ format: 'jwk' });
    } catch {
      // Signing with a key that cannot be loaded is refused, never attempted.
      return fail('the private JWK cannot be loaded');
    }
    if (derivedRsa.n !== jwk.n || derivedRsa.e !== jwk.e) fail('the private JWK does not match its public members');
    return { key: rsaKey, alg };
  }
  decodeB64url(jwk.d, 'd', 32);
  let key: KeyObject;
  let derived: webcrypto.JsonWebKey;
  try {
    key = createPrivateKey({ key: { ...publicJwk(jwk), d: jwk.d! } as webcrypto.JsonWebKey, format: 'jwk' });
    derived = createPublicKey(key).export({ format: 'jwk' });
  } catch {
    // Signing with a key that cannot be loaded is refused, never attempted.
    return fail('the private JWK cannot be loaded');
  }
  if (derived.x !== jwk.x || (alg === 'ecdsa-p256-sha256' && derived.y !== jwk.y)) {
    fail('the private JWK does not match its public members');
  }
  return { key, alg };
}

/** A public key, or null when the JWK is not a usable public P-256, Ed25519 or RSA key. */
export function publicKeyObject(jwk: unknown): { key: KeyObject; alg: SignatureAlgorithm } | null {
  if (typeof jwk !== 'object' || jwk === null || Array.isArray(jwk)) return null;
  const candidate = jwk as AgentJwk;
  // A resolver that hands back private material is misconfigured; refuse it.
  if (candidate.d !== undefined) return null;
  try {
    const alg = algorithmFor(candidate);
    return { key: createPublicKey({ key: publicJwk(candidate) as webcrypto.JsonWebKey, format: 'jwk' }), alg };
  } catch {
    // A key that cannot be loaded (for example a point off the curve) is
    // unusable; the caller denies the request.
    return null;
  }
}

/** HTTP_SIGN (RFC 9421 sections 3.3.1, 3.3.4, 3.3.6). ECDSA output is r || s, 64 octets, not DER. */
export function signBytes(key: KeyObject, alg: SignatureAlgorithm, base: string | Uint8Array): Uint8Array {
  const data = typeof base === 'string' ? Buffer.from(base, 'ascii') : Buffer.from(base);
  if (alg === 'rsa-pss-sha512') return new Uint8Array(nodeSign('sha512', data, { key, ...PSS }));
  return new Uint8Array(
    alg === 'ed25519' ? nodeSign(null, data, key) : nodeSign('sha256', data, { key, dsaEncoding: 'ieee-p1363' }),
  );
}

/** HTTP_VERIFY (RFC 9421 sections 3.3.1, 3.3.4, 3.3.6). ECDSA and Ed25519 signatures are 64 octets; RSA-PSS ones the modulus length. */
export function verifyBytes(
  key: KeyObject,
  alg: SignatureAlgorithm,
  base: string | Uint8Array,
  signature: Uint8Array,
): boolean {
  const data = typeof base === 'string' ? Buffer.from(base, 'ascii') : Buffer.from(base);
  if (alg === 'rsa-pss-sha512') {
    const modulusBits = key.asymmetricKeyDetails?.modulusLength ?? 0;
    if (signature.length !== Math.ceil(modulusBits / 8)) return false;
    try {
      return nodeVerify('sha512', data, { key, ...PSS }, signature);
    } catch {
      // A signature the primitive cannot process is not a valid one.
      return false;
    }
  }
  if (signature.length !== 64) return false;
  try {
    return alg === 'ed25519'
      ? nodeVerify(null, data, key, signature)
      : nodeVerify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    // A signature the primitive cannot even process is not a valid one:
    // report it as failing, which denies the request.
    return false;
  }
}

/**
 * Verifies an RFC 9421 signature value over a signature base with a public
 * JWK (P-256, Ed25519 or RSA). False for any key it cannot use.
 */
export function verifySignatureValue(jwk: AgentJwk, base: string, signature: Uint8Array): boolean {
  const pub = publicKeyObject(jwk);
  return pub !== null && verifyBytes(pub.key, pub.alg, base, signature);
}
