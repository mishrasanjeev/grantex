import type { FastifyInstance } from 'fastify';
import type { McpAuthConfig } from '../types.js';

export function registerMetadataEndpoint(app: FastifyInstance, config: McpAuthConfig): void {
  app.get('/.well-known/oauth-authorization-server', async (_request, reply) => {
    const issuer = config.issuer.replace(/\/$/, '');
    return reply.send({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
      scopes_supported: config.scopes,
      ...(config.allowedResources !== undefined && config.allowedResources.length > 0
        ? { resource_indicators_supported: true }
        : {}),
    });
  });
}
