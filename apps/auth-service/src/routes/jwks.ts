import type { FastifyInstance } from 'fastify';
import { buildJwks } from '../lib/crypto.js';
import { config } from '../config.js';
import { DPOP_SIGNING_ALGORITHMS } from '../lib/dpop.js';

export async function jwksRoutes(app: FastifyInstance): Promise<void> {
  app.get('/.well-known/oauth-authorization-server', async (_request, reply) => {
    const issuer = config.jwtIssuer.replace(/\/$/, '');
    const apiBase = config.publicBaseUrl.replace(/\/$/, '');
    return reply.send({
      issuer,
      authorization_endpoint: `${apiBase}/oauth/authorize`,
      token_endpoint: `${apiBase}/oauth/token`,
      jwks_uri: `${apiBase}/.well-known/jwks.json`,
      revocation_endpoint: `${apiBase}/oauth/revoke`,
      pushed_authorization_request_endpoint: `${apiBase}/oauth/par`,
      require_pushed_authorization_requests: true,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: [
        'authorization_code',
        'refresh_token',
        'urn:ietf:params:oauth:grant-type:token-exchange',
      ],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
      dpop_signing_alg_values_supported: [...DPOP_SIGNING_ALGORITHMS],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      grantex_agent_registration_endpoint: `${apiBase}/v1/agents`,
      grantex_legacy_authorization_request_endpoint: `${apiBase}/v1/authorize`,
      grantex_legacy_token_endpoint: `${apiBase}/v1/token`,
      grantex_legacy_token_refresh_endpoint: `${apiBase}/v1/token/refresh`,
      grantex_conforming_roles: ['authorization_server', 'resource_server'],
      grantex_profile_revision: 'draft-mishra-oauth-agent-grants-03',
    });
  });

  app.get('/.well-known/jwks.json', async (_request, reply) => {
    const jwks = await buildJwks();
    await reply.send(jwks);
  });
}
