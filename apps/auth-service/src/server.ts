import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import rateLimit from '@fastify/rate-limit';
import { errorsPlugin } from './plugins/errors.js';
import { authPlugin } from './plugins/auth.js';
import { dynamicRateLimitPlugin } from './plugins/dynamicRateLimit.js';
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
import { commerceRoutes } from './routes/commerce.js';
import { commerceWellKnownRoutes } from './routes/commerce-well-known.js';
import { commerceMcpRoutes } from './routes/commerce-mcp.js';
import { commerceMerchantWebhookRoutes } from './routes/commerce-merchant-webhooks.js';
import { commerceProviderWebhookRoutes } from './routes/commerce-provider-webhooks.js';
import { metricsHookPlugin } from './plugins/metricsHook.js';
import websocket from '@fastify/websocket';

export type AppOptions = {
  logger?: boolean | object;
  trustProxy?: false | number | string | string[];
};

const defaultLoggerOptions = {
  level: process.env.LOG_LEVEL || 'info',
  ...(process.env.NODE_ENV === 'development'
    && process.env.LOG_PRETTY !== 'false'
    ? { transport: { target: 'pino-pretty' } }
    : {}),
};

export async function buildApp(opts: AppOptions = {}) {
  const app = Fastify({
    logger: opts.logger ?? defaultLoggerOptions,
    trustProxy: opts.trustProxy ?? config.trustProxy,
    bodyLimit: 1_048_576,
    genReqId: () => randomUUID(),
  });

  // Register before CORS so the global onRoute hook also attaches the
  // default policy to the synthetic OPTIONS routes created by @fastify/cors.
  await app.register(rateLimit, {
    max: 5_000,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
    allowList: (req) => {
      // Skip rate limiting only for JWKS (public key distribution must
      // never be throttled). Other well-known routes, including the
      // commerce publishing profile, keep their route override or this default.
      return req.url === '/.well-known/jwks.json'
        || req.url.startsWith('/.well-known/jwks.json?');
    },
  });

  // Browser clients (developer dashboard at grantex.dev/dashboard, local
  // Vite during development) need to call the API cross-origin. Fastify-cors
  // handles OPTIONS at preValidation: after the pre-auth IP limiter's
  // onRequest hook, but before the auth preHandler. Allowed origins receive
  // Access-Control-Allow-Origin while unknown origins still fail the browser's
  // CORS check.
  const allowedOrigins = new Set(config.corsAllowedOrigins);
  await app.register(cors, {
    hook: 'preValidation',
    origin: (origin, cb) => {
      // Same-origin and non-browser callers have no Origin header — allow.
      if (!origin) return cb(null, true);
      if (allowedOrigins.has(origin)) return cb(null, true);
      // Unknown origin: reflect back "false" so the browser blocks the
      // response but we don't throw a 5xx on the server.
      return cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
    exposedHeaders: [
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'Retry-After',
    ],
    maxAge: 600,
  });
  await app.register(websocket);

  // HTTP security headers. Most are unconditional defaults; CSP and
  // Referrer-Policy are conditional so individual routes can apply
  // stricter policies (e.g., commerce consent uses Referrer-Policy:
  // no-referrer because the URL may carry one-shot session tokens).
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-XSS-Protection', '0');
    if (!reply.getHeader('Referrer-Policy')) {
      reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    }
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('Cache-Control', 'no-store');
    if (!reply.getHeader('Content-Security-Policy')) {
      reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    }
  });

  // Default rate limit: 5,000 requests/minute, keyed by Fastify's request.ip.
  // Forwarded client addresses are used only when TRUST_PROXY explicitly
  // identifies the trusted proxy chain; otherwise spoofable forwarding
  // headers are ignored and the direct socket address is used.
  // Earlier versions keyed on the Bearer token, which let an attacker
  // bypass the limiter by varying invalid tokens to mint fresh buckets
  // (each fake token got its own budget). IP-keying closes that hole.
  //
  // The number is deliberately generous — authenticated endpoints have
  // this no-override Fastify policy. A route-level rateLimit object replaces
  // it for that route, normally with a lower per-IP ceiling. Standard
  // developer API-key routes receive an additional Redis-backed plan bucket
  // after authentication; /v1/authorize also uses a developer-keyed 10/min
  // bucket. Keeping the default above the 2,000/min Enterprise budget avoids
  // making that plan unreachable from one IP on routes without an override.
  // Custom-auth routes skip the standard plan bucket and retain their route
  // override or this default. The active Fastify policy shields public
  // endpoints and the auth plugin from raw IP floods, while plan throughput
  // belongs in the post-auth limiter.

  // Call directly on root app (not via app.register) so that error handler
  // and preHandler hooks apply to ALL routes registered at the root scope.
  await errorsPlugin(app);
  await authPlugin(app);
  await dynamicRateLimitPlugin(app);

  // Metrics hook (records HTTP duration for all routes)
  await metricsHookPlugin(app);

  // Public routes (no auth required)
  await app.register(jwksRoutes);
  await app.register(didRoutes);
  await app.register(healthRoutes);
  await app.register(consentRoutes);
  await app.register(dashboardRoutes);
  await app.register(metricsRoutes);
  await app.register(commerceWellKnownRoutes);
  await app.register(commerceMcpRoutes);

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

  // Grantex Commerce V1 — registered with prefix so all commerce paths
  // share the spec §16 envelope via the sub-instance error handler.
  // The plugin's preHandler enforces the COMMERCE_V1_ENABLED flag and
  // resolves request.commerceTenantId.
  await app.register(commerceRoutes, { prefix: '/v1/commerce' });
  await app.register(commerceProviderWebhookRoutes, { prefix: '/v1/webhooks/providers' });
  await app.register(commerceMerchantWebhookRoutes, { prefix: '/v1/webhooks/merchant' });

  return app;
}
