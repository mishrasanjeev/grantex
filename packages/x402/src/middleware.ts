/**
 * Express middleware for verifying GDT tokens on x402-gated APIs.
 *
 * Checks for the X-Grantex-GDT header, verifies the token against
 * the request context, and either passes the request through or
 * rejects with a 403 Forbidden.
 */

import { verifyGDT } from './verify.js';
import { HEADERS } from './agent.js';
import type { X402MiddlewareOptions, VerifyContext, VerifyResult } from './types.js';

/** Express-compatible request type (avoids hard dependency). */
interface ExpressRequest {
  headers: Record<string, string | string[] | undefined>;
  path: string;
  method: string;
  get(name: string): string | undefined;
}

/** Express-compatible response type. */
interface ExpressResponse {
  status(code: number): ExpressResponse;
  json(body: unknown): void;
}

/** Express-compatible next function. */
type NextFunction = (err?: unknown) => void;

/**
 * Extend the Express request with verified GDT information.
 * Available after the middleware passes successfully.
 */
export interface GDTRequestInfo {
  /** The verified GDT result. */
  gdt: VerifyResult;
  /** The raw GDT token string. */
  gdtToken: string;
}

/**
 * Create Express middleware that verifies GDT tokens.
 *
 * @example
 * ```ts
 * import express from 'express';
 * import { x402Middleware } from '@grantex/x402';
 *
 * const app = express();
 *
 * // Require a valid GDT for the weather scope
 * app.use('/api/weather', x402Middleware({
 *   requiredScopes: ['weather:read'],
 *   currency: 'USDC',
 * }));
 *
 * app.get('/api/weather/forecast', (req, res) => {
 *   const { gdt } = req as any;
 *   res.json({ forecast: 'sunny', authorizedBy: gdt.principalDID });
 * });
 * ```
 */
export function x402Middleware(options: X402MiddlewareOptions = {}) {
  const {
    requiredScopes,
    currency = 'USDC',
  } = options;

  return async function gdtVerificationMiddleware(
    req: ExpressRequest,
    res: ExpressResponse,
    next: NextFunction,
  ): Promise<void> {
    const gdtToken =
      req.get(HEADERS.GDT) ??
      req.get(HEADERS.GDT.toLowerCase()) ??
      (typeof req.headers['x-grantex-gdt'] === 'string'
        ? req.headers['x-grantex-gdt']
        : undefined);

    if (!gdtToken) {
      res.status(403).json({
        error: 'MISSING_GDT',
        message: 'A valid Grantex Delegation Token (GDT) is required. Include it in the X-Grantex-GDT header.',
      });
      return;
    }

    // Extract spend amount from request
    const amount = options.extractAmount
      ? options.extractAmount(req)
      : parseFloat(req.get(HEADERS.PAYMENT_AMOUNT) ?? req.get('x-payment-amount') ?? '0');

    // Determine the resource scope to check
    const resource = requiredScopes?.[0] ?? deriveResourceScope(req);

    // Build verification context
    const context: VerifyContext = {
      resource,
      amount,
      currency,
    };

    // Verify GDT
    let result: VerifyResult;
    try {
      result = await verifyGDT(gdtToken, context);
    } catch (err) {
      res.status(403).json({
        error: 'GDT_VERIFICATION_ERROR',
        message: err instanceof Error ? err.message : 'GDT verification failed',
      });
      return;
    }

    if (!result.valid) {
      res.status(403).json({
        error: 'INVALID_GDT',
        message: result.error ?? 'GDT verification failed',
        agentDID: result.agentDID,
        principalDID: result.principalDID,
      });
      return;
    }

    // Check all required scopes if multiple are specified
    if (requiredScopes && requiredScopes.length > 1) {
      for (const scope of requiredScopes) {
        if (!result.scopes.includes(scope) && !result.scopes.includes('*')) {
          // Check wildcard patterns
          const matched = result.scopes.some((s) => {
            if (s.endsWith(':*')) {
              return scope.startsWith(s.slice(0, -1));
            }
            return false;
          });
          if (!matched) {
            res.status(403).json({
              error: 'INSUFFICIENT_SCOPE',
              message: `GDT does not grant required scope: ${scope}`,
              grantedScopes: result.scopes,
              requiredScopes,
            });
            return;
          }
        }
      }
    }

    // Attach GDT info to request
    (req as unknown as Record<string, unknown>)['gdt'] = result;
    (req as unknown as Record<string, unknown>)['gdtToken'] = gdtToken;

    next();
  };
}

/**
 * Derive a resource scope from the request path and method.
 * e.g. GET /api/weather/forecast → "weather:read"
 */
function deriveResourceScope(req: ExpressRequest): string {
  const method = req.method.toUpperCase();
  const action = method === 'GET' || method === 'HEAD' ? 'read' : 'write';

  // Extract the first path segment after /api/ as the resource
  const segments = req.path.split('/').filter(Boolean);
  const resource = segments.find((s) => s !== 'api') ?? 'unknown';

  return `${resource}:${action}`;
}
