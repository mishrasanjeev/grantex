/**
 * Internal HTTP and decoding helpers shared by the API functions.
 *
 * DPDP calls are never retried: creating a record, notice, grievance or export
 * and withdrawing consent are not idempotent, so a retry after a timeout could
 * create a duplicate or fail with a spurious 409.
 */

import type { DpdpErrorDetails } from './errors.js';

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
 * Perform one request. Resolves with the status and parsed JSON body on 2xx;
 * otherwise throws the error built by `onError` from the server's error body.
 */
export async function dpdpRequest(
  init: { method: 'GET' | 'POST' | 'PATCH'; url: string; apiKey: string; body?: unknown },
  onError: (failure: HttpFailure) => Error,
): Promise<HttpResult> {
  const headers: Record<string, string> = { Authorization: `Bearer ${init.apiKey}` };
  const requestInit: RequestInit = { method: init.method, headers };
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    requestInit.body = JSON.stringify(init.body);
  }

  const res = await fetch(init.url, requestInit);

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
