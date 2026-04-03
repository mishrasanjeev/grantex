import type { FastifyInstance } from 'fastify';
import * as jose from 'jose';
import type { McpAuthConfig, ClientStore } from '../types.js';

interface RevokeBody {
  token?: string;
  token_type_hint?: string;
  client_id?: string;
  client_secret?: string;
}

/**
 * Extracts client credentials from Basic auth header.
 * Returns [clientId, clientSecret] or undefined if not present.
 */
function parseBasicAuth(
  authHeader: string | undefined,
): [string, string] | undefined {
  if (!authHeader) return undefined;
  const match = /^Basic\s+(.+)$/i.exec(authHeader);
  if (!match?.[1]) return undefined;
  const decoded = Buffer.from(match[1], 'base64').toString('utf-8');
  const colonIdx = decoded.indexOf(':');
  if (colonIdx < 0) return undefined;
  return [decoded.slice(0, colonIdx), decoded.slice(colonIdx + 1)];
}

export function registerRevokeEndpoint(
  app: FastifyInstance,
  config: McpAuthConfig,
  clientStore: ClientStore,
): void {
  app.post<{ Body: RevokeBody }>(
    '/revoke',
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

      // Authenticate client — Basic auth or body credentials
      const basicCreds = parseBasicAuth(request.headers.authorization);
      let authenticatedClientId: string | undefined;

      if (basicCreds) {
        const [clientId, clientSecret] = basicCreds;
        const client = await clientStore.get(clientId);
        if (!client || client.clientSecret !== clientSecret) {
          return reply.status(401).send({
            error: 'invalid_client',
            error_description: 'Invalid client credentials',
          });
        }
        authenticatedClientId = clientId;
      } else if (body.client_id) {
        const client = await clientStore.get(body.client_id);
        if (!client) {
          return reply.status(401).send({
            error: 'invalid_client',
            error_description: 'Unknown client_id',
          });
        }
        if (
          client.clientSecret &&
          body.client_secret !== client.clientSecret
        ) {
          return reply.status(401).send({
            error: 'invalid_client',
            error_description: 'Invalid client credentials',
          });
        }
        authenticatedClientId = body.client_id;
      } else {
        return reply.status(401).send({
          error: 'invalid_client',
          error_description:
            'Client authentication is required. Provide Basic auth or client_id in body.',
        });
      }

      // Extract JTI from the token to revoke it
      let jti: string | undefined;
      try {
        const payload = jose.decodeJwt(token);
        jti = payload.jti;
      } catch {
        // If we can't decode the token, per RFC 7009 we still return 200
        return reply.status(200).send();
      }

      if (!jti) {
        // No JTI to revoke — still return 200 per RFC 7009
        return reply.status(200).send();
      }

      // Revoke via Grantex
      try {
        await config.grantex.tokens.revoke(jti);
      } catch {
        // Per RFC 7009, the server SHOULD return 200 even if revocation fails
        // (e.g., token already revoked, unknown token)
      }

      // Call hook if configured
      if (config.hooks?.onRevocation) {
        try {
          await config.hooks.onRevocation(jti);
        } catch {
          // Hook failures should not affect the response
        }
      }

      return reply.status(200).send();
    },
  );
}
