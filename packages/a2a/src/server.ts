/**
 * A2A server middleware for validating incoming Grantex grant tokens.
 *
 * Validates grant tokens on incoming A2A JSON-RPC requests and
 * attaches verified grant information to the request context.
 */

import { verifyGrantToken } from '@grantex/sdk';
import type { A2AAuthMiddlewareOptions, VerifiedGrant } from './types.js';

export interface A2ARequestContext {
  grant?: VerifiedGrant;
}

/**
 * Creates middleware that validates Grantex grant tokens from the
 * Authorization header of incoming A2A requests.
 *
 * Usage with Express/Fastify-style middleware:
 * ```ts
 * const authMiddleware = createA2AAuthMiddleware({ jwksUri: '...' });
 * app.use(authMiddleware);
 * ```
 *
 * This middleware verifies the token signature and issuer against JWKS before
 * trusting claims or enforcing scopes.
 */
export function createA2AAuthMiddleware(options: A2AAuthMiddlewareOptions) {
  const { requiredScopes } = options;

  return async function a2aAuthMiddleware(
    req: { headers: Record<string, string | string[] | undefined> },
  ): Promise<VerifiedGrant> {
    const authHeader = req.headers['authorization'];
    const headerValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;

    if (!headerValue || !headerValue.startsWith('Bearer ')) {
      throw new A2AAuthError(401, 'Missing or invalid Authorization header');
    }

    const token = headerValue.slice(7);
    let grant;
    try {
      grant = await verifyGrantToken(token, {
        jwksUri: options.jwksUri,
        ...(options.issuer !== undefined ? { issuer: options.issuer } : {}),
        ...(options.issuerDid !== undefined ? { issuerDid: options.issuerDid } : {}),
        ...(options.audience !== undefined ? { audience: options.audience } : {}),
        ...(options.clockTolerance !== undefined ? { clockTolerance: options.clockTolerance } : {}),
        ...(requiredScopes !== undefined ? { requiredScopes } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/missing required scopes/i.test(message)) {
        throw new A2AAuthError(403, message);
      }
      throw new A2AAuthError(401, `Grant token verification failed: ${message}`);
    }

    const verified: VerifiedGrant = {
      grantId: grant.grantId,
      agentDid: grant.agentDid,
      principalId: grant.principalId,
      developerId: grant.developerId,
      scopes: grant.scopes,
      expiresAt: new Date(grant.expiresAt * 1000).toISOString(),
      ...(grant.delegationDepth !== undefined
        ? { delegationDepth: grant.delegationDepth }
        : {}),
    };

    return verified;
  };
}

export class A2AAuthError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'A2AAuthError';
    this.statusCode = statusCode;
  }
}
