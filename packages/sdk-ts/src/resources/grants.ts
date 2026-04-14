import type { HttpClient } from '../http.js';
import { claimsToVerifiedGrant } from '../verify.js';
import { GrantexTokenError } from '../errors.js';
import type {
  Grant,
  ListGrantsParams,
  ListGrantsResponse,
  VerifiedGrant,
  DelegateParams,
  GrantTokenPayload,
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
   * Create a delegated sub-agent grant (SPEC §9).
   */
  delegate(params: DelegateParams): Promise<{ grantToken: string; expiresAt: string; scopes: string[]; grantId: string }> {
    return this.#http.post('/v1/grants/delegate', params);
  }

  /**
   * Verify a grant token via the API (online verification).
   */
  async verify(token: string): Promise<VerifiedGrant> {
    const response = await this.#http.post<{
      active?: boolean;
      reason?: string;
      claims?: GrantTokenPayload;
    }>(
      '/v1/grants/verify',
      { token },
    );
    if (!response.active || !response.claims) {
      throw new GrantexTokenError(
        `Grant token is not active${response.reason ? `: ${response.reason}` : ''}`,
      );
    }
    return claimsToVerifiedGrant(response.claims);
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
