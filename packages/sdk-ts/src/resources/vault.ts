import type { HttpClient } from '../http.js';
import type {
  ExchangeCredentialParams,
  ExchangeCredentialReferenceParams,
  ExchangeCredentialReferenceResponse,
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
    return this.#http.get<VaultCredential>(`/v1/vault/credentials/${encodeURIComponent(credentialId)}`);
  }

  /** Delete a credential from the vault. */
  delete(credentialId: string): Promise<void> {
    return this.#http.delete(`/v1/vault/credentials/${encodeURIComponent(credentialId)}`);
  }

  /**
   * Exchange a grant token for an upstream credential.
   * Uses the grant token (not the API key) as the Bearer token.
   */
  async exchange(
    grantToken: string,
    params: ExchangeCredentialParams,
  ): Promise<ExchangeCredentialResponse> {
    return this.#exchange<ExchangeCredentialResponse>(grantToken, { service: params.service });
  }

  /**
   * Exchange a grant token for a credential reference instead of the credential.
   * The relying party (for example the gateway with `credentialReference: on`)
   * resolves the reference and injects the credential upstream; this process
   * never holds the secret. Needs `VAULT_CREDENTIAL_REFERENCES_ENABLED` on the
   * auth service.
   */
  async exchangeReference(
    grantToken: string,
    params: ExchangeCredentialReferenceParams,
  ): Promise<ExchangeCredentialReferenceResponse> {
    return this.#exchange<ExchangeCredentialReferenceResponse>(grantToken, {
      service: params.service,
      delivery: 'reference',
    });
  }

  async #exchange<T>(grantToken: string, body: Record<string, string>): Promise<T> {
    const url = `${this.#baseUrl}/v1/vault/credentials/exchange`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${grantToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const message =
        payload && typeof payload === 'object' && 'message' in payload
          ? String((payload as Record<string, unknown>)['message'])
          : `HTTP ${response.status}`;
      throw new Error(message);
    }

    return response.json() as Promise<T>;
  }
}
