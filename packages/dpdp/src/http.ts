/**
 * Internal HTTP and decoding helpers shared by the API functions.
 *
 * DPDP calls are sent once by default: creating a record, notice, grievance or
 * export, withdrawing consent and updating a grievance are not idempotent, so a
 * retry after a timeout could create a duplicate or fail with a spurious 409.
 * Erasure is idempotent on the server (a replay returns the earlier request),
 * so it opts in to a bounded retry on network errors and 429/502/503/504.
 */

import type { DpdpErrorDetails } from './errors.js';

/** Total attempts for a request that opts in to retries. */
export const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 10_000;
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

function retryDelayMs(retry: number): number {
  const exponential = RETRY_BASE_DELAY_MS * 2 ** retry;
  return Math.min(exponential + Math.random() * RETRY_BASE_DELAY_MS, RETRY_MAX_DELAY_MS);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A failed call: HTTP status plus whatever the `{message, code, requestId}` body carried. */
export interface HttpFailure extends DpdpErrorDetails {
  statusCode: number;
  /** The server's message, when the body had one. */
  message?: string;
}

export interface HttpResult {
  status: number;
  data: unknown;
}

/** Build `${baseUrl}/v1/dpdp/...` with every path segment percent-encoded. */
export function dpdpUrl(
  baseUrl: string,
  segments: ReadonlyArray<string | { raw: string }>,
  query?: Record<string, string | number | undefined>,
): string {
  const path = segments
    .map((s) => (typeof s === 'string' ? encodeURIComponent(s) : s.raw))
    .join('/');
  const qs = Object.entries(query ?? {})
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return `${baseUrl}/v1/dpdp/${path}${qs ? `?${qs}` : ''}`;
}

/** A literal path segment that must not be encoded (route names such as `consent-records`). */
export const seg = (raw: string): { raw: string } => ({ raw });

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/**
 * Perform a request. Resolves with the status and parsed JSON body on 2xx;
 * otherwise throws the error built by `onError` from the server's error body.
 *
 * Sent once unless `retry` is true, which only idempotent calls may set: then a
 * network error or a 429/502/503/504 is retried with backoff, up to
 * `RETRY_MAX_ATTEMPTS` attempts in total.
 */
export async function dpdpRequest(
  init: { method: 'GET' | 'POST' | 'PATCH'; url: string; apiKey: string; body?: unknown; retry?: boolean },
  onError: (failure: HttpFailure) => Error,
): Promise<HttpResult> {
  const headers: Record<string, string> = { Authorization: `Bearer ${init.apiKey}` };
  const requestInit: RequestInit = { method: init.method, headers };
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    requestInit.body = JSON.stringify(init.body);
  }

  const maxAttempts = init.retry === true ? RETRY_MAX_ATTEMPTS : 1;
  let res: Response | undefined;
  for (let attempt = 1; ; attempt++) {
    const last = attempt >= maxAttempts;
    try {
      res = await fetch(init.url, requestInit);
    } catch (err) {
      if (last) throw err;
      await sleep(retryDelayMs(attempt - 1));
      continue;
    }
    if (!res.ok && RETRYABLE_STATUS_CODES.has(res.status) && !last) {
      await res.body?.cancel().catch(() => undefined);
      await sleep(retryDelayMs(attempt - 1));
      continue;
    }
    break;
  }

  if (!res.ok) {
    const body = await readJson(res);
    const failure: HttpFailure = { statusCode: res.status };
    if (body !== null && typeof body === 'object') {
      const b = body as Record<string, unknown>;
      if (typeof b.message === 'string') failure.message = b.message;
      if (typeof b.code === 'string') failure.code = b.code;
      if (typeof b.requestId === 'string') failure.requestId = b.requestId;
    }
    throw onError(failure);
  }

  return { status: res.status, data: await readJson(res) };
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

export type Raw = Record<string, unknown>;

export function asObject(value: unknown): Raw {
  return value !== null && typeof value === 'object' ? (value as Raw) : {};
}

/** A Date for an ISO string, or undefined for null, absent or unparseable values (never an Invalid Date). */
export function toDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Spread helper: `{ [key]: value }` when value is not null/undefined, else `{}`. */
export function opt<K extends string, V>(key: K, value: V | null | undefined): { [P in K]?: V } {
  return (value === null || value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export function nextCursorOf(raw: Raw): string | null {
  return typeof raw.nextCursor === 'string' ? raw.nextCursor : null;
}
