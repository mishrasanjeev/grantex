import { createMcpResourceGuard } from '../resource/guard.js';
import type { McpGrant, McpResourceGuardOptions } from '../resource/guard.js';
import { buildProtectedResourceMetadata } from '../resource/metadata.js';
import type { ProtectedResourceMetadataOptions } from '../resource/metadata.js';

export type { McpGrant } from '../resource/guard.js';

/** Options for {@link requireMcpAuth}; see `McpResourceGuardOptions`. */
export type RequireMcpAuthOptions = McpResourceGuardOptions;

/**
 * Generic Hono-compatible context and middleware types.
 * We use structural typing to avoid requiring hono as a dependency.
 */
interface HonoContext {
  req: {
    header(name: string): string | undefined;
    /** Read only when `tools` enforcement is configured. */
    method?: string;
    json?(): Promise<unknown>;
  };
  set(key: string, value: unknown): void;
  json(data: unknown, status?: number, headers?: Record<string, string>): Response;
}

type HonoNext = () => Promise<void>;

/**
 * Hono middleware that validates a Bearer token (Grantex MCP grant JWT) and,
 * when `tools` is configured, refuses any `tools/call` the grant does not
 * cover.
 *
 * On success, sets `c.set('mcpGrant', grant)` with decoded claims.
 */
export function requireMcpAuth(
  options: RequireMcpAuthOptions,
): (c: HonoContext, next: HonoNext) => Promise<Response | void> {
  const guard = createMcpResourceGuard(options);

  return async (c, next) => {
    const method = c.req.method ?? 'GET';
    let body: unknown;
    let bodyParsed = false;
    if (options.tools && !['GET', 'HEAD', 'DELETE', 'OPTIONS'].includes(method.toUpperCase()) && c.req.json) {
      try {
        body = await c.req.json();
        bodyParsed = true;
      } catch {
        return c.json({ error: 'invalid_request', error_description: 'Request body is not valid JSON' }, 400);
      }
    }
    const result = await guard({ header: (name) => c.req.header(name), method, body, bodyParsed });
    if (!result.ok) {
      return c.json(result.body, result.status, result.headers);
    }
    c.set('mcpGrant', result.grant as McpGrant);
    // Outside any try/catch: an error thrown downstream propagates to Hono's
    // error handler instead of turning into a 401.
    await next();
  };
}

/** Hono handler serving RFC 9728 protected-resource metadata. */
export function protectedResourceMetadataRoute(
  options: ProtectedResourceMetadataOptions,
): (c: HonoContext) => Response {
  const document = buildProtectedResourceMetadata(options);
  return (c) => c.json(document, 200, { 'Cache-Control': 'public, max-age=300' });
}
