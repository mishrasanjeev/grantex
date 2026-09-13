import type { HttpResponse } from './types.js';

const USER_AGENT = '@grantex/conformance/0.1.3';

/** Upper bound on how long a single 429 retry will wait. */
export const MAX_RETRY_DELAY_SEC = 60;
/** Wait used when neither the Retry-After header nor the body says anything usable. */
export const DEFAULT_RETRY_DELAY_SEC = 10;

const UNIT_SECONDS: Record<string, number> = {
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
  m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
};

/**
 * Determines how many seconds to wait before retrying a 429 response.
 *
 * Order of preference:
 *  1. `Retry-After` header (delta-seconds or HTTP-date, per RFC 9110).
 *  2. A "retry in N <unit>" phrase in the body — @fastify/rate-limit's default
 *     message is "Rate limit exceeded, retry in 1 minute", so the unit must be
 *     honoured (a bare `(\d+)` match used to read that as 1 second).
 *  3. DEFAULT_RETRY_DELAY_SEC.
 *
 * The result is always clamped to [0, MAX_RETRY_DELAY_SEC].
 */
export function parseRetryDelaySeconds(
  headers: { get(name: string): string | null } | Record<string, string | undefined>,
  bodyText: string,
  now: number = Date.now(),
): number {
  const clamp = (sec: number): number => Math.min(Math.max(Math.ceil(sec), 0), MAX_RETRY_DELAY_SEC);

  const retryAfter = typeof (headers as { get?: unknown }).get === 'function'
    ? (headers as { get(name: string): string | null }).get('retry-after')
    : ((headers as Record<string, string | undefined>)['retry-after']
      ?? (headers as Record<string, string | undefined>)['Retry-After']);

  if (retryAfter && retryAfter.trim().length > 0) {
    const value = retryAfter.trim();
    if (/^\d+$/.test(value)) {
      return clamp(parseInt(value, 10));
    }
    const dateMs = Date.parse(value);
    if (!Number.isNaN(dateMs)) {
      return clamp((dateMs - now) / 1000);
    }
  }

  const match = bodyText.match(/retry in (\d+)\s*([a-z]*)/i);
  if (match) {
    const amount = parseInt(match[1]!, 10);
    const unit = (match[2] ?? '').toLowerCase();
    const multiplier = unit === '' ? 1 : UNIT_SECONDS[unit];
    if (multiplier !== undefined) {
      return clamp(amount * multiplier);
    }
  }

  return DEFAULT_RETRY_DELAY_SEC;
}

export class ConformanceHttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<HttpResponse<T>> {
    return this.doRequest<T>(method, path, body, {
      Authorization: `Bearer ${this.apiKey}`,
      ...headers,
    });
  }

  async requestPublic<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<HttpResponse<T>> {
    return this.doRequest<T>(method, path, body, {});
  }

  async get<T = unknown>(path: string): Promise<HttpResponse<T>> {
    return this.request<T>('GET', path);
  }

  async post<T = unknown>(
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<HttpResponse<T>> {
    return this.request<T>('POST', path, body, headers);
  }

  async patch<T = unknown>(path: string, body?: unknown): Promise<HttpResponse<T>> {
    return this.request<T>('PATCH', path, body);
  }

  async delete(path: string): Promise<HttpResponse> {
    return this.request('DELETE', path);
  }

  async doRequestWithToken<T = unknown>(
    method: string,
    path: string,
    token: string,
    body?: unknown,
  ): Promise<HttpResponse<T>> {
    return this.doRequest<T>(method, path, body, {
      Authorization: `Bearer ${token}`,
    });
  }

  private async doRequest<T = unknown>(
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<HttpResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const reqHeaders: Record<string, string> = {
      'User-Agent': USER_AGENT,
      ...headers,
    };

    if (body !== undefined) {
      reqHeaders['Content-Type'] = 'application/json';
    }

    const init: RequestInit = {
      method,
      headers: reqHeaders,
    };

    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    const start = Date.now();
    let res = await fetch(url, init);

    // Retry once on 429 (rate limited). Prefer the Retry-After header; fall back to
    // parsing the body, honouring the unit ("retry in 1 minute" is 60s, not 1s).
    if (res.status === 429) {
      const waitSec = parseRetryDelaySeconds(res.headers, await res.text());
      await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
      res = await fetch(url, init);
    }

    const durationMs = Date.now() - start;

    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const rawText = await res.text();
    let parsed: T;
    try {
      parsed = JSON.parse(rawText) as T;
    } catch {
      parsed = rawText as T;
    }

    return { status: res.status, headers: responseHeaders, body: parsed, rawText, durationMs };
  }
}
