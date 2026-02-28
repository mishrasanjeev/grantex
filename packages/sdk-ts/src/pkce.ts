import { randomBytes, createHash } from 'node:crypto';

export interface PkceChallenge {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

/**
 * Generate a PKCE code verifier and S256 challenge pair.
 * Use `codeChallenge` + `codeChallengeMethod` in the authorize request,
 * and `codeVerifier` in the token exchange request.
 */
export function generatePkce(): PkceChallenge {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge, codeChallengeMethod: 'S256' };
}
