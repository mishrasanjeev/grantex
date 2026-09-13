import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ClientStore, ClientRegistration, RegisterClientRequest, TokenEndpointAuthMethod } from '../types.js';

export function registerRegisterEndpoint(app: FastifyInstance, clientStore: ClientStore): void {
  app.post<{ Body: RegisterClientRequest }>('/register', async (request, reply) => {
    const { redirect_uris, grant_types, client_name, token_endpoint_auth_method } = request.body ?? {};

    if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      return reply.status(400).send({
        error: 'invalid_client_metadata',
        error_description: 'redirect_uris is required and must be a non-empty array',
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
    const resolvedGrantTypes = grant_types ?? ['authorization_code'];

    const registration: ClientRegistration = {
      clientId,
      ...(clientSecret !== undefined ? { clientSecret } : {}),
      tokenEndpointAuthMethod: authMethod,
      redirectUris: redirect_uris,
      grantTypes: resolvedGrantTypes,
      ...(client_name !== undefined ? { clientName: client_name } : {}),
      createdAt: new Date().toISOString(),
    };

    await clientStore.set(clientId, registration);

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
