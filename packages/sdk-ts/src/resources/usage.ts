import type { HttpClient } from '../http.js';
import type { UsageResponse, UsageHistoryResponse } from '../types.js';

export class UsageClient {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  /** Get current period usage (real-time). */
  current(): Promise<UsageResponse> {
    return this.#http.get<UsageResponse>('/v1/usage');
  }

  /** Get daily usage history. */
  history(params?: { days?: number }): Promise<UsageHistoryResponse> {
    const query = new URLSearchParams();
    if (params?.days !== undefined) query.set('days', String(params.days));
    const qs = query.toString();
    return this.#http.get<UsageHistoryResponse>(`/v1/usage/history${qs ? `?${qs}` : ''}`);
  }
}
