import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { errorsPlugin } from './plugins/errors.js';
import { authPlugin } from './plugins/auth.js';
import { jwksRoutes } from './routes/jwks.js';
import { agentsRoutes } from './routes/agents.js';
import { authorizeRoutes } from './routes/authorize.js';
import { tokenRoutes } from './routes/token.js';
import { grantsRoutes } from './routes/grants.js';
import { tokensRoutes } from './routes/tokens.js';
import { auditRoutes } from './routes/audit.js';

export type AppOptions = {
  logger?: boolean | object;
};

export async function buildApp(opts: AppOptions = {}) {
  const app = Fastify({
    logger: opts.logger ?? true,
    genReqId: () => randomUUID(),
  });

  await app.register(cors);

  // Call directly on root app (not via app.register) so that error handler
  // and preHandler hooks apply to ALL routes registered at the root scope.
  await errorsPlugin(app);
  await authPlugin(app);

  // Public routes (no auth required)
  await app.register(jwksRoutes);

  // Protected routes
  await app.register(agentsRoutes);
  await app.register(authorizeRoutes);
  await app.register(tokenRoutes);
  await app.register(grantsRoutes);
  await app.register(tokensRoutes);
  await app.register(auditRoutes);

  return app;
}
