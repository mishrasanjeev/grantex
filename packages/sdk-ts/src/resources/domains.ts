import type { HttpClient } from '../http.js';
import type {
  CreateDomainParams,
  CreateDomainResponse,
  ListDomainsResponse,
  VerifyDomainResponse,
} from '../types.js';

export class DomainsClient {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  /** Register a custom domain. Enterprise plan required. */
  create(params: CreateDomainParams): Promise<CreateDomainResponse> {
    return this.#http.post<CreateDomainResponse>('/v1/domains', params);
  }

  /** List custom domains. */
  list(): Promise<ListDomainsResponse> {
    return this.#http.get<ListDomainsResponse>('/v1/domains');
  }

  /** Verify a custom domain via DNS. */
  verify(domainId: string): Promise<VerifyDomainResponse> {
    return this.#http.post<VerifyDomainResponse>(`/v1/domains/${domainId}/verify`);
  }

  /** Delete a custom domain. */
  delete(domainId: string): Promise<void> {
    return this.#http.delete(`/v1/domains/${domainId}`);
  }
}
