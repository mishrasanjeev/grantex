import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { verifyGrantToken, GrantexTokenError } from '@grantex/sdk';
import type { VerifiedGrant } from '@grantex/sdk';
import type { GrantexMiddlewareOptions, GrantexRequest } from './types.js';
import { GrantexMiddlewareError } from './errors.js';

/**
 * Default token extractor: reads the `Authorization: Bearer <token>` header.
 */
function defaultTokenExtractor(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return undefined;
  return parts[1];
}

function defaultErrorHandler(
  err: GrantexMiddlewareError,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  res.status(err.statusCode).json({
    error: err.code,
    message: err.message,
  });
}

/**
 * Creates an Express middleware that verifies Grantex grant tokens.
 *
 * On success, `req.grant` is populated with the decoded `VerifiedGrant`
 * and the next handler is called. On failure, a JSON error response is
 * sent (or your custom `onError` handler is invoked).
 *
 * @example
 * ```typescript
 * import express from 'express';
 * import { requireGrantToken } from '@grantex/express';
 *
 * const app = express();
 * const JWKS_URI = 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app/.well-known/jwks.json';
 *
 * // Protect all routes under /api
 * app.use('/api', requireGrantToken({ jwksUri: JWKS_URI }));
 *
 * app.get('/api/calendar', (req, res) => {
 *   // req.grant is available here
 *   res.json({ principalId: req.grant.principalId, scopes: req.grant.scopes });
 * });
 * ```
 */
export function requireGrantToken(options: GrantexMiddlewareOptions): RequestHandler {
  const {
    jwksUri,
    tokenExtractor = defaultTokenExtractor,
    clockTolerance,
    audience,
    onError = defaultErrorHandler,
  } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = tokenExtractor(req);

    if (!token) {
      const err = new GrantexMiddlewareError(
        'TOKEN_MISSING',
        'No grant token found. Send a Grantex JWT in the Authorization header as "Bearer <token>".',
        401,
      );
      onError(err, req, res, next);
      return;
    }

    try {
      const grant = await verifyGrantToken(token, {
        jwksUri,
        ...(clockTolerance !== undefined ? { clockTolerance } : {}),
        ...(audience !== undefined ? { audience } : {}),
      });

      (req as GrantexRequest).grant = grant;
      next();
    } catch (err) {
      if (err instanceof GrantexTokenError) {
        const isExpired = err.message.includes('exp');
        const code = isExpired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID';
        const statusCode = 401;
        const mwErr = new GrantexMiddlewareError(code, err.message, statusCode);
        onError(mwErr, req, res, next);
        return;
      }
      next(err);
    }
  };
}

/**
 * Creates an Express middleware that checks whether the verified grant
 * contains **all** of the required scopes.
 *
 * Must be used **after** `requireGrantToken()` so that `req.grant` is set.
 *
 * @example
 * ```typescript
 * import { requireGrantToken, requireScopes } from '@grantex/express';
 *
 * app.get(
 *   '/api/calendar',
 *   requireGrantToken({ jwksUri: JWKS_URI }),
 *   requireScopes('calendar:read'),
 *   (req, res) => {
 *     res.json({ events: getCalendarEvents(req.grant.principalId) });
 *   },
 * );
 *
 * // Multiple scopes — the token must contain ALL of them
 * app.post(
 *   '/api/calendar/events',
 *   requireGrantToken({ jwksUri: JWKS_URI }),
 *   requireScopes('calendar:read', 'calendar:write'),
 *   (req, res) => {
 *     // ...
 *   },
 * );
 * ```
 */
export function requireScopes(...scopes: string[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const grant = (req as GrantexRequest).grant;

    if (!grant) {
      const err = new GrantexMiddlewareError(
        'TOKEN_MISSING',
        'requireScopes() must be used after requireGrantToken(). No grant found on request.',
        500,
      );
      res.status(err.statusCode).json({ error: err.code, message: err.message });
      return;
    }

    const missing = scopes.filter((s) => !grant.scopes.includes(s));

    if (missing.length > 0) {
      const err = new GrantexMiddlewareError(
        'SCOPE_INSUFFICIENT',
        `Grant token is missing required scopes: ${missing.join(', ')}`,
        403,
      );

      res.status(err.statusCode).json({ error: err.code, message: err.message });
      return;
    }

    next();
  };
}

/**
 * Creates a Grantex middleware instance with pre-configured options.
 * Useful when you want to share the same JWKS URI and settings
 * across many routes without repeating yourself.
 *
 * @example
 * ```typescript
 * import { createGrantex } from '@grantex/express';
 *
 * const grantex = createGrantex({
 *   jwksUri: 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app/.well-known/jwks.json',
 *   clockTolerance: 5,
 * });
 *
 * // Short, clean route definitions
 * app.get('/api/calendar', grantex.requireToken(), grantex.requireScopes('calendar:read'), handler);
 * app.get('/api/email',    grantex.requireToken(), grantex.requireScopes('email:read'),    handler);
 * ```
 */
export function createGrantex(options: GrantexMiddlewareOptions) {
  return {
    /**
     * Middleware that verifies the grant token.
     * Uses the options provided to `createGrantex()`.
     * You can pass additional per-route options to override.
     */
    requireToken(overrides?: Partial<GrantexMiddlewareOptions>): RequestHandler {
      return requireGrantToken({ ...options, ...overrides });
    },

    /**
     * Middleware that checks required scopes on `req.grant`.
     * Must be used after `requireToken()`.
     */
    requireScopes(...scopes: string[]): RequestHandler {
      return requireScopes(...scopes);
    },
  };
}
