/**
 * JOSE algorithms the platform signing key may use. Kept free of imports so
 * `config.ts` can validate settings without pulling in key management.
 *
 * Only asymmetric algorithms with a fixed key type are listed: `none` and the
 * HMAC family are never valid, and each algorithm maps to exactly one key type
 * so a verifier can refuse a key/algorithm mismatch.
 */
export const SIGNING_ALGORITHMS = ['RS256', 'ES256'] as const;
export type SigningAlgorithm = (typeof SIGNING_ALGORITHMS)[number];

export const SIGNING_KEY_STORES = ['env', 'postgres'] as const;
export type SigningKeyStore = (typeof SIGNING_KEY_STORES)[number];

export function isSigningAlgorithm(value: unknown): value is SigningAlgorithm {
  return typeof value === 'string' && (SIGNING_ALGORITHMS as readonly string[]).includes(value);
}

export function parseSigningAlgorithm(name: string, value: string): SigningAlgorithm {
  if (!isSigningAlgorithm(value)) {
    throw new Error(`${name} must be one of: ${SIGNING_ALGORITHMS.join(', ')}`);
  }
  return value;
}

export function parseSigningKeyStore(name: string, value: string): SigningKeyStore {
  if (!(SIGNING_KEY_STORES as readonly string[]).includes(value)) {
    throw new Error(`${name} must be one of: ${SIGNING_KEY_STORES.join(', ')}`);
  }
  return value as SigningKeyStore;
}

/** The JWK key type (and curve) an algorithm requires. */
export function keyTypeForAlgorithm(alg: SigningAlgorithm): { kty: 'RSA' } | { kty: 'EC'; crv: 'P-256' } {
  return alg === 'RS256' ? { kty: 'RSA' } : { kty: 'EC', crv: 'P-256' };
}
