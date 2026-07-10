import { createHash, timingSafeEqual } from 'node:crypto';

const PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const PKCE_S256_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

/** RFC 7636 code_verifier syntax (43-128 unreserved ASCII characters). */
export function isValidPkceVerifier(verifier: unknown): verifier is string {
  return typeof verifier === 'string' && PKCE_VERIFIER_RE.test(verifier);
}

/** A base64url-encoded SHA-256 digest is always exactly 43 characters. */
export function isValidPkceChallenge(challenge: unknown): challenge is string {
  return typeof challenge === 'string' && PKCE_S256_CHALLENGE_RE.test(challenge);
}

/**
 * Verify a PKCE code_verifier against a stored code_challenge (S256 only).
 * Returns true when SHA256(base64url(verifier)) === challenge.
 */
export function verifyPkceChallenge(verifier: string, challenge: string): boolean {
  if (!isValidPkceVerifier(verifier) || !isValidPkceChallenge(challenge)) {
    return false;
  }
  const hash = createHash('sha256').update(verifier).digest('base64url');
  return timingSafeEqual(Buffer.from(hash), Buffer.from(challenge));
}
