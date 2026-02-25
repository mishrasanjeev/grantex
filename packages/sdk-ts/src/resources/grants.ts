import type { HttpClient } from '../http.js';
import { mapOnlineVerifyToVerifiedGrant } from '../verify.js';
import type {
  Grant,
  ListGrantsParams,
  ListGrantsResponse,
  VerifiedGrant,
} from '../types.js';

export class GrantsClient {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  get(grantId: string): Promise<Grant> {
    return this.#http.get<Grant>(`/v1/grants/${grantId}`);
  }

  list(params?: ListGrantsParams): Promise<ListGrantsResponse> {
    const query = buildQuery(params);
    const path = query ? `/v1/grants?${query}` : '/v1/grants';
    return this.#http.get<ListGrantsResponse>(path);
  }

  revoke(grantId: string): Promise<void> {
    return this.#http.delete<void>(`/v1/grants/${grantId}`);
  }

  /**
   * Verify a grant token via the API (online verification).
   * Returns a clean VerifiedGrant shape by decoding the raw token returned
   * from the server to fill fields the summary response may omit.
   */
  async verify(token: string): Promise<VerifiedGrant> {
    const response = await this.#http.post<{ token: string } & Partial<VerifiedGrant>>(
      '/v1/grants/verify',
      { token },
    );
    // The API may echo back the raw token; decode it to guarantee all fields.
    const rawToken: string = response.token ?? token;
    return mapOnlineVerifyToVerifiedGrant(rawToken);
  }
}

function buildQuery(params?: ListGrantsParams): string {
  if (!params) return '';
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null,
  ) as Array<[string, string | number]>;
  if (entries.length === 0) return '';
  return entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}
