import type { HttpClient } from '../http.js';
import type {
  VerifiableCredentialRecord,
  ListCredentialsParams,
  ListCredentialsResponse,
  VCVerificationResult,
  SDJWTPresentParams,
  SDJWTPresentResult,
} from '../types.js';

export class CredentialsClient {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  get(credentialId: string): Promise<VerifiableCredentialRecord> {
    return this.#http.get<VerifiableCredentialRecord>(`/v1/credentials/${credentialId}`);
  }

  list(params?: ListCredentialsParams): Promise<ListCredentialsResponse> {
    const searchParams = new URLSearchParams();
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) searchParams.set(key, String(value));
      }
    }
    const qs = searchParams.toString();
    return this.#http.get<ListCredentialsResponse>(`/v1/credentials${qs ? `?${qs}` : ''}`);
  }

  verify(vcJwt: string): Promise<VCVerificationResult> {
    return this.#http.post<VCVerificationResult>('/v1/credentials/verify', { credential: vcJwt });
  }

  present(params: SDJWTPresentParams): Promise<SDJWTPresentResult> {
    return this.#http.post<SDJWTPresentResult>('/v1/credentials/present', params);
  }
}
