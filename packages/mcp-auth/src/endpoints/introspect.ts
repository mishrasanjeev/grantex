import type { FastifyInstance } from 'fastify';
import type { McpAuthConfig } from '../types.js';
import { serverContext } from '../context.js';
import { ClientMetadataError } from '../lib/client-metadata.js';
import { createGrantexTokenVerifier, parseBasicAuth, secretMatches } from '../lib/verify.js';

interface IntrospectBody {
  token?: string;
  token_type_hint?: string;
}

export function registerIntrospectEndpoint(
  app: FastifyInstance,
  config: McpAuthConfig,
): void {
  const ctx = serverContext(config);
  const { storage } = ctx;
  const getClient = (clientId: string) => ctx.getClient(clientId).catch((err: unknown) => {
    if (err instanceof ClientMetadataError) return undefined;
    throw err;
  });
  // Tokens are issued by Grantex, not by this server: verify them against
  // the Grantex JWKS with iss/aud pinned. Fail closed when unconfigured.
  const verifier = createGrantexTokenVerifier(config);

  // Rate limited via @fastify/rate-limit plugin config (20 req/min)
  app.post<{ Body: IntrospectBody }>(
    '/introspect',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      if (!verifier.configured) {
        return reply.status(503).send({
          error: 'server_error',
          error_description: 'grantexIssuer is not configured; token introspection is disabled',
        });
      }

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
        const client = await getClient(clientId);
        if (!client || !secretMatches(client.clientSecretHash, clientSecret)) {
          return reply.status(401).send({
            error: 'invalid_client',
            error_description: 'Invalid client credentials',
          });
        }
      }

      try {
        // Signature + alg allow-list + iss + aud (when configured).
        const payload = await verifier.verify(token);

        // A token revoked through this server is inactive even though its
        // signature is still valid. A storage failure throws into the catch
        // below and the token is reported inactive (fail closed).
        if (typeof payload.jti !== 'string' || await storage.isTokenRevoked(payload.jti)) {
          return reply.send({ active: false });
        }

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
