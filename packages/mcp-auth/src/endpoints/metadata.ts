import type { FastifyInstance } from 'fastify';
import type { McpAuthConfig } from '../types.js';

export function registerMetadataEndpoint(app: FastifyInstance, config: McpAuthConfig): void {
  app.get('/.well-known/oauth-authorization-server', async (_request, reply) => {
    const issuer = config.issuer.endsWith('/') ? config.issuer.slice(0, -1) : config.issuer;

    const consentUi = config.consentUi;

    return reply.send({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      introspection_endpoint: `${issuer}/introspect`,
      revocation_endpoint: `${issuer}/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
      introspection_endpoint_auth_methods_supported: ['client_secret_basic', 'none'],
      revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      scopes_supported: config.scopes,
      ...(config.allowedResources !== undefined && config.allowedResources.length > 0
        ? { resource_indicators_supported: true }
        : {}),
      grantex_extensions: {
        consent_ui: `${issuer}/consent`,
        audit_stream: `${issuer}/events/stream`,
        ...(consentUi !== undefined ? { consent_ui_config: consentUi } : {}),
      },
    });
  });
}
