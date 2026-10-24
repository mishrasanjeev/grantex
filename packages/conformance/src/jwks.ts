import { createPublicKey, type webcrypto } from 'node:crypto';

/** Check public signing-key metadata without broadening grant-token algorithms. */
export function validateMixedSigningJwks(body: unknown): void {
  const keys = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('JWKS must contain signing keys');
  }
  let hasRsaGrantKey = false;
  const ids = new Set<string>();
  for (const value of keys) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('JWKS key must be an object');
    }
    const key = value as Record<string, unknown>;
    if (['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'].some((name) => name in key)) {
      throw new Error('JWKS must not expose private or symmetric key material');
    }
    if (key['use'] !== undefined && key['use'] !== 'sig') {
      throw new Error('JWKS key must be for signing');
    }
    if (key['key_ops'] !== undefined && (!Array.isArray(key['key_ops'])
      || key['key_ops'].length !== 1 || key['key_ops'][0] !== 'verify')) {
      throw new Error('Public signing key operations must be verify only');
    }
    if (key['kid'] !== undefined) {
      if (typeof key['kid'] !== 'string' || key['kid'].length === 0 || ids.has(key['kid'])) {
        throw new Error('JWKS key identifiers must be non-empty and unique');
      }
      ids.add(key['kid']);
    }
    const rsa = key['kty'] === 'RSA' && (key['alg'] === undefined || key['alg'] === 'RS256');
    const ec = key['kty'] === 'EC' && key['alg'] === 'ES256' && key['crv'] === 'P-256';
    const ed = key['kty'] === 'OKP' && key['alg'] === 'EdDSA' && key['crv'] === 'Ed25519';
    if (!rsa && !ec && !ed) {
      throw new Error('Unsupported signing algorithm or mismatched key type/curve');
    }
    const publicKey = createPublicKey({ key: key as webcrypto.JsonWebKey, format: 'jwk' });
    if (rsa) {
      if ((publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
        throw new Error('RS256 keys must be at least 2048 bits');
      }
      hasRsaGrantKey = true;
    }
  }
  if (!hasRsaGrantKey) throw new Error('Mixed JWKS must retain an RS256 grant key');
}
