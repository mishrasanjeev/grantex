import type { IssuedPassport, MppPassportMiddlewareOptions } from './types.js';

const PASSPORT_HEADER = 'X-Grantex-Passport';

/**
 * Creates a fetch-compatible middleware function that injects the
 * X-Grantex-Passport header into outgoing MPP requests.
 *
 * Usage:
 * ```ts
 * const middleware = createMppPassportMiddleware({ passport });
 * const enrichedRequest = await middleware(new Request(url, init));
 * const response = await fetch(enrichedRequest);
 * ```
 */
export function createMppPassportMiddleware(
  options: MppPassportMiddlewareOptions,
): (request: Request) => Promise<Request> {
  const { passport } = options;
  const _autoRefreshThreshold = options.autoRefreshThreshold ?? 300;

  return async (request: Request): Promise<Request> => {
    // Check if passport is still valid
    const now = Date.now();
    const expiresAt = passport.expiresAt.getTime();

    if (now >= expiresAt) {
      throw new Error(
        `Agent passport ${passport.passportId} has expired. Issue a new passport before making MPP requests.`,
      );
    }

    // TODO: auto-refresh passport when within threshold
    if (expiresAt - now < _autoRefreshThreshold * 1000) {
      // For now, just warn — auto-refresh requires callback to re-issue
      console.warn(
        `Agent passport ${passport.passportId} expires in ${Math.round((expiresAt - now) / 1000)}s. Consider refreshing.`,
      );
    }

    // Clone the request and add the passport header
    const headers = new Headers(request.headers);
    headers.set(PASSPORT_HEADER, passport.encodedCredential);

    const init: RequestInit = {
      method: request.method,
      headers,
      redirect: request.redirect,
      signal: request.signal,
    };

    // Forward body if present (duplex required for streaming bodies in Node)
    if (request.body) {
      init.body = request.body;
      (init as Record<string, unknown>).duplex = 'half';
    }

    return new Request(request.url, init);
  };
}

/**
 * Convenience function to encode a passport for use in the X-Grantex-Passport header.
 */
export function encodePassport(passport: IssuedPassport): string {
  return passport.encodedCredential;
}
