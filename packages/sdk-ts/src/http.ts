import { GrantexApiError, GrantexAuthError, GrantexNetworkError } from './errors.js';
import type { RateLimit } from './types.js';

const SDK_VERSION = '0.1.0';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 10_000;
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

function parseRateLimitHeaders(headers: Headers): RateLimit | undefined {
  const limit = headers.get('x-ratelimit-limit');
  const remaining = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');

  if (limit === null || remaining === null || reset === null) {
    return undefined;
  }

  const retryAfterRaw = headers.get('retry-after');
  return {
    limit: Number(limit),
    remaining: Number(remaining),
    reset: Number(reset),
    ...(retryAfterRaw !== null ? { retryAfter: Number(retryAfterRaw) } : {}),
  };
}

export interface HttpClientOptions {
  baseUrl: string;
  apiKey: string;
  timeout?: number;
  maxRetries?: number;
}

export class HttpClient {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #timeout: number;
  readonly #maxRetries: number;
  #lastRateLimit: RateLimit | undefined;

  constructor(options: HttpClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, '');
    this.#apiKey = options.apiKey;
    this.#timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  get lastRateLimit(): RateLimit | undefined {
    return this.#lastRateLimit;
  }

  async get<T>(path: string): Promise<T> {
    return this.#request<T>('GET', path, undefined);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.#request<T>('POST', path, body);
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    return this.#request<T>('PUT', path, body);
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.#request<T>('PATCH', path, body);
  }

  async delete<T>(path: string): Promise<T> {
    return this.#request<T>('DELETE', path, undefined);
  }

  async rawGet(path: string): Promise<Response> {
    const url = `${this.#baseUrl}${path}`;
    return fetch(url, {
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
      },
    });
  }

  async #request<T>(method: string, path: string, body: unknown): Promise<T> {
    const url = `${this.#baseUrl}${path}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      'User-Agent': `@grantex/sdk/${SDK_VERSION}`,
      Accept: 'application/json',
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let lastError: unknown;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      if (attempt > 0) {
        await this.#sleep(this.#retryDelay(attempt - 1));
      }

      const controller = new AbortController();
      const timerId = setTimeout(() => controller.abort(), this.#timeout);

      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timerId);
        const isTimeout =
          err instanceof Error && err.name === 'AbortError';
        lastError = new GrantexNetworkError(
          isTimeout
            ? `Request timed out after ${this.#timeout}ms`
            : `Network error: ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
        // Network errors are retryable
        if (attempt < this.#maxRetries) {
          continue;
        }
        throw lastError;
      } finally {
        clearTimeout(timerId);
      }

      const requestId = response.headers.get('x-request-id') ?? undefined;
      this.#lastRateLimit = parseRateLimitHeaders(response.headers);

      if (!response.ok) {
        let responseBody: unknown;
        try {
          responseBody = await response.json();
        } catch {
          responseBody = await response.text().catch(() => null);
        }

        // Retry on transient status codes
        if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < this.#maxRetries) {
          const retryAfter = this.#parseRetryAfter(response.headers);
          if (retryAfter !== undefined) {
            this.#pendingRetryAfterMs = retryAfter;
          }
          continue;
        }

        const message = extractErrorMessage(responseBody, response.status);
        const errorCode = extractErrorCode(responseBody);

        if (response.status === 401 || response.status === 403) {
          throw new GrantexAuthError(
            message,
            response.status as 401 | 403,
            responseBody,
            requestId,
            errorCode,
            this.#lastRateLimit,
          );
        }

        throw new GrantexApiError(message, response.status, responseBody, requestId, errorCode, this.#lastRateLimit);
      }

      if (response.status === 204) {
        return undefined as T;
      }

      return response.json() as Promise<T>;
    }

    // Should not reach here, but satisfy TypeScript
    throw lastError;
  }

  #pendingRetryAfterMs: number | undefined;

  #retryDelay(attempt: number): number {
    // If a Retry-After header was parsed, use it
    if (this.#pendingRetryAfterMs !== undefined) {
      const delay = this.#pendingRetryAfterMs;
      this.#pendingRetryAfterMs = undefined;
      return Math.min(delay, RETRY_MAX_DELAY_MS);
    }
    // Exponential backoff with jitter
    const exponential = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
    const jitter = Math.random() * RETRY_BASE_DELAY_MS;
    return Math.min(exponential + jitter, RETRY_MAX_DELAY_MS);
  }

  #parseRetryAfter(headers: Headers): number | undefined {
    const value = headers.get('retry-after');
    if (value === null) return undefined;
    const seconds = Number(value);
    if (!Number.isNaN(seconds)) return seconds * 1000;
    // Try parsing as HTTP-date
    const date = Date.parse(value);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
    return undefined;
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function extractErrorCode(body: unknown): string | undefined {
  if (
    body !== null &&
    typeof body === 'object' &&
    'code' in body &&
    typeof (body as Record<string, unknown>)['code'] === 'string'
  ) {
    return (body as Record<string, string>)['code']!;
  }
  return undefined;
}

function extractErrorMessage(body: unknown, status: number): string {
  if (
    body !== null &&
    typeof body === 'object' &&
    'message' in body &&
    typeof (body as Record<string, unknown>)['message'] === 'string'
  ) {
    return (body as Record<string, string>)['message']!;
  }
  if (
    body !== null &&
    typeof body === 'object' &&
    'error' in body &&
    typeof (body as Record<string, unknown>)['error'] === 'string'
  ) {
    return (body as Record<string, string>)['error']!;
  }
  return `HTTP ${status}`;
}
