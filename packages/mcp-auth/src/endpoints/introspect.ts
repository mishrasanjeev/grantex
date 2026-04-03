import type { FastifyInstance } from 'fastify';
import * as jose from 'jose';
import type { McpAuthConfig, ClientStore } from '../types.js';

interface IntrospectBody {
  token?: string;
  token_type_hint?: string;
}

/**
 * Extracts client credentials from Basic auth header.
 * Returns [clientId, clientSecret] or undefined if not present.
 */
function parseBasicAuth(
  authHeader: string | undefined,
): [string, string] | undefined {
  if (!authHeader) return undefined;
  const lower = authHeader.toLowerCase();
  if (!lower.startsWith('basic ')) return undefined;
  const b64 = authHeader.slice(6).trim();
  if (!b64) return undefined;
  const decoded = Buffer.from(b64, 'base64').toString('utf-8');
  const colonIdx = decoded.indexOf(':');
  if (colonIdx < 0) return undefined;
  return [decoded.slice(0, colonIdx), decoded.slice(colonIdx + 1)];
}

export function registerIntrospectEndpoint(
  app: FastifyInstance,
  config: McpAuthConfig,
  clientStore: ClientStore,
): void {
  // Cache the JWKS remote key set
  let jwks: ReturnType<typeof jose.createRemoteJWKSet> | undefined;

  function getJwks(): ReturnType<typeof jose.createRemoteJWKSet> {
    if (!jwks) {
      const issuerBase = config.issuer.endsWith('/') ? config.issuer.slice(0, -1) : config.issuer;
      const jwksUrl = new URL(`${issuerBase}/.well-known/jwks.json`);
      jwks = jose.createRemoteJWKSet(jwksUrl);
    }
    return jwks;
  }

  // Rate limited via @fastify/rate-limit plugin config (20 req/min)
  app.post<{ Body: IntrospectBody }>(
    '/introspect',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const body = request.body ?? {};
      const token = body.token;

      if (!token || typeof token !== 'string') {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'token parameter is required',
        });
      }

      // Optional client authentication via Basic auth
      const basicCreds = parseBasicAuth(
        request.headers.authorization,
      );
      if (basicCreds) {
        const [clientId, clientSecret] = basicCreds;
        const client = await clientStore.get(clientId);
        if (!client || client.clientSecret !== clientSecret) {
          return reply.status(401).send({
            error: 'invalid_client',
            error_description: 'Invalid client credentials',
          });
        }
      }

      try {
        // First decode the header to check algorithm
        const header = jose.decodeProtectedHeader(token);

        // Reject weak algorithms — only RS256 and ES256 are accepted
        const allowedAlgs = ['RS256', 'ES256', 'PS256', 'EdDSA'];
        if (
          header.alg &&
          !allowedAlgs.includes(header.alg)
        ) {
          return reply.send({ active: false });
        }

        // Verify the token against the JWKS
        const { payload } = await jose.jwtVerify(token, getJwks(), {
          algorithms: allowedAlgs,
        });

        // Build RFC 7662 introspection response
        const scopes = Array.isArray(payload['scp'])
          ? (payload['scp'] as string[]).join(' ')
          : typeof payload['scp'] === 'string'
            ? payload['scp']
            : undefined;

        const response: Record<string, unknown> = {
          active: true,
          ...(scopes !== undefined ? { scope: scopes } : {}),
          ...(payload.sub !== undefined ? { sub: payload.sub } : {}),
          ...(payload.exp !== undefined ? { exp: payload.exp } : {}),
          ...(payload.iat !== undefined ? { iat: payload.iat } : {}),
          ...(payload.jti !== undefined ? { jti: payload.jti } : {}),
          ...(payload.iss !== undefined ? { iss: payload.iss } : {}),
          ...(payload.aud !== undefined ? { aud: payload.aud } : {}),
          token_type: 'bearer',
        };

        // Grantex extension claims
        if (payload['agt']) {
          response['grantex_agent_did'] = payload['agt'];
        }
        if (payload['dev']) {
          response['client_id'] = payload['dev'];
        }
        if (payload['grnt']) {
          response['grantex_grant_id'] = payload['grnt'];
        }
        if (payload['delegationDepth'] !== undefined) {
          response['grantex_delegation_depth'] = payload['delegationDepth'];
        } else {
          // Default to 0 (root grant)
          response['grantex_delegation_depth'] = 0;
        }
        if (payload['parentAgt']) {
          response['grantex_parent_agent'] = payload['parentAgt'];
        }
        if (payload['bdg'] !== undefined) {
          response['grantex_budget_remaining'] = payload['bdg'];
        }

        return reply.send(response);
      } catch {
        // Any error (expired, malformed, signature invalid) => inactive
        return reply.send({ active: false });
      }
    },
  );
}
