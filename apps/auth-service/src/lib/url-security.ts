import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

export interface OutboundUrlPolicy {
  allowedProtocols: readonly string[];
  allowInsecureHttp?: boolean;
  allowPrivateHosts?: boolean;
}

export interface ResolvedOutboundAddress {
  address: string;
  family: 4 | 6;
}

export type OutboundDnsResolver = (hostname: string) => Promise<ResolvedOutboundAddress[]>;

export interface PinnedOutboundTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

export interface SafeConnectOptions {
  policy: OutboundUrlPolicy;
  port?: number;
  tls?: boolean;
  timeoutMs?: number;
  rejectUnauthorized?: boolean;
  resolver?: OutboundDnsResolver;
}

type SafeFetchOverride = (
  value: string,
  init: RequestInit,
  policy: OutboundUrlPolicy,
  resolver?: OutboundDnsResolver,
) => Promise<Response>;
type SafeHeadersInit = RequestInit['headers'];
type SafeRequestBody = RequestInit['body'];

const LOCAL_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  '0.0.0.0',
]);

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_OUTBOUND_RESPONSE_BYTES = 2 * 1024 * 1024;
let safeFetchOverride: SafeFetchOverride | null = null;

export function setSafeFetchForTests(override: SafeFetchOverride | null): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('safeFetch test override is only available in test');
  }
  safeFetchOverride = override;
}

function parseIpv4(hostname: string): number[] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN;
    return Number(part);
  });
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return octets;
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = parseIpv4(hostname);
  if (!octets) return false;
  const a = octets[0]!;
  const b = octets[1]!;
  return a === 10
    || a === 127
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127)
    || a === 0;
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    const dotted = parseIpv4(mapped);
    if (dotted) return isPrivateIpv4(mapped);

    const words = mapped.split(':').map((part) => parseInt(part, 16));
    if (words.length === 2 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)) {
      const ipv4 = [
        words[0]! >> 8,
        words[0]! & 0xff,
        words[1]! >> 8,
        words[1]! & 0xff,
      ].join('.');
      return isPrivateIpv4(ipv4);
    }
  }
  // Link-local is fe80::/10 — first 10 bits 1111111010, i.e. first 16-bit
  // group ranges 0xfe80–0xfebf. Matching only "fe80:" missed fe81:..febf:
  // (e.g. fe90::1), leaving an SSRF path to link-local targets.
  return normalized === '::1'
    || normalized.startsWith('fc')        // fc00::/7 unique-local (low half)
    || normalized.startsWith('fd')        // fc00::/7 unique-local (high half)
    || /^fe[89ab][0-9a-f]:/.test(normalized)  // fe80::/10 link-local
    || normalized === '::';
}

export function isBlockedPrivateHost(hostname: string): boolean {
  // Strip surrounding [] (IPv6 literals) and any trailing dots before
  // comparing — a trailing dot makes a hostname an absolute FQDN that DNS
  // resolves identically (e.g. "localhost." === "localhost"), so without
  // stripping it the loopback/private guards can be bypassed.
  const normalized = hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
  if (LOCAL_HOSTNAMES.has(normalized) || normalized.endsWith('.localhost')) return true;
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) return isPrivateIpv4(normalized);
  if (ipVersion === 6) return isPrivateIpv6(normalized);
  return false;
}

/**
 * Validate an outbound URL string against the supplied policy.
 */
export function validateOutboundUrl(value: string, policy: OutboundUrlPolicy): URL {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new Error('URL is required and must be 2048 characters or fewer');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('URL must be absolute and valid');
  }

  if (parsed.username || parsed.password) {
    throw new Error('URL must not contain embedded credentials');
  }

  if (!parsed.hostname) {
    // URLs like "ldap:///dc=example" parse cleanly with an empty hostname,
    // and downstream callers (LDAP socket open, fetch) end up with ambiguous
    // or default-target behavior instead of a deterministic rejection.
    throw new Error('URL must include a hostname');
  }

  if (!policy.allowedProtocols.includes(parsed.protocol)) {
    throw new Error(`URL protocol must be one of: ${policy.allowedProtocols.join(', ')}`);
  }

  if (parsed.protocol === 'http:' && !policy.allowInsecureHttp) {
    throw new Error('HTTP URLs are disabled; use HTTPS');
  }

  if (!policy.allowPrivateHosts && isBlockedPrivateHost(parsed.hostname)) {
    throw new Error('Private, loopback, and link-local hosts are not allowed');
  }

  return parsed;
}

async function defaultResolver(hostname: string): Promise<ResolvedOutboundAddress[]> {
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results
    .filter((entry): entry is ResolvedOutboundAddress => entry.family === 4 || entry.family === 6)
    .map((entry) => ({ address: entry.address, family: entry.family }));
}

export async function resolvePinnedOutboundTarget(
  value: string,
  policy: OutboundUrlPolicy,
  resolver: OutboundDnsResolver = defaultResolver,
): Promise<PinnedOutboundTarget> {
  const url = validateOutboundUrl(value, policy);
  const addresses = await resolver(url.hostname);
  if (addresses.length === 0) {
    throw new Error('URL hostname could not be resolved');
  }

  if (!policy.allowPrivateHosts) {
    const blocked = addresses.find((entry) => isBlockedPrivateHost(entry.address));
    if (blocked) {
      throw new Error('Resolved private, loopback, and link-local addresses are not allowed');
    }
  }

  const first = addresses[0]!;
  return { url, address: first.address, family: first.family };
}

