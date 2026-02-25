import type { HttpClient } from '../http.js';
import type { IntrospectTokenResponse, RevokeTokenResponse } from '../types.js';

export class TokensClient {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  introspect(token: string): Promise<IntrospectTokenResponse> {
    return this.#http.post<IntrospectTokenResponse>('/v1/tokens/introspect', {
      token,
    });
  }

  revoke(tokenId: string): Promise<RevokeTokenResponse> {
    return this.#http.delete<RevokeTokenResponse>(`/v1/tokens/${tokenId}`);
  }
}
