import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { registerMetadataEndpoint } from './endpoints/metadata.js';
import { registerRegisterEndpoint } from './endpoints/register.js';
import { registerAuthorizeEndpoint } from './endpoints/authorize.js';
import { registerConsentEndpoint } from './endpoints/consent.js';
import { registerTokenEndpoint } from './endpoints/token.js';
import { registerIntrospectEndpoint } from './endpoints/introspect.js';
import { registerRevokeEndpoint } from './endpoints/revoke.js';
import type { McpAuthConfig } from './types.js';
import { serverContext } from './context.js';

const STORAGE_METHODS = [
  'getClient', 'putClient', 'deleteClient',
  'putPendingAuthorization', 'takePendingAuthorization',
  'putAuthorizationCode', 'consumeAuthorizationCode',
  'putRefreshTokenBinding', 'takeRefreshTokenBinding',
  'putConsent', 'takeConsent',
  'revokeToken', 'isTokenRevoked',
] as const;

function assertStorage(config: McpAuthConfig): void {
  const storage = (config as Partial<McpAuthConfig>).storage as unknown as Record<string, unknown> | undefined;
  if (!storage) {
    throw new Error(
      'createMcpAuthServer: `storage` is required. Use PostgresStorage (@grantex/mcp-auth/postgres) '
      + 'or RedisStorage (@grantex/mcp-auth/redis); InMemoryStorage (@grantex/mcp-auth/testing) is for tests.',
    );
  }
  const missing = STORAGE_METHODS.filter((method) => typeof storage[method] !== 'function');
  if (missing.length > 0) {
    throw new Error(`createMcpAuthServer: storage does not implement ${missing.join(', ')}`);
  }
  const legacy = ['clientStore', 'codeStore', 'pendingStore', 'refreshTokenStore']
    .filter((option) => (config as unknown as Record<string, unknown>)[option] !== undefined);
  if (legacy.length > 0) {
    throw new Error(
      `createMcpAuthServer: ${legacy.join(', ')} ${legacy.length === 1 ? 'was' : 'were'} removed in 3.0; `
      + 'pass a single `storage` instead (see docs/mcp-auth.md, "Migrating from 2.x")',
    );
  }
}

export async function createMcpAuthServer(
  config: McpAuthConfig,
): Promise<FastifyInstance> {
  assertStorage(config);
  // Validates issuer, resources, scopes and manifests; throws on anything
  // that would leave tokens unbound or requests ambiguous.
  const ctx = serverContext(config);
  const app = Fastify({ logger: false });

  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });

  registerMetadataEndpoint(app, ctx);
  registerRegisterEndpoint(app, ctx.storage);
  registerAuthorizeEndpoint(app, ctx);
  registerConsentEndpoint(app, ctx);
  registerTokenEndpoint(app, ctx);
  registerIntrospectEndpoint(app, config);
  registerRevokeEndpoint(app, config);

  return app;
}