function createPinnedLookup(target: PinnedOutboundTarget) {
  return (_hostname: string, options: unknown, callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void): void => {
    // Newer Node HTTP agents request lookup({ all: true }) and expect the
    // array callback overload. Returning the legacy single-address shape in
    // that mode produces `Invalid IP address: undefined` before connect.
    if (typeof options === 'object' && options !== null && (options as { all?: boolean }).all) {
      const allCallback = callback as unknown as (
        err: NodeJS.ErrnoException | null,
        addresses: ResolvedOutboundAddress[],
      ) => void;
      allCallback(null, [{ address: target.address, family: target.family }]);
      return;
    }
    callback(null, target.address, target.family);
  };
}

function normalizeHeaders(headers: SafeHeadersInit | undefined): Record<string, string> {
  const normalized = new Headers(headers);
  if (normalized.has('host')) {
    throw new Error('Host header override is not allowed for pinned outbound requests');
  }

  const result: Record<string, string> = {};
  normalized.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function normalizeRequestBody(body: SafeRequestBody | null | undefined): string | Buffer | Uint8Array | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new Error('Unsupported safeFetch request body type');
}

function responseHeaders(headers: http.IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(key, item);
    } else if (value !== undefined) {
      result.set(key, value);
    }
  }
  return result;
}

export async function safeFetch(
  value: string,
  init: RequestInit,
  policy: OutboundUrlPolicy,
  resolver?: OutboundDnsResolver,
): Promise<Response> {
  if (safeFetchOverride) {
    return safeFetchOverride(value, init, policy, resolver);
  }

  const target = await resolvePinnedOutboundTarget(value, policy, resolver);
  if (target.url.protocol !== 'http:' && target.url.protocol !== 'https:') {
    throw new Error('safeFetch supports only HTTP and HTTPS URLs');
  }

  const body = normalizeRequestBody(init.body);
  const headers = normalizeHeaders(init.headers);
  const requestImpl = target.url.protocol === 'https:' ? https.request : http.request;
  const lookup = createPinnedLookup(target);

  return await new Promise<Response>((resolve, reject) => {
    if (init.signal?.aborted) {
      reject(new Error('Outbound request aborted'));
      return;
    }

    const request = requestImpl({
      protocol: target.url.protocol,
      hostname: target.url.hostname,
      port: target.url.port || undefined,
      path: `${target.url.pathname}${target.url.search}`,
      method: init.method ?? 'GET',
      headers,
      lookup,
      servername: target.url.protocol === 'https:' ? target.url.hostname : undefined,
      timeout: DEFAULT_REQUEST_TIMEOUT_MS,
    }, (res) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let settled = false;

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        res.destroy();
        reject(error);
      };

      const contentLength = res.headers['content-length'];
      if (typeof contentLength === 'string' && /^\d+$/.test(contentLength)) {
        const declaredBytes = Number(contentLength);
        if (!Number.isSafeInteger(declaredBytes) || declaredBytes > MAX_OUTBOUND_RESPONSE_BYTES) {
          fail(new Error(`Outbound response exceeds ${MAX_OUTBOUND_RESPONSE_BYTES} byte limit`));
          return;
        }
      }

      res.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.length;
        if (totalBytes > MAX_OUTBOUND_RESPONSE_BYTES) {
          fail(new Error(`Outbound response exceeds ${MAX_OUTBOUND_RESPONSE_BYTES} byte limit`));
          return;
        }
        chunks.push(buffer);
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(new Response(Buffer.concat(chunks), {
          status: res.statusCode ?? 502,
          statusText: res.statusMessage ?? '',
          headers: responseHeaders(res.headers),
        }));
      });
      res.on('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    });

    const abort = (): void => {
      request.destroy(new Error('Outbound request aborted'));
    };
    init.signal?.addEventListener('abort', abort, { once: true });
    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy(new Error('Outbound request timeout'));
    });
    request.on('close', () => {
      init.signal?.removeEventListener('abort', abort);
    });
    if (body !== undefined) request.write(body);
    request.end();
  });
}

export async function safeConnect(
  value: string,
  options: SafeConnectOptions,
): Promise<net.Socket> {
  const target = await resolvePinnedOutboundTarget(value, options.policy, options.resolver);
  const port = options.port ?? parseInt(target.url.port || (options.tls ? '443' : '80'), 10);
  const lookup = createPinnedLookup(target);
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return await new Promise<net.Socket>((resolve, reject) => {
    const socket = options.tls
      ? tls.connect({
          host: target.url.hostname,
          port,
          servername: target.url.hostname,
          rejectUnauthorized: options.rejectUnauthorized,
          lookup,
        }, () => resolve(socket as unknown as net.Socket))
      : net.createConnection({
          host: target.url.hostname,
          port,
          lookup,
        }, () => resolve(socket));

    socket.on('error', reject);
    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('Connection timeout'));
    });
  });
}

export function assertValidRedirectUri(value: string): void {
  validateOutboundUrl(value, {
    allowedProtocols: ['https:', 'http:'],
    allowInsecureHttp: process.env.NODE_ENV !== 'production',
    allowPrivateHosts: process.env.NODE_ENV !== 'production',
  });
}
