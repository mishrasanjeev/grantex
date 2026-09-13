import { createHash, timingSafeEqual } from 'node:crypto';

const PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const PKCE_S256_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

export function verifyCodeChallenge(
  codeVerifier: unknown,
  codeChallenge: unknown,
): boolean {
  // Reject non-strings up front: a numeric body value used to reach
  // createHash().update() and surface as a 500 from the token endpoint.
  if (typeof codeVerifier !== 'string' || typeof codeChallenge !== 'string') return false;
  if (!PKCE_VERIFIER_RE.test(codeVerifier) || !PKCE_S256_CHALLENGE_RE.test(codeChallenge)) return false;
  const computed = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return timingSafeEqual(Buffer.from(computed), Buffer.from(codeChallenge));
}
