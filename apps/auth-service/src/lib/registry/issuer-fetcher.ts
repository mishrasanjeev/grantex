// SPDX-License-Identifier: Apache-2.0
/**
 * The registry's fetcher for documents an accredited issuer publishes: today
 * its Token Status Lists (draft-ietf-oauth-status-list-21), read when an
 * attestation is posted and when the registry rechecks one.
 *
 * Every fetch goes through safeFetch (lib/url-security.ts): the address is
 * resolved once and pinned, private, loopback and link-local addresses are
 * refused, redirects are never followed and the body is capped. On top of
 * that this module allows `https` only, sets its own timeout and a smaller
 * size limit, and requires the status list media type (§8.2).
 *
 * Redirects: §8.2 says a client SHOULD follow a redirect from the status
 * list URI. The registry does not. A status list URI must sit under the
 * issuer's status_list_base (owner decision 8), and a redirect could point
 * anywhere; an issuer that moves its lists changes the URI in new
 * attestations instead. A redirect is answered like any other non-200: the
 * status cannot be read, and the caller refuses with `status_stale`.
 *
 * REGISTRY_DEV_ISSUER_ORIGIN_MAP (development and tests only) rewrites an
 * issuer origin to a loopback HTTP server, for example
 * `https://mock-issuer.example=http://127.0.0.1:56901`, so the mock issuer's
 * lists can be served without a network. The URI inside the attestation and
 * the one the list's `sub` is compared with stay the https one; only the
 * connection moves. The map is refused at startup (validateConfig) unless
 * NODE_ENV is `development` or `test`, and this module refuses it again at
 * fetch time, so a map that got past startup still cannot take effect in
 * production.
 */
import { safeFetch, type OutboundUrlPolicy } from '../url-security.js';

export const REGISTRY_DEV_ISSUER_ORIGIN_MAP_ENV = 'REGISTRY_DEV_ISSUER_ORIGIN_MAP';
/** How long one fetch of an issuer document may take. */
export const ISSUER_FETCH_TIMEOUT_MS = 5_000;
/** The largest status list the registry reads (well above a 2-bit list of a million entries). */
export const MAX_ISSUER_STATUS_LIST_BYTES = 1_048_576;
/** draft-ietf-oauth-status-list-21 §8.2. */
export const STATUS_LIST_JWT_MEDIA_TYPE = 'application/statuslist+jwt';

const DEV_ENVIRONMENTS = new Set(['development', 'test']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

const PUBLIC_HTTPS: OutboundUrlPolicy = { allowedProtocols: ['https:'], allowInsecureHttp: false, allowPrivateHosts: false };
/** Only ever used for a URL the development map produced, which is loopback by construction. */
const DEV_LOOPBACK: OutboundUrlPolicy = { allowedProtocols: ['http:', 'https:'], allowInsecureHttp: true, allowPrivateHosts: true };

export type IssuerFetchReason = 'unreachable' | 'http_status' | 'content_type' | 'too_large' | 'dev_map_refused';

export class IssuerFetchError extends Error {
  readonly reason: IssuerFetchReason;

  constructor(reason: IssuerFetchReason, message: string) {
    super(message);
    this.name = 'IssuerFetchError';
    this.reason = reason;
  }
}

function mapError(message: string): Error {
  return new Error(`${REGISTRY_DEV_ISSUER_ORIGIN_MAP_ENV}: ${message}`);
}

function parseSource(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw mapError(`${value} is not a URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw mapError(`${value} must be a bare https origin, such as https://mock-issuer.example`);
  }
  return url.origin;
}

function parseTarget(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw mapError(`${value} is not a URL`);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password
      || url.search || url.hash || url.pathname !== '/') {
    throw mapError(`${value} must be a bare http origin, such as http://127.0.0.1:56901`);
  }
  // Loopback only: the map exists to reach a local fake issuer, never to
  // point the registry at another host.
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw mapError(`${value} must be a loopback address (127.0.0.1, localhost or [::1])`);
  }
  return url.origin;
}

