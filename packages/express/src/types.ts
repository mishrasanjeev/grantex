import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { VerifiedGrant } from '@grantex/sdk';

// ─── Configuration ───────────────────────────────────────────────────────────

export interface GrantexMiddlewareOptions {
  /**
   * JWKS endpoint URL for offline token verification.
   * For the hosted Grantex service this is:
   * `https://grantex-auth-dd4mtrt2gq-uc.a.run.app/.well-known/jwks.json`
   */
  jwksUri: string;

  /**
   * How to extract the grant token from the incoming request.
   * Defaults to reading the `Authorization: Bearer <token>` header.
   *
   * Return `undefined` or `null` to indicate no token was found.
   */
  tokenExtractor?: (req: Request) => string | undefined | null;

  /**
   * Clock tolerance in seconds for JWT expiry checks.
   * Useful when server clocks are slightly out of sync.
   * @default 0
   */
  clockTolerance?: number;

  /**
   * Expected JWT audience claim. Leave undefined to skip audience check.
   */
  audience?: string;

  /**
   * Custom error handler. Called when token verification fails.
   * If not provided, the middleware sends a JSON error response automatically.
   */
  onError?: (err: GrantexExpressError, req: Request, res: Response, next: NextFunction) => void;
}

// ─── Request augmentation ────────────────────────────────────────────────────

/**
 * After `requireGrantToken()` succeeds, `req.grant` is populated
 * with the verified grant information.
 */
export interface GrantexRequest extends Request {
  grant: VerifiedGrant;
}

// ─── Error types ─────────────────────────────────────────────────────────────

export type GrantexExpressErrorCode =
  | 'TOKEN_MISSING'
  | 'TOKEN_INVALID'
  | 'TOKEN_EXPIRED'
  | 'SCOPE_INSUFFICIENT';

export interface GrantexExpressError extends Error {
  code: GrantexExpressErrorCode;
  statusCode: number;
}
