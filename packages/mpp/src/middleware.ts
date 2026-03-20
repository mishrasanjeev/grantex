import type { IssuedPassport, MppPassportMiddlewareOptions } from './types.js';

const PASSPORT_HEADER = 'X-Grantex-Passport';

/**
 * Creates a fetch-compatible middleware function that injects the
 * X-Grantex-Passport header into outgoing MPP requests.
 *
 * When `onRefresh` is provided and the passport is within
 * `autoRefreshThreshold` seconds of expiry, the middleware will
 * automatically call `onRefresh()` to obtain a new passport before
 * attaching it to the request.
 *
 * Usage:
 * ```ts
 * const middleware = createMppPassportMiddleware({
 *   passport,
 *   onRefresh: () => issuePassport(client, originalOptions),
 * });
 * const enrichedRequest = await middleware(new Request(url, init));
 * const response = await fetch(enrichedRequest);
 * ```
 */
export function createMppPassportMiddleware(
  options: MppPassportMiddlewareOptions,
): (request: Request) => Promise<Request> {
  let currentPassport = options.passport;
  const autoRefreshThreshold = options.autoRefreshThreshold ?? 300;
  const onRefresh = options.onRefresh;
  let refreshInProgress: Promise<IssuedPassport> | null = null;

  return async (request: Request): Promise<Request> => {
    const now = Date.now();
    let expiresAt = currentPassport.expiresAt.getTime();

    // Hard expiry — passport is already expired
    if (now >= expiresAt) {
      // Try one last refresh if callback is available
      if (onRefresh && !refreshInProgress) {
        try {
          refreshInProgress = onRefresh();
          currentPassport = await refreshInProgress;
          refreshInProgress = null;
          expiresAt = currentPassport.expiresAt.getTime();
        } catch {
          refreshInProgress = null;
          throw new Error(
            `Agent passport ${currentPassport.passportId} has expired and refresh failed. Issue a new passport before making MPP requests.`,
          );
        }
      } else {
        throw new Error(
          `Agent passport ${currentPassport.passportId} has expired. Issue a new passport before making MPP requests.`,
        );
      }
    }

    // Approaching expiry — proactively refresh if callback is available
    if (expiresAt - now < autoRefreshThreshold * 1000 && onRefresh && !refreshInProgress) {
      refreshInProgress = onRefresh();
      refreshInProgress
        .then((newPassport) => {
          currentPassport = newPassport;
          refreshInProgress = null;
        })
        .catch(() => {
          // Non-fatal: current passport is still valid, just couldn't refresh early
          refreshInProgress = null;
        });
    }

    // Clone the request and add the passport header
    const headers = new Headers(request.headers);
    headers.set(PASSPORT_HEADER, currentPassport.encodedCredential);

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