/** The map as `https origin -> loopback origin`. Throws, naming the variable, on anything malformed. */
export function parseDevIssuerOriginMap(value: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (value === undefined || value.trim() === '') return map;
  for (const pair of value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0)) {
    const eq = pair.indexOf('=');
    if (eq <= 0 || eq !== pair.lastIndexOf('=')) throw mapError(`"${pair}" is not an origin=origin pair`);
    const source = parseSource(pair.slice(0, eq).trim());
    const target = parseTarget(pair.slice(eq + 1).trim());
    if (map.has(source)) throw mapError(`${source} is mapped twice`);
    map.set(source, target);
  }
  return map;
}

/**
 * Why the map cannot be used in this environment, or null. validateConfig
 * calls this, so a production start with the map set fails at once with this
 * message rather than silently ignoring it.
 */
export function devIssuerOriginMapConfigError(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[REGISTRY_DEV_ISSUER_ORIGIN_MAP_ENV];
  if (value === undefined || value.trim() === '') return null;
  const nodeEnv = env['NODE_ENV'];
  if (nodeEnv === 'production') {
    return `${REGISTRY_DEV_ISSUER_ORIGIN_MAP_ENV} must not be set in production: it redirects issuer fetches to local servers`;
  }
  if (nodeEnv === undefined || !DEV_ENVIRONMENTS.has(nodeEnv)) {
    return `${REGISTRY_DEV_ISSUER_ORIGIN_MAP_ENV} is for development and tests only: set NODE_ENV=development or NODE_ENV=test, or unset it`;
  }
  try {
    parseDevIssuerOriginMap(value);
  } catch (err) {
    return (err as Error).message;
  }
  return null;
}

/**
 * The URL to connect to for `url`: rewritten when its origin is in the
 * development map. Throws IssuerFetchError when a map is set where it is not
 * allowed; the fetch then fails and the caller refuses, never falls back.
 */
export function rewriteIssuerUrl(url: string, env: NodeJS.ProcessEnv = process.env): { url: string; rewritten: boolean } {
  const value = env[REGISTRY_DEV_ISSUER_ORIGIN_MAP_ENV];
  if (value === undefined || value.trim() === '') return { url, rewritten: false };
  const problem = devIssuerOriginMapConfigError(env);
  if (problem !== null) throw new IssuerFetchError('dev_map_refused', problem);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, rewritten: false };
  }
  const target = parseDevIssuerOriginMap(value).get(parsed.origin);
  if (target === undefined) return { url, rewritten: false };
  return { url: `${target}${parsed.pathname}${parsed.search}`, rewritten: true };
}

export interface IssuerFetchOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * GET an issuer's Token Status List from `uri` and return the token text.
 * Throws IssuerFetchError for anything but a 200 with the status list media
 * type and a body within the limit.
 */
export async function fetchIssuerStatusList(uri: string, options: IssuerFetchOptions = {}): Promise<string> {
  const target = rewriteIssuerUrl(uri, options.env ?? process.env);
  const maxBytes = options.maxBytes ?? MAX_ISSUER_STATUS_LIST_BYTES;
  let response: Response;
  try {
    response = await safeFetch(
      target.url,
      {
        method: 'GET',
        headers: { accept: STATUS_LIST_JWT_MEDIA_TYPE },
        signal: AbortSignal.timeout(options.timeoutMs ?? ISSUER_FETCH_TIMEOUT_MS),
      },
      target.rewritten ? DEV_LOOPBACK : PUBLIC_HTTPS,
    );
  } catch (err) {
    // Every transport failure (policy refusal, DNS, TLS, timeout, reset) is
    // one answer: the list could not be read. It is reported, not swallowed:
    // the caller turns it into a refusal.
    throw new IssuerFetchError('unreachable', `status list could not be fetched: ${(err as Error).message}`);
  }
  if (response.status !== 200) {
    throw new IssuerFetchError('http_status', `status list answered HTTP ${response.status}`);
  }
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (contentType !== STATUS_LIST_JWT_MEDIA_TYPE) {
    throw new IssuerFetchError('content_type', `status list was served as ${contentType || 'no media type'}, not ${STATUS_LIST_JWT_MEDIA_TYPE}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > maxBytes) {
    throw new IssuerFetchError('too_large', `status list is larger than ${maxBytes} bytes`);
  }
  return body.toString('utf8').trim();
}
