import * as jose from 'jose';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Decoded Grantex MCP grant claims attached to the request.
 */
export interface McpGrant {
  /** Subject (principal ID) */
  sub: string;
  /** Issuer */
  iss: string;
  /** Token ID (JTI) */
  jti: string;
  /** Scopes array */
  scopes: string[];
  /** Agent DID */
  agentDid?: string;
  /** Developer ID */
  developerId?: string;
  /** Grant ID */
  grantId?: string;
  /** Delegation depth */
  delegationDepth?: number;
  /** Token expiry (unix timestamp) */
  exp: number;
  /** Token issued at (unix timestamp) */
  iat: number;
  /** All raw JWT payload claims */
  raw: jose.JWTPayload;
}

/**
 * Augmented Express Request with mcpGrant property.
 */
export interface McpAuthRequest extends IncomingMessage {
  mcpGrant?: McpGrant;
}

export interface RequireMcpAuthOptions {
  /** The issuer URL (JWKS fetched from {issuer}/.well-known/jwks.json) */
  issuer: string;
  /** Required scopes (all must be present). Optional. */
  scopes?: string[];
  /** Allowed algorithms. Defaults to ['RS256', 'ES256', 'PS256', 'EdDSA']. */
  algorithms?: string[];
}

// Module-level JWKS cache keyed by issuer URL
const jwksCache = new Map<string, ReturnType<typeof jose.createRemoteJWKSet>>();

function getJwks(
  issuer: string,
): ReturnType<typeof jose.createRemoteJWKSet> {
  const issuerBase = issuer.endsWith('/') ? issuer.slice(0, -1) : issuer;
  let jwks = jwksCache.get(issuerBase);
  if (!jwks) {
    jwks = jose.createRemoteJWKSet(
      new URL(`${issuerBase}/.well-known/jwks.json`),
    );
    jwksCache.set(issuerBase, jwks);
  }
  return jwks;
}

type NextFunction = (err?: unknown) => void;

/**
 * Express.js middleware that validates a Bearer token (Grantex MCP grant JWT).
 *
 * On success, sets `req.mcpGrant` with decoded claims.
 * On failure, responds with 401 or 403.
 */
export function requireMcpAuth(
  options: RequireMcpAuthOptions,
): (req: McpAuthRequest, res: ServerResponse, next: NextFunction) => void {
  const algorithms: string[] = options.algorithms ?? [
    'RS256',
    'ES256',
    'PS256',
    'EdDSA',
  ];
  const requiredScopes = options.scopes ?? [];

  return async (
    req: McpAuthRequest,
    res: ServerResponse,
    next: NextFunction,
  ) => {
    // Extract Bearer token
    const authHeader =
      req.headers['authorization'] ?? req.headers['Authorization'];
    const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    if (!header) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'unauthorized',
          error_description: 'Missing Authorization header',
        }),
      );
      return;
    }

    const lowerHeader = header.toLowerCase();
    if (!lowerHeader.startsWith('bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'unauthorized',
          error_description: 'Invalid Authorization header format',
        }),
      );
      return;
    }
    const token = header.slice(7).trim();
    if (!token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'unauthorized',
          error_description: 'Invalid Authorization header format',
        }),
      );
      return;
    }

    try {
      const jwks = getJwks(options.issuer);
      const { payload } = await jose.jwtVerify(token, jwks, {
        algorithms,
      });

      // Parse scopes from token
      const tokenScopes = Array.isArray(payload['scp'])
        ? (payload['scp'] as string[])
        : typeof payload['scp'] === 'string'
          ? (payload['scp'] as string).split(' ')
          : [];

      // Check required scopes
      if (requiredScopes.length > 0) {
        const missing = requiredScopes.filter(
          (s) => !tokenScopes.includes(s),
        );
        if (missing.length > 0) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'insufficient_scope',
              error_description: `Missing required scopes: ${missing.join(', ')}`,
            }),
          );
          return;
        }
      }

      // Set decoded grant on request
      req.mcpGrant = {
        sub: (payload.sub as string) ?? '',
        iss: (payload.iss as string) ?? '',
        jti: (payload.jti as string) ?? '',
        scopes: tokenScopes,
        ...(payload['agt'] !== undefined
          ? { agentDid: payload['agt'] as string }
          : {}),
        ...(payload['dev'] !== undefined
          ? { developerId: payload['dev'] as string }
          : {}),
        ...(payload['grnt'] !== undefined
          ? { grantId: payload['grnt'] as string }
          : {}),
        ...(payload['delegationDepth'] !== undefined
          ? { delegationDepth: payload['delegationDepth'] as number }
          : {}),
        exp: payload.exp as number,
        iat: payload.iat as number,
        raw: payload,
      };

      next();
    } catch {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'unauthorized',
          error_description: 'Invalid or expired token',
        }),
      );
    }
  };
}
