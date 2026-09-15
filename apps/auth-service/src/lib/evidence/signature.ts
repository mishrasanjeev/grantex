/** Detached JWS signatures over an evidence package root (ES256 or RS256). */
import { createPublicKey, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { VerificationCode as Code, VerificationFailure } from './result.js';

export const SIGNATURE_TYPE = 'grantex-evidence-root+jws';

export interface EvidenceSignature {
  alg: 'ES256' | 'RS256';
  jws: string;
  kid: string;
}

const b64url = (data: Uint8Array): string => Buffer.from(data).toString('base64url');

/** Strict base64url: unpadded and exactly the canonical encoding. */
function b64urlDecode(text: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const raw = Buffer.from(text, 'base64url');
  return b64url(raw) === text ? raw : null;
}

/** A `signature` member: a detached JWS over `root` (ES256 for P-256, RS256 for RSA ≥ 2048 bits). */
export function signRoot(root: string, privateKey: KeyObject, kid: string): EvidenceSignature {
  const details = privateKey.asymmetricKeyDetails ?? {};
  let alg: 'ES256' | 'RS256';
  if (privateKey.asymmetricKeyType === 'ec') {
    if (details.namedCurve !== 'prime256v1') throw new Error('ES256 requires a P-256 key');
    alg = 'ES256';
  } else if (privateKey.asymmetricKeyType === 'rsa') {
    if ((details.modulusLength ?? 0) < 2048) throw new Error('RS256 requires an RSA key of at least 2048 bits');
    alg = 'RS256';
  } else {
    throw new Error('unsupported private key type');
  }
  const headerB64 = b64url(Buffer.from(JSON.stringify({ alg, kid, typ: SIGNATURE_TYPE }), 'utf8'));
  const signingInput = Buffer.from(`${headerB64}.${b64url(Buffer.from(root, 'ascii'))}`, 'ascii');
  const signature = alg === 'ES256'
    ? cryptoSign('sha256', signingInput, { key: privateKey, dsaEncoding: 'ieee-p1363' })
    : cryptoSign('sha256', signingInput, privateKey);
  return { alg, jws: `${headerB64}..${b64url(signature)}`, kid };
}

const invalid = (message: string, path = 'signature.jws'): VerificationFailure =>
  new VerificationFailure(Code.SIGNATURE_INVALID, message, { fieldPath: path });

function publicKey(jwk: Record<string, unknown>, alg: string): KeyObject {
  if ((jwk['use'] ?? 'sig') !== 'sig' || (jwk['alg'] ?? alg) !== alg) {
    throw invalid('key is not usable for this algorithm', 'signature.kid');
  }
  if (alg === 'ES256') {
    const x = typeof jwk['x'] === 'string' ? b64urlDecode(jwk['x']) : null;
    const y = typeof jwk['y'] === 'string' ? b64urlDecode(jwk['y']) : null;
    if (jwk['kty'] !== 'EC' || jwk['crv'] !== 'P-256' || !x || !y || x.length === 0 || y.length === 0) {
      throw invalid('ES256 requires an EC P-256 key', 'signature.kid');
    }
    if (x.length !== 32 || y.length !== 32) throw invalid('malformed EC key', 'signature.kid');
    try {
      return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64url(x), y: b64url(y) }, format: 'jwk' });
    } catch {
      throw invalid('EC key point is not on P-256', 'signature.kid');
    }
  }
  const n = typeof jwk['n'] === 'string' ? b64urlDecode(jwk['n']) : null;
  const e = typeof jwk['e'] === 'string' ? b64urlDecode(jwk['e']) : null;
  if (jwk['kty'] !== 'RSA' || !n || !e || n.length === 0 || e.length === 0) {
    throw invalid('RS256 requires an RSA key', 'signature.kid');
  }
  let key: KeyObject;
  try {
    key = createPublicKey({ key: { kty: 'RSA', n: b64url(n), e: b64url(e) }, format: 'jwk' });
  } catch {
    throw invalid('RS256 requires an RSA key', 'signature.kid');
  }
  if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
    throw invalid('RSA key is shorter than 2048 bits', 'signature.kid');
  }
  return key;
}

/** Verify a `signature` member against `root` with keys from a JWKS. */
export function verifySignature(signature: Record<string, unknown>, root: string, jwks: unknown): void {
  const alg = signature['alg'] as string;
  const kid = signature['kid'] as string;
  const jws = signature['jws'] as string;
  const split = jws.indexOf('..');
  const headerB64 = jws.slice(0, split);
  const signatureB64 = jws.slice(split + 2);
  const headerRaw = b64urlDecode(headerB64);
  const signatureRaw = b64urlDecode(signatureB64);
  if (!headerRaw || !signatureRaw) throw invalid('JWS is not canonical base64url');
  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(headerRaw));
  } catch {
    throw invalid('JWS header is not JSON');
  }
  const h = header as Record<string, unknown>;
  if (
    header === null || typeof header !== 'object' || Array.isArray(header)
    || Object.keys(h).length !== 3 || h['alg'] !== alg || h['kid'] !== kid || h['typ'] !== SIGNATURE_TYPE
  ) {
    throw invalid('JWS header must be exactly alg, kid and typ matching the signature');
  }
  const keys = jwks !== null && typeof jwks === 'object' ? (jwks as Record<string, unknown>)['keys'] : undefined;
  if (!Array.isArray(keys)) {
    throw new VerificationFailure(Code.SIGNATURE_KEY_UNKNOWN, 'key set has no keys', { fieldPath: 'signature.kid' });
  }
  const matching = keys.filter((k) => k !== null && typeof k === 'object' && (k as Record<string, unknown>)['kid'] === kid);
  if (matching.length !== 1) {
    throw new VerificationFailure(Code.SIGNATURE_KEY_UNKNOWN, `key set has ${matching.length} keys with kid ${kid}`, {
      fieldPath: 'signature.kid',
    });
  }
  const key = publicKey(matching[0] as Record<string, unknown>, alg);
  const signingInput = Buffer.from(`${headerB64}.${b64url(Buffer.from(root, 'ascii'))}`, 'ascii');
  let ok: boolean;
  if (alg === 'ES256') {
    if (signatureRaw.length !== 64) throw invalid('ES256 signature must be 64 bytes');
    ok = cryptoVerify('sha256', signingInput, { key, dsaEncoding: 'ieee-p1363' }, signatureRaw);
  } else {
    ok = cryptoVerify('sha256', signingInput, key, signatureRaw);
  }
  if (!ok) throw invalid('signature does not verify');
}
