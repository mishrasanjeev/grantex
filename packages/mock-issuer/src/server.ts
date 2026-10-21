// SPDX-License-Identifier: Apache-2.0
//
// Server mode: the issuer's JWKS and passport status lists over plain HTTP
// on 127.0.0.1 only, for the registry's development-and-test origin map
// (REGISTRY_DEV_ISSUER_ORIGIN_MAP=https://mock-issuer.example=http://127.0.0.1:<port>).
// URIs inside passports and attestations stay https://mock-issuer.example/...
//
//   GET /.well-known/jwks.json            application/jwk-set+json (RFC 7517 section 8.5.1)
//   GET /status/<n>                       application/statuslist+jwt (draft-ietf-oauth-status-list-21 section 8.1)
//   GET /status/<n>/bitstring             application/vc+jwt (W3C VC-JOSE-COSE section 6.1.1), statusPurpose revocation
//   GET /status/<n>/bitstring/suspension  the same, statusPurpose suspension

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MockIssuerError } from './errors.ts';
import type { MockIssuer } from './issuer.ts';

export const JWK_SET_MEDIA_TYPE = 'application/jwk-set+json';
export const TOKEN_STATUS_LIST_MEDIA_TYPE = 'application/statuslist+jwt';
export const VC_JWT_MEDIA_TYPE = 'application/vc+jwt';
/** The only address the server binds: it is never reachable from another host. */
export const LOOPBACK_HOST = '127.0.0.1';
/** Per-client ceiling, requests a minute. */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 600;

export interface MockIssuerServerOptions {
  issuer: MockIssuer;
  /** 0 (the default) picks a free port. */
  port?: number;
  /** Only 127.0.0.1 is accepted. */
  host?: typeof LOOPBACK_HOST;
  rateLimitPerMinute?: number;
}

export interface MockIssuerServer {
  host: typeof LOOPBACK_HOST;
  port: number;
  /** http://127.0.0.1:<port> */
  origin: string;
  /** https://mock-issuer.example=http://127.0.0.1:<port>, one REGISTRY_DEV_ISSUER_ORIGIN_MAP pair. */
  originMapEntry: string;
  close(): Promise<void>;
}

const STATUS_PATH = /^\/status\/([1-9][0-9]{0,8})(\/bitstring(\/suspension)?)?$/;

function send(res: ServerResponse, status: number, type: string, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body), ...headers });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

function sendError(res: ServerResponse, status: number, code: string, message: string, headers: Record<string, string> = {}): void {
  send(res, status, 'application/json', JSON.stringify({ code, message }), headers);
}

export async function startMockIssuerServer(options: MockIssuerServerOptions): Promise<MockIssuerServer> {
  const host = options.host ?? LOOPBACK_HOST;
  if (host !== LOOPBACK_HOST) {
    throw new MockIssuerError('invalid_request', `the mock issuer binds ${LOOPBACK_HOST} only, not ${String(host)}`);
  }
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new MockIssuerError('invalid_request', 'port must be 0-65535');
  const limit = options.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
  if (!Number.isInteger(limit) || limit < 1) throw new MockIssuerError('invalid_request', 'rateLimitPerMinute must be positive');
  const { issuer } = options;
  const windows = new Map<string, { start: number; count: number }>();

  // A fixed one-minute window per client address.
  const limited = (req: IncomingMessage): boolean => {
    const client = req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const window = windows.get(client);
    if (window === undefined || now - window.start >= 60_000) {
      windows.set(client, { start: now, count: 1 });
      return false;
    }
    window.count += 1;
    return window.count > limit;
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    if (limited(req)) {
      sendError(res, 429, 'RATE_LIMITED', 'too many requests', { 'retry-after': '60' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'GET only', { allow: 'GET, HEAD' });
      return;
    }
    const path = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`).pathname;
    // draft-ietf-oauth-status-list-21 section 8.1: public, readable from any origin.
    const common = { 'access-control-allow-origin': '*' };
    if (path === '/.well-known/jwks.json') {
      send(res, 200, JWK_SET_MEDIA_TYPE, JSON.stringify(issuer.jwks()), { ...common, 'cache-control': 'no-cache' });
      return;
    }
    const match = STATUS_PATH.exec(path);
    const list = match === null ? NaN : Number(match[1]);
    if (match === null || !issuer.hasStatusList(list)) {
      sendError(res, 404, 'NOT_FOUND', 'not found');
      return;
    }
    // Cache-Control follows the ttl the list states (Bitstring Status List section 2.2).
    const headers = { ...common, 'cache-control': `public, max-age=${issuer.ttlSeconds}` };
    if (match[2] === undefined) {
      send(res, 200, TOKEN_STATUS_LIST_MEDIA_TYPE, issuer.tokenStatusList(list), headers);
    } else {
      const purpose = match[3] === undefined ? 'revocation' : 'suspension';
      send(res, 200, VC_JWT_MEDIA_TYPE, issuer.bitstringStatusListCredential(list, purpose), headers);
    }
  };

  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch (error) {
      // Fail closed: a list the issuer cannot build (unreadable state) is a
      // 503, never an empty list that would read as "nothing revoked".
      const code = error instanceof MockIssuerError ? error.code : 'internal_error';
      if (!res.headersSent) sendError(res, 503, code, 'status unavailable');
      else res.destroy();
      process.emitWarning(`mock issuer: ${code}: ${(error as Error).message}`);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, LOOPBACK_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const bound = (server.address() as AddressInfo).port;
  const origin = `http://${LOOPBACK_HOST}:${bound}`;
  return {
    host: LOOPBACK_HOST,
    port: bound,
    origin,
    originMapEntry: `${issuer.entityId}=${origin}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
