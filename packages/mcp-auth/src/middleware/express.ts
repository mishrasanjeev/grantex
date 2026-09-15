import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMcpResourceGuard } from '../resource/guard.js';
import type { McpGrant, McpResourceGuardOptions } from '../resource/guard.js';
import { buildProtectedResourceMetadata } from '../resource/metadata.js';
import type { ProtectedResourceMetadataOptions } from '../resource/metadata.js';

export type { McpGrant } from '../resource/guard.js';

/**
 * Augmented Express Request with mcpGrant property.
 */
export interface McpAuthRequest extends IncomingMessage {
  mcpGrant?: McpGrant;
  /** Set by `express.json()`; read when `tools` enforcement is configured. */
  body?: unknown;
}

/** Options for {@link requireMcpAuth}; see `McpResourceGuardOptions`. */
export type RequireMcpAuthOptions = McpResourceGuardOptions;

type NextFunction = (err?: unknown) => void;

function headerReader(req: IncomingMessage): (name: string) => string | undefined {
  return (name) => {
    const value = req.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  };
}

/**
 * Express.js middleware that validates a Bearer token (Grantex MCP grant JWT)
 * and, when `tools` is configured, refuses any `tools/call` the grant does not
 * cover. Mount it after `express.json()` when enforcing tools.
 *
 * On success, sets `req.mcpGrant` with decoded claims.
 * On failure, responds with 401, 403 (with a `WWW-Authenticate` challenge),
 * or 503 when revocation state cannot be read.
 */
export function requireMcpAuth(
  options: RequireMcpAuthOptions,
): (req: McpAuthRequest, res: ServerResponse, next: NextFunction) => void {
  const guard = createMcpResourceGuard(options);

  return (req, res, next) => {
    guard({
      header: headerReader(req),
      method: req.method ?? 'GET',
      body: req.body,
      bodyParsed: 'body' in req,
    }).then(
      (result) => {
        if (!result.ok) {
          res.writeHead(result.status, { 'Content-Type': 'application/json', ...result.headers });
          res.end(JSON.stringify(result.body));
          return;
        }
        req.mcpGrant = result.grant;
        // Outside the guard's promise chain, so an error thrown downstream is
        // never mistaken for an authorization failure.
        next();
      },
      (err: unknown) => next(err),
    );
  };
}

/**
 * Express handler serving RFC 9728 protected-resource metadata. Mount it at
 * `protectedResourceMetadataPath(resource)`.
 */
export function protectedResourceMetadataHandler(
  options: ProtectedResourceMetadataOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const document = JSON.stringify(buildProtectedResourceMetadata(options));
  return (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' });
    res.end(document);
  };
}
