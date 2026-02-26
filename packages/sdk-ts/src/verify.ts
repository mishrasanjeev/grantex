import { createRemoteJWKSet, jwtVerify, decodeJwt } from 'jose';
import { GrantexTokenError } from './errors.js';
import type { VerifiedGrant, VerifyGrantTokenOptions, GrantTokenPayload } from './types.js';

/**
 * Verify a Grantex grant token offline using the published JWKS.
 * Algorithm is fixed to RS256 per SPEC §11 and cannot be overridden.
 *
 * @throws {GrantexTokenError} if the token is invalid, expired, or missing required scopes.
 */
export async function verifyGrantToken(
  token: string,
  options: VerifyGrantTokenOptions,
): Promise<VerifiedGrant> {
  const jwks = createRemoteJWKSet(new URL(options.jwksUri));

  let payload: GrantTokenPayload;
  try {
    const jwtOptions = {
      algorithms: ['RS256'] as string[],
      ...(options.clockTolerance !== undefined
        ? { clockTolerance: options.clockTolerance }
        : {}),
      ...(options.audience !== undefined
        ? { audience: options.audience }
        : {}),
    };
    const result = await jwtVerify(token, jwks, jwtOptions);
    payload = result.payload as unknown as GrantTokenPayload;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);
    throw new GrantexTokenError(`Grant token verification failed: ${message}`);
  }

  const requiredScopes = options.requiredScopes ?? [];
  if (requiredScopes.length > 0) {
    const missing = requiredScopes.filter((s) => !payload.scp.includes(s));
    if (missing.length > 0) {
      throw new GrantexTokenError(
        `Grant token is missing required scopes: ${missing.join(', ')}`,
      );
    }
  }

  return payloadToVerifiedGrant(payload);
}

/**
 * Decode a grant token (without re-verifying the signature) and map it to
 * a VerifiedGrant shape. Used by GrantsClient.verify() to fill fields the
 * API summary response may omit.
 *
 * @internal
 */
export function mapOnlineVerifyToVerifiedGrant(token: string): VerifiedGrant {
  let payload: GrantTokenPayload;
  try {
    payload = decodeJwt(token) as unknown as GrantTokenPayload;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new GrantexTokenError(`Failed to decode grant token: ${message}`);
  }
  return payloadToVerifiedGrant(payload);
}

function payloadToVerifiedGrant(payload: GrantTokenPayload): VerifiedGrant {
  if (
    typeof payload.jti !== 'string' ||
    typeof payload.sub !== 'string' ||
    typeof payload.agt !== 'string' ||
    typeof payload.dev !== 'string' ||
    !Array.isArray(payload.scp) ||
    typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number'
  ) {
    throw new GrantexTokenError(
      'Grant token is missing required claims (jti, sub, agt, dev, scp, iat, exp)',
    );
  }

  return {
    tokenId: payload.jti,
    grantId: payload.grnt ?? payload.jti,
    principalId: payload.sub,
    agentDid: payload.agt,
    developerId: payload.dev,
    scopes: payload.scp,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
    ...(payload.parentAgt !== undefined ? { parentAgentDid: payload.parentAgt } : {}),
    ...(payload.parentGrnt !== undefined ? { parentGrantId: payload.parentGrnt } : {}),
    ...(payload.delegationDepth !== undefined ? { delegationDepth: payload.delegationDepth } : {}),
  };
}
