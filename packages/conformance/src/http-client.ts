import type { HttpResponse } from './types.js';

const USER_AGENT = '@grantex/conformance/0.1.0';

export class ConformanceHttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<HttpResponse<T>> {
    return this.doRequest<T>(method, path, body, {
      Authorization: `Bearer ${this.apiKey}`,
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

  async post<T = unknown>(path: string, body?: unknown): Promise<HttpResponse<T>> {
    return this.request<T>('POST', path, body);
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

    // Retry once on 429 (rate limited) after waiting the specified time
    if (res.status === 429) {
      const retryMatch = (await res.text()).match(/retry in (\d+)/);
      const waitSec = retryMatch ? Math.min(parseInt(retryMatch[1]!, 10), 60) : 10;
      await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
      res = await fetch(url, init);
    }

    const durationMs = Date.now() - start;

    const rawText = await res.text();
    let parsed: T;
    try {
      parsed = JSON.parse(rawText) as T;
    } catch {
      parsed = rawText as T;
    }

    return { status: res.status, body: parsed, rawText, durationMs };
  }
}
