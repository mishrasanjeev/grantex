import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ClientRegistration, RegisterClientRequest, TokenEndpointAuthMethod } from '../types.js';
import type { McpAuthStorage } from '../storage/types.js';
import { hashClientSecret } from '../lib/verify.js';
import { isAllowedRedirectUri } from '../lib/client-metadata.js';

export function registerRegisterEndpoint(app: FastifyInstance, storage: McpAuthStorage): void {
  app.post<{ Body: RegisterClientRequest }>('/register', async (request, reply) => {
    const { redirect_uris, grant_types, client_name, token_endpoint_auth_method } = request.body ?? {};

    if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      return reply.status(400).send({
        error: 'invalid_client_metadata',
        error_description: 'redirect_uris is required and must be a non-empty array',
      });
    }

    // MCP authorization, Communication Security: redirect URIs are either
    // localhost or https.
    if (redirect_uris.length > 20 || !redirect_uris.every(isAllowedRedirectUri)) {
      return reply.status(400).send({
        error: 'invalid_redirect_uri',
        error_description: 'Every redirect URI must be https, or http on localhost, without a fragment (at most 20)',
      });
    }

    if (client_name !== undefined && (typeof client_name !== 'string' || client_name.trim().length === 0 || client_name.length > 200)) {
      return reply.status(400).send({
        error: 'invalid_client_metadata',
        error_description: 'client_name must be a non-empty string of at most 200 characters',
      });
    }

    if (
      grant_types !== undefined
      && (!Array.isArray(grant_types)
        || !grant_types.includes('authorization_code')
        || !grant_types.every((g) => g === 'authorization_code' || g === 'refresh_token'))
    ) {
      return reply.status(400).send({
        error: 'invalid_client_metadata',
        error_description: 'grant_types must include authorization_code and may add only refresh_token',
      });
    }

    const authMethods: TokenEndpointAuthMethod[] = ['none', 'client_secret_basic', 'client_secret_post'];
    const authMethod: TokenEndpointAuthMethod = token_endpoint_auth_method ?? 'client_secret_basic';
    if (!authMethods.includes(authMethod)) {
      return reply.status(400).send({
        error: 'invalid_client_metadata',
        error_description: 'token_endpoint_auth_method must be one of none, client_secret_basic, client_secret_post',
      });
    }

    const clientId = randomUUID();
    // Public clients (`none`) get no secret and are PKCE-only; confidential
    // clients must present the secret at /token, /introspect and /revoke.
    const clientSecret = authMethod === 'none' ? undefined : randomBytes(32).toString('hex');
    const resolvedGrantTypes = grant_types !== undefined ? [...new Set(grant_types)] : ['authorization_code'];

    const registration: ClientRegistration = {
      clientId,
      // Only the hash is stored; the secret is shown to the client once, below.
      ...(clientSecret !== undefined ? { clientSecretHash: hashClientSecret(clientSecret) } : {}),
      tokenEndpointAuthMethod: authMethod,
      redirectUris: redirect_uris,
      grantTypes: resolvedGrantTypes,
      ...(client_name !== undefined ? { clientName: client_name } : {}),
      createdAt: new Date().toISOString(),
    };

    await storage.putClient(registration);

    return reply.status(201).send({
      client_id: clientId,
      ...(clientSecret !== undefined ? { client_secret: clientSecret } : {}),
      token_endpoint_auth_method: authMethod,
      redirect_uris,
      grant_types: resolvedGrantTypes,
      ...(client_name !== undefined ? { client_name } : {}),
    });
  });
}
