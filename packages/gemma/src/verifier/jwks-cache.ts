import * as jose from 'jose';

/**
 * A pre-fetched snapshot of the authorization server's JWKS keys.
 * Obtained online before the device goes offline.
 */
export interface JWKSSnapshot {
  /** JWK key objects (must include `kid` and `alg` fields). */
  keys: jose.JWK[];
  /** ISO-8601 timestamp when the snapshot was fetched. */
  fetchedAt: string;
  /** ISO-8601 timestamp after which the snapshot should be refreshed. */
  validUntil: string;
}

/**
 * Import a JWK from the snapshot matching the given `kid`.
 *
 * @returns The imported `KeyLike` ready for verification, or `null` if no
 *          matching key was found.
 */
export async function importKeyByKid(
  snapshot: JWKSSnapshot,
  kid: string,
): Promise<jose.CryptoKey | Uint8Array | null> {
  const jwk = snapshot.keys.find(
    (candidate) => candidate.kid === kid && candidate.alg === 'RS256',
  );
  if (!jwk) return null;
  return jose.importJWK(jwk, 'RS256');
}

/**
 * Returns `true` when the snapshot has passed its `validUntil` timestamp.
 */
export function isSnapshotExpired(snapshot: JWKSSnapshot): boolean {
  const validUntil = Date.parse(snapshot.validUntil);
  return !Number.isFinite(validUntil) || validUntil <= Date.now();
}
