import type { FastifyInstance } from 'fastify';
import type { McpAuthConfig } from '../types.js';
import type { McpAuthStorage } from '../storage/types.js';
import { createGrantexTokenVerifier, isConfidentialClient, parseBasicAuth, secretMatches } from '../lib/verify.js';

interface RevokeBody {
  token?: string;
  token_type_hint?: string;
  client_id?: string;
  client_secret?: string;
}

/** Retention for a revoked token that carries no `exp` claim. */
const MAX_REVOCATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function registerRevokeEndpoint(
  app: FastifyInstance,
  config: McpAuthConfig,
  storage: McpAuthStorage,
): void {
  // Revocation is bound to the requesting client (RFC 7009 §2.1), which
  // requires a verified token: the MCP flow issues every grant with the
  // client_id as the Principal (`sub`), so ownership is proven by signature.
  const verifier = createGrantexTokenVerifier(config);

  // Rate limited via @fastify/rate-limit plugin config (20 req/min)
  app.post<{ Body: RevokeBody }>(
    '/revoke',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      if (!verifier.configured) {
        return reply.status(503).send({
          error: 'server_error',
          error_description: 'grantexIssuer is not configured; token revocation is disabled',
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

      // Authenticate client — Basic auth or body credentials
      const basicCreds = parseBasicAuth(request.headers.authorization);
      let authenticatedClientId: string;

      if (basicCreds) {
        const [clientId, clientSecret] = basicCreds;
        const client = await storage.getClient(clientId);
        if (!client || !secretMatches(client.clientSecretHash, clientSecret)) {
          return reply.status(401).send({
            error: 'invalid_client',
            error_description: 'Invalid client credentials',
          });
        }
        authenticatedClientId = client.clientId;
      } else if (body.client_id) {
        const client = await storage.getClient(body.client_id);
        if (!client) {
          return reply.status(401).send({
            error: 'invalid_client',
            error_description: 'Unknown client_id',
          });
        }
        if (
          isConfidentialClient(client) &&
          !secretMatches(client.clientSecretHash, body.client_secret)
        ) {
          return reply.status(401).send({
            error: 'invalid_client',
            error_description: 'Invalid client credentials',
          });
        }
        authenticatedClientId = client.clientId;
      } else {
        return reply.status(401).send({
          error: 'invalid_client',
          error_description:
            'Client authentication is required. Provide Basic auth or client_id in body.',
        });
      }

      // Verify the token (signature, iss, aud) before trusting any claim in
      // it. An expired token is still revocable (RFC 7009 §2.1).
      let jti: string | undefined;
      let subject: string | undefined;
      let expiresAtMs: number | undefined;
      try {
        const payload = await verifier.verify(token, { ignoreExpiration: true });
        jti = payload.jti;
        subject = payload.sub;
        expiresAtMs = typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
      } catch {
        // Invalid / unverifiable token: per RFC 7009 §2.2 respond 200 and do nothing.
        return reply.status(200).send();
      }

      if (!jti) {
        // No JTI to revoke — still return 200 per RFC 7009
        return reply.status(200).send();
      }

      // RFC 7009 §2.1: a client may only revoke tokens issued to it.
      if (subject !== authenticatedClientId) {
        return reply.status(403).send({
          error: 'unauthorized_client',
          error_description: 'Token was not issued to this client',
        });
      }

      // Record the revocation locally first: /introspect and middleware
      // configured with the same storage refuse the token from now on, even
      // if the upstream call below fails. A storage failure is not swallowed
      // (the client gets a 500 and can retry).
      await storage.revokeToken(jti, {
        clientId: authenticatedClientId,
        revokedAt: Date.now(),
        expiresAt: expiresAtMs ?? Date.now() + MAX_REVOCATION_RETENTION_MS,
      });

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
