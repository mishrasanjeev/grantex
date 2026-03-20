import type { HttpClient } from '../http.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface IssuePassportParams {
  agentId: string;
  grantId: string;
  allowedMPPCategories: string[];
  maxTransactionAmount: { amount: number; currency: string };
  paymentRails?: string[];
  expiresIn?: string;
  parentPassportId?: string;
}

export interface IssuedPassportResponse {
  passportId: string;
  credential: Record<string, unknown>;
  encodedCredential: string;
  expiresAt: string;
}

export interface GetPassportResponse {
  status: string;
  [key: string]: unknown;
}

export interface RevokePassportResponse {
  revoked: boolean;
  revokedAt: string;
}

export interface ListPassportsParams {
  agentId?: string;
  grantId?: string;
  status?: string;
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class PassportsClient {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  issue(params: IssuePassportParams): Promise<IssuedPassportResponse> {
    return this.#http.post<IssuedPassportResponse>('/v1/passport/issue', params);
  }

  get(passportId: string): Promise<GetPassportResponse> {
    return this.#http.get<GetPassportResponse>(
      `/v1/passport/${encodeURIComponent(passportId)}`,
    );
  }

  revoke(passportId: string): Promise<RevokePassportResponse> {
    return this.#http.post<RevokePassportResponse>(
      `/v1/passport/${encodeURIComponent(passportId)}/revoke`,
    );
  }

  list(params?: ListPassportsParams): Promise<IssuedPassportResponse[]> {
    const searchParams = new URLSearchParams();
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) searchParams.set(key, String(value));
      }
    }
    const qs = searchParams.toString();
    return this.#http.get<IssuedPassportResponse[]>(
      `/v1/passports${qs ? `?${qs}` : ''}`,
    );
  }
}
