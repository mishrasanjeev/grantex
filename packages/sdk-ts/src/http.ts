import { GrantexApiError, GrantexAuthError, GrantexNetworkError } from './errors.js';

const SDK_VERSION = '0.1.0';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface HttpClientOptions {
  baseUrl: string;
  apiKey: string;
  timeout?: number;
}

export class HttpClient {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #timeout: number;

  constructor(options: HttpClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, '');
    this.#apiKey = options.apiKey;
    this.#timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
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

  async #request<T>(method: string, path: string, body: unknown): Promise<T> {
    const url = `${this.#baseUrl}${path}`;
    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), this.#timeout);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      'User-Agent': `@grantex/sdk/${SDK_VERSION}`,
      Accept: 'application/json',
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      const isTimeout =
        err instanceof Error && err.name === 'AbortError';
      throw new GrantexNetworkError(
        isTimeout
          ? `Request timed out after ${this.#timeout}ms`
          : `Network error: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    } finally {
      clearTimeout(timerId);
    }

    const requestId = response.headers.get('x-request-id') ?? undefined;

    if (!response.ok) {
      let responseBody: unknown;
      try {
        responseBody = await response.json();
      } catch {
        responseBody = await response.text().catch(() => null);
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
        );
      }

      throw new GrantexApiError(message, response.status, responseBody, requestId, errorCode);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
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
