/**
 * A2A server middleware for validating incoming Grantex grant tokens.
 *
 * Validates grant tokens on incoming A2A JSON-RPC requests and
 * attaches verified grant information to the request context.
 */

import { decodeJwtPayload, isTokenExpired } from './_jwt.js';
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
 * For full JWKS verification, use @grantex/sdk's tokens.verify().
 * This middleware performs offline JWT decode + expiration check
 * and optionally validates scopes.
 */
export function createA2AAuthMiddleware(options: A2AAuthMiddlewareOptions) {
  const { requiredScopes } = options;

  return function a2aAuthMiddleware(
    req: { headers: Record<string, string | string[] | undefined> },
  ): VerifiedGrant {
    const authHeader = req.headers['authorization'];
    const headerValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;

    if (!headerValue || !headerValue.startsWith('Bearer ')) {
      throw new A2AAuthError(401, 'Missing or invalid Authorization header');
    }

    const token = headerValue.slice(7);
    let payload;
    try {
      payload = decodeJwtPayload(token);
    } catch {
      throw new A2AAuthError(401, 'Invalid grant token format');
    }

    if (isTokenExpired(payload)) {
      throw new A2AAuthError(401, 'Grant token expired');
    }

    // Validate required scopes
    if (requiredScopes && requiredScopes.length > 0) {
      const tokenScopes = new Set(payload.scp ?? []);
      const missing = requiredScopes.filter((s) => !tokenScopes.has(s));
      if (missing.length > 0) {
        throw new A2AAuthError(403, `Missing required scopes: ${missing.join(', ')}`);
      }
    }

    const grant: VerifiedGrant = {
      grantId: payload.grnt ?? payload.jti ?? '',
      agentDid: payload.agt ?? '',
      principalId: payload.sub ?? '',
      developerId: payload.dev ?? '',
      scopes: payload.scp ?? [],
      expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : '',
      ...(payload.delegationDepth !== undefined
        ? { delegationDepth: payload.delegationDepth }
        : {}),
    };

    return grant;
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
