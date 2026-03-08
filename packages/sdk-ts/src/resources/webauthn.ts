import type { HttpClient } from '../http.js';
import type {
  WebAuthnRegistrationOptions,
  WebAuthnRegistrationVerifyParams,
  WebAuthnCredential,
  ListWebAuthnCredentialsResponse,
} from '../types.js';

export class WebAuthnClient {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  registerOptions(params: { principalId: string }): Promise<WebAuthnRegistrationOptions> {
    return this.#http.post<WebAuthnRegistrationOptions>('/v1/webauthn/register/options', params);
  }

  registerVerify(params: WebAuthnRegistrationVerifyParams): Promise<WebAuthnCredential> {
    return this.#http.post<WebAuthnCredential>('/v1/webauthn/register/verify', params);
  }

  listCredentials(principalId: string): Promise<ListWebAuthnCredentialsResponse> {
    return this.#http.get<ListWebAuthnCredentialsResponse>(
      `/v1/webauthn/credentials?principalId=${encodeURIComponent(principalId)}`,
    );
  }

  deleteCredential(credentialId: string): Promise<void> {
    return this.#http.delete<void>(`/v1/webauthn/credentials/${credentialId}`);
  }
}
