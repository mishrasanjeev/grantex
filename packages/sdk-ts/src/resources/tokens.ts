import type { HttpClient } from '../http.js';
import type { ExchangeTokenParams, ExchangeTokenResponse, RefreshTokenParams, VerifyTokenResponse } from '../types.js';
import { randomUUID } from 'node:crypto';

export class TokensClient {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  exchange(params: ExchangeTokenParams): Promise<ExchangeTokenResponse> {
    return this.#http.post<ExchangeTokenResponse>('/v1/token', params);
  }

  refresh(params: RefreshTokenParams): Promise<ExchangeTokenResponse> {
    const { idempotencyKey = randomUUID(), ...body } = params;
    return this.#http.post<ExchangeTokenResponse>('/v1/token/refresh', body, {
      headers: { 'Idempotency-Key': idempotencyKey },
    });
  }

  verify(token: string): Promise<VerifyTokenResponse> {
    return this.#http.post<VerifyTokenResponse>('/v1/tokens/verify', {
      token,
    });
  }

  revoke(tokenId: string): Promise<void> {
    return this.#http.post<void>('/v1/tokens/revoke', { jti: tokenId });
  }
}
