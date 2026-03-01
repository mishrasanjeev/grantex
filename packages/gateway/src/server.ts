import Fastify, { type FastifyInstance } from 'fastify';
import { verifyGrantToken, GrantexTokenError } from '@grantex/sdk';
import type { GatewayConfig } from './types.js';
import { matchRoute } from './matcher.js';
import { proxyRequest } from './proxy.js';
import { GatewayError } from './errors.js';
import { log } from './logger.js';

export function createGatewayServer(config: GatewayConfig): FastifyInstance {
  const app = Fastify({ logger: false });

  // Capture raw body for proxying
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(null, body);
    }
  });

  // Catch-all route
  app.all('/*', async (req, reply) => {
    const method = req.method;
    const path = req.url.split('?')[0]!;

    // 1. Match route
    const match = matchRoute(method, path, config.routes);
    if (!match) {
      reply.status(404).send({
        error: 'ROUTE_NOT_FOUND',
        message: `No route matches ${method} ${path}`,
      });
      return;
    }

    // 2. Extract Bearer token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      reply.status(401).send({
        error: 'TOKEN_MISSING',
        message: 'Authorization header with Bearer token is required',
      });
      return;
    }
    const token = authHeader.slice(7);

    // 3. Verify grant token
    try {
      const grant = await verifyGrantToken(token, {
        jwksUri: config.jwksUri,
        requiredScopes: match.route.requiredScopes,
      });

      log('info', 'Request authorized', {
        method,
        path,
        principal: grant.principalId,
        agent: grant.agentDid,
        grantId: grant.grantId,
      });

      // 4. Proxy to upstream
      await proxyRequest(req, reply, grant, {
        upstream: config.upstream,
        upstreamHeaders: config.upstreamHeaders,
      });
    } catch (err) {
      if (err instanceof GatewayError) {
        reply.status(err.statusCode).send({
          error: err.code,
          message: err.message,
        });
        return;
      }

      if (err instanceof GrantexTokenError) {
        const isExpired = err.message.toLowerCase().includes('exp');
        const code = isExpired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID';
        const isScopeError = err.message.toLowerCase().includes('scope');

        if (isScopeError) {
          reply.status(403).send({
            error: 'SCOPE_INSUFFICIENT',
            message: err.message,
          });
          return;
        }

        reply.status(401).send({
          error: code,
          message: err.message,
        });
        return;
      }

      log('error', 'Unexpected error', { error: String(err) });
      reply.status(500).send({
        error: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
      });
    }
  });

  return app;
}
