import type { FastifyInstance } from 'fastify';
import { buildJwks } from '../lib/crypto.js';
import { config } from '../config.js';

export async function jwksRoutes(app: FastifyInstance): Promise<void> {
  app.get('/.well-known/oauth-authorization-server', async (_request, reply) => {
    const issuer = config.jwtIssuer.replace(/\/$/, '');
    const apiBase = config.publicBaseUrl.replace(/\/$/, '');
    return reply.send({
      issuer,
      jwks_uri: `${apiBase}/.well-known/jwks.json`,
      grant_types_supported: ['urn:grantex:params:oauth:grant-type:agent-grant'],
      code_challenge_methods_supported: ['S256'],
      grantex_agent_registration_endpoint: `${apiBase}/v1/agents`,
      grantex_authorization_request_endpoint: `${apiBase}/v1/authorize`,
      grantex_token_exchange_endpoint: `${apiBase}/v1/token`,
      grantex_token_refresh_endpoint: `${apiBase}/v1/token/refresh`,
      grantex_profile_status: 'implementation-specific-extension',
    });
  });

  app.get('/.well-known/jwks.json', async (_request, reply) => {
    const jwks = await buildJwks();
    await reply.send(jwks);
  });
}
