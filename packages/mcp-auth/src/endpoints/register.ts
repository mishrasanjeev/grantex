import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ClientStore, RegisterClientRequest } from '../types.js';

export function registerRegisterEndpoint(app: FastifyInstance, clientStore: ClientStore): void {
  app.post<{ Body: RegisterClientRequest }>('/register', async (request, reply) => {
    const { redirect_uris, grant_types, client_name } = request.body ?? {};

    if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      return reply.status(400).send({
        error: 'invalid_client_metadata',
        error_description: 'redirect_uris is required and must be a non-empty array',
      });
    }

    const clientId = randomUUID();
    const clientSecret = randomBytes(32).toString('hex');
    const resolvedGrantTypes = grant_types ?? ['authorization_code'];

    const registration = {
      clientId,
      clientSecret,
      redirectUris: redirect_uris,
      grantTypes: resolvedGrantTypes,
      ...(client_name !== undefined ? { clientName: client_name } : {}),
      createdAt: new Date().toISOString(),
    };

    await clientStore.set(clientId, registration);

    return reply.status(201).send({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris,
      grant_types: resolvedGrantTypes,
      ...(client_name !== undefined ? { client_name } : {}),
    });
  });
}
