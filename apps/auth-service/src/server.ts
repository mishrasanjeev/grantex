import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
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
import { meRoutes } from './routes/me.js';
import { healthRoutes } from './routes/health.js';
import { adminRoutes } from './routes/admin.js';
import { principalRoutes } from './routes/principal.js';
import { vaultRoutes } from './routes/vault.js';
import { metricsRoutes } from './routes/metrics.js';
import { eventsRoutes } from './routes/events.js';
import { budgetRoutes } from './routes/budget.js';
import { usageRoutes } from './routes/usage.js';
import { verifyEmailRoutes } from './routes/verify-email.js';
import { domainsRoutes } from './routes/domains.js';
import { policySyncRoutes } from './routes/policy-sync.js';
import { didRoutes } from './routes/did.js';
import { webauthnRoutes } from './routes/webauthn.js';
import { credentialsRoutes } from './routes/credentials.js';
import { passportRoutes } from './routes/passport.js';
import { trustRegistryRoutes } from './routes/trust-registry.js';
import { consentBundlesRoutes } from './routes/consent-bundles.js';
import { mcpServersRoutes } from './routes/mcp-servers.js';
import { dpdpRoutes } from './routes/dpdp.js';
import { metricsHookPlugin } from './plugins/metricsHook.js';
import websocket from '@fastify/websocket';

export type AppOptions = {
  logger?: boolean | object;
};

const defaultLoggerOptions = {
  level: process.env.LOG_LEVEL || 'info',
  ...(process.env.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty' } }
    : {}),
};

export async function buildApp(opts: AppOptions = {}) {
  const app = Fastify({
    logger: opts.logger ?? defaultLoggerOptions,
    bodyLimit: 1_048_576,
    genReqId: () => randomUUID(),
  });

  await app.register(cors, { origin: false });
  await app.register(websocket);

  // HTTP security headers
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-XSS-Protection', '0');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'");
  });

  // Global rate limit: 100 requests/minute, keyed strictly by source IP.
  // Earlier versions keyed on the Bearer token, which let an attacker
  // bypass the limiter by varying invalid tokens to mint fresh buckets
  // (each fake token got its own 100/min budget). IP-keying closes that
  // hole. Per-developer plan-based throughput is the responsibility of
  // a post-auth limiter (see plugins/dynamicRateLimit.ts), not this
  // global pre-auth net.
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
    allowList: (req) => {
      // Skip rate limiting for JWKS (public key distribution must never be throttled)
      return req.url.startsWith('/.well-known/');
    },
  });

  // Call directly on root app (not via app.register) so that error handler
  // and preHandler hooks apply to ALL routes registered at the root scope.
  await errorsPlugin(app);
  await authPlugin(app);

  // Metrics hook (records HTTP duration for all routes)
  await metricsHookPlugin(app);

  // Public routes (no auth required)
  await app.register(jwksRoutes);
  await app.register(didRoutes);
  await app.register(healthRoutes);
  await app.register(consentRoutes);
  await app.register(dashboardRoutes);
  await app.register(metricsRoutes);

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
  await app.register(meRoutes);
  await app.register(adminRoutes);
  await app.register(principalRoutes);
  await app.register(vaultRoutes);
  await app.register(eventsRoutes);
  await app.register(budgetRoutes);
  await app.register(usageRoutes);
  await app.register(verifyEmailRoutes);
  await app.register(domainsRoutes);
  await app.register(policySyncRoutes);
  await app.register(webauthnRoutes);
  await app.register(credentialsRoutes);
  await app.register(passportRoutes);
  await app.register(trustRegistryRoutes);
  await app.register(consentBundlesRoutes);
  await app.register(mcpServersRoutes);
  await app.register(dpdpRoutes);

  return app;
}
