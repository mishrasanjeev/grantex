// SPDX-License-Identifier: Apache-2.0
/**
 * JWS-shaped test tokens. `verifyGrantToken` is mocked in these tests, so the
 * signature is a placeholder; the payload is what the audience check reads
 * once verification has passed.
 */
function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function tokenWith(claims: Record<string, unknown>): string {
  return `${segment({ alg: 'ES256', typ: 'at+jwt', kid: 'test-1' })}.${segment(claims)}.c2lnbmF0dXJl`;
}

/** A grant token without an `aud` claim. */
export const GRANT_TOKEN = tokenWith({ iss: 'https://issuer.example', sub: 'shopper-01', jti: 'tok_1' });
