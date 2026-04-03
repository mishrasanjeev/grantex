import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { InMemoryClientStore } from './lib/clients.js';
import { InMemoryCodeStore } from './lib/codes.js';
import { registerMetadataEndpoint } from './endpoints/metadata.js';
import { registerRegisterEndpoint } from './endpoints/register.js';
import { registerAuthorizeEndpoint } from './endpoints/authorize.js';
import { registerTokenEndpoint } from './endpoints/token.js';
import { registerIntrospectEndpoint } from './endpoints/introspect.js';
import { registerRevokeEndpoint } from './endpoints/revoke.js';
import type { McpAuthConfig } from './types.js';

export async function createMcpAuthServer(
  config: McpAuthConfig,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });

  const clientStore = config.clientStore ?? new InMemoryClientStore();
  const codeStore = new InMemoryCodeStore();

  registerMetadataEndpoint(app, config);
  registerRegisterEndpoint(app, clientStore);
  registerAuthorizeEndpoint(app, config, clientStore, codeStore);
  registerTokenEndpoint(app, config, clientStore, codeStore);
  registerIntrospectEndpoint(app, config, clientStore);
  registerRevokeEndpoint(app, config, clientStore);

  return app;
}
