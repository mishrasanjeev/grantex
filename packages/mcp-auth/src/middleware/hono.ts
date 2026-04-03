import * as jose from 'jose';

/**
 * Decoded Grantex MCP grant claims.
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

export interface RequireMcpAuthOptions {
  /** The issuer URL (JWKS fetched from {issuer}/.well-known/jwks.json) */
  issuer: string;
  /** Required scopes (all must be present). Optional. */
  scopes?: string[];
  /** Allowed algorithms. Defaults to ['RS256', 'ES256', 'PS256', 'EdDSA']. */
  algorithms?: string[];
}

/**
 * Generic Hono-compatible context and middleware types.
 * We use structural typing to avoid requiring hono as a dependency.
 */
interface HonoContext {
  req: {
    header(name: string): string | undefined;
  };
  set(key: string, value: unknown): void;
  json(data: unknown, status?: number): Response;
}

type HonoNext = () => Promise<void>;

// Module-level JWKS cache keyed by issuer URL
const jwksCache = new Map<string, ReturnType<typeof jose.createRemoteJWKSet>>();

function getJwks(
  issuer: string,
): ReturnType<typeof jose.createRemoteJWKSet> {
  const issuerBase = issuer.replace(/\/$/, '');
  let jwks = jwksCache.get(issuerBase);
  if (!jwks) {
    jwks = jose.createRemoteJWKSet(
      new URL(`${issuerBase}/.well-known/jwks.json`),
    );
    jwksCache.set(issuerBase, jwks);
  }
  return jwks;
}

/**
 * Hono middleware that validates a Bearer token (Grantex MCP grant JWT).
 *
 * On success, sets `c.set('mcpGrant', grant)` with decoded claims.
 * On failure, responds with 401 or 403.
 */
export function requireMcpAuth(
  options: RequireMcpAuthOptions,
): (c: HonoContext, next: HonoNext) => Promise<Response | void> {
  const algorithms: string[] = options.algorithms ?? [
    'RS256',
    'ES256',
    'PS256',
    'EdDSA',
  ];
  const requiredScopes = options.scopes ?? [];

  return async (c: HonoContext, next: HonoNext) => {
    // Extract Bearer token
    const header = c.req.header('authorization');
    if (!header) {
      return c.json(
        {
          error: 'unauthorized',
          error_description: 'Missing Authorization header',
        },
        401,
      );
    }

    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match?.[1]) {
      return c.json(
        {
          error: 'unauthorized',
          error_description: 'Invalid Authorization header format',
        },
        401,
      );
    }

    const token = match[1];

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
          return c.json(
            {
              error: 'insufficient_scope',
              error_description: `Missing required scopes: ${missing.join(', ')}`,
            },
            403,
          );
        }
      }

      // Set decoded grant on context
      const grant: McpGrant = {
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

      c.set('mcpGrant', grant);
      await next();
    } catch {
      return c.json(
        {
          error: 'unauthorized',
          error_description: 'Invalid or expired token',
        },
        401,
      );
    }
  };
}
