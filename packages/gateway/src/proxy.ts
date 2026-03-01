import type { VerifiedGrant } from '@grantex/sdk';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { GatewayError } from './errors.js';

export interface ProxyOptions {
  upstream: string;
  upstreamHeaders?: Record<string, string>;
  timeout?: number;
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

  // Forward original headers (except Authorization and Host)
  const rawHeaders = req.headers;
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (key.toLowerCase() === 'authorization') continue;
    if (key.toLowerCase() === 'host') continue;
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

  // Add Grantex context headers
  headers['X-Grantex-Principal'] = grant.principalId;
  headers['X-Grantex-Agent'] = grant.agentDid;
  headers['X-Grantex-GrantId'] = grant.grantId;

  const controller = new AbortController();
  const timeout = options.timeout ?? 30_000;
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const body = req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined;

    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    // Forward status code
    reply.status(response.status);

    // Forward response headers
    for (const [key, value] of response.headers.entries()) {
      if (key.toLowerCase() === 'transfer-encoding') continue;
      reply.header(key, value);
    }

    // Forward response body
    const responseBody = await response.text();
    reply.send(responseBody);
  } catch (err) {
    if (err instanceof GatewayError) throw err;
    throw new GatewayError(
      'UPSTREAM_ERROR',
      `Failed to reach upstream: ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
