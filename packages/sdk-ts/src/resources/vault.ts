import type { HttpClient } from '../http.js';
import type {
  ExchangeCredentialParams,
  ExchangeCredentialResponse,
  ListVaultCredentialsParams,
  ListVaultCredentialsResponse,
  StoreCredentialParams,
  StoreCredentialResponse,
  VaultCredential,
} from '../types.js';

export class VaultClient {
  readonly #http: HttpClient;
  readonly #baseUrl: string;

  constructor(http: HttpClient, baseUrl: string) {
    this.#http = http;
    this.#baseUrl = baseUrl.replace(/\/$/, '');
  }

  /** Store an encrypted credential in the vault (upserts on principal+service). */
  store(params: StoreCredentialParams): Promise<StoreCredentialResponse> {
    return this.#http.post<StoreCredentialResponse>('/v1/vault/credentials', params);
  }

  /** List credential metadata (no raw tokens). */
  list(params: ListVaultCredentialsParams = {}): Promise<ListVaultCredentialsResponse> {
    const query = new URLSearchParams();
    if (params.principalId) query.set('principalId', params.principalId);
    if (params.service) query.set('service', params.service);
    const qs = query.toString();
    return this.#http.get<ListVaultCredentialsResponse>(
      `/v1/vault/credentials${qs ? `?${qs}` : ''}`,
    );
  }

  /** Get credential metadata by ID (no raw token). */
  get(credentialId: string): Promise<VaultCredential> {
    return this.#http.get<VaultCredential>(`/v1/vault/credentials/${credentialId}`);
  }

  /** Delete a credential from the vault. */
  delete(credentialId: string): Promise<void> {
    return this.#http.delete(`/v1/vault/credentials/${credentialId}`);
  }

  /**
   * Exchange a grant token for an upstream credential.
   * Uses the grant token (not the API key) as the Bearer token.
   */
  async exchange(
    grantToken: string,
    params: ExchangeCredentialParams,
  ): Promise<ExchangeCredentialResponse> {
    const url = `${this.#baseUrl}/v1/vault/credentials/exchange`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${grantToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const message =
        body && typeof body === 'object' && 'message' in body
          ? String((body as Record<string, unknown>)['message'])
          : `HTTP ${response.status}`;
      throw new Error(message);
    }

    return response.json() as Promise<ExchangeCredentialResponse>;
  }
}
