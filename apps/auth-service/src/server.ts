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
import { consentRoutes } from './routes/consent.js';
import { delegateRoutes } from './routes/delegate.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { webhooksRoutes } from './routes/webhooks.js';
import { billingRoutes } from './routes/billing.js';
import { policiesRoutes } from './routes/policies.js';
import { complianceRoutes } from './routes/compliance.js';
import { anomaliesRoutes } from './routes/anomalies.js';
import { scimRoutes } from './routes/scim.js';
import { ssoRoutes } from './routes/sso.js';
import { signupRoutes } from './routes/signup.js';

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
  await app.register(consentRoutes);
  await app.register(dashboardRoutes);

  // Protected routes
  await app.register(agentsRoutes);
  await app.register(authorizeRoutes);
  await app.register(tokenRoutes);
  await app.register(grantsRoutes);
  await app.register(delegateRoutes);
  await app.register(tokensRoutes);
  await app.register(auditRoutes);
  await app.register(webhooksRoutes);
  await app.register(billingRoutes);
  await app.register(policiesRoutes);
  await app.register(complianceRoutes);
  await app.register(anomaliesRoutes);
  await app.register(scimRoutes);
  await app.register(ssoRoutes);
  await app.register(signupRoutes);

  return app;
}
