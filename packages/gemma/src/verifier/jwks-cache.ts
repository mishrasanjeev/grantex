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
): Promise<jose.KeyLike | Uint8Array | null> {
  const jwk = snapshot.keys.find((k) => k.kid === kid);
  if (!jwk) return null;
  return jose.importJWK(jwk, 'RS256');
}

/**
 * Returns `true` when the snapshot has passed its `validUntil` timestamp.
 */
export function isSnapshotExpired(snapshot: JWKSSnapshot): boolean {
  return new Date(snapshot.validUntil).getTime() < Date.now();
}
