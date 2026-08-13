import type { VerifiedGrant } from '@grantex/sdk';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { GatewayError } from './errors.js';

export interface ProxyOptions {
  upstream: string;
  upstreamHeaders?: Record<string, string>;
  timeout?: number;
}

/**
 * Headers that describe *this* hop and must not be relayed to the next one
 * (RFC 9110 §7.6.1), plus the two the gateway replaces itself.
 *
 * `content-encoding` is deliberately *not* here: the body is relayed byte for
 * byte, so an inbound `gzip` still describes it accurately and the upstream
 * needs it to decode.
 *
 * `content-length` is dropped so fetch derives it from the body it actually
 * sends. A forwarded length can disagree with reality — a caller passing an
 * already-parsed object gets re-serialized here — and a stale one makes the
 * upstream read a truncated body or block waiting for bytes that never arrive.
 */
const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  'authorization',
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'expect',
]);

/**
 * `fetch` transparently decodes the upstream body, so the response reaching the
 * client is neither the declared length nor the declared encoding. Relaying
 * either one leaves the client trying to gunzip plain text.
 */
const SUPPRESSED_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'trailer',
  'upgrade',
]);

/**
 * Hand the upstream exactly what the client sent.
 *
 * The gateway parses every content type as a buffer, so the normal path here is
 * the passthrough: relay those bytes untouched. Decoding them to a string first
 * would corrupt any non-UTF-8 payload, and `JSON.stringify` would wrap a
 * form-encoded body in quotes, turning `a=1&b=2` into `"a=1&b=2"`.
 *
 * Strings and plain objects are still handled so a caller that supplies an
 * already-parsed body — as the tests do — behaves sensibly.
 */
function serializeBody(body: unknown): string | Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return body;
  return JSON.stringify(body);
}

export async function proxyRequest(
  req: FastifyRequest,
  reply: FastifyReply,
  grant: VerifiedGrant,
  options: ProxyOptions,
): Promise<void> {
  const targetUrl = `${options.upstream.replace(/\/$/, '')}${req.url}`;

  // Build headers: strip Authorization, add upstream headers + Grantex context
  const headers: Record<string, string> = {};

  // Forward original headers, minus this hop's own
  const rawHeaders = req.headers;
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (HOP_BY_HOP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    if (value !== undefined) {
      headers[key] = Array.isArray(value) ? value.join(', ') : value;
    }
  }

  // Add configured upstream headers
  if (options.upstreamHeaders) {
    for (const [key, value] of Object.entries(options.upstreamHeaders)) {
      headers[key] = value;
    }
  }

  // Add Grantex context headers last so a client cannot spoof them
  headers['X-Grantex-Principal'] = grant.principalId;
  headers['X-Grantex-Agent'] = grant.agentDid;
  headers['X-Grantex-GrantId'] = grant.grantId;

  const controller = new AbortController();
  const timeout = options.timeout ?? 30_000;
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const body = req.method !== 'GET' && req.method !== 'HEAD'
      ? serializeBody(req.body)
      : undefined;

    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
      signal: controller.signal,
    });

    // Forward status code
    reply.status(response.status);

    // Forward response headers
    for (const [key, value] of response.headers.entries()) {
      if (SUPPRESSED_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
      reply.header(key, value);
    }

    // Forward response body
    const responseBody = await response.text();
    reply.send(responseBody);
  } catch (err) {
    if (err instanceof GatewayError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new GatewayError(
        'UPSTREAM_TIMEOUT',
        `Upstream did not respond within ${timeout}ms`,
        504,
      );
    }
    throw new GatewayError(
      'UPSTREAM_ERROR',
      `Failed to reach upstream: ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
