import { createHash } from 'node:crypto';

/**
 * Verify a PKCE code_verifier against a stored code_challenge (S256 only).
 * Returns true when SHA256(base64url(verifier)) === challenge.
 */
export function verifyPkceChallenge(verifier: string, challenge: string): boolean {
  const hash = createHash('sha256').update(verifier).digest('base64url');
  return hash === challenge;
}
