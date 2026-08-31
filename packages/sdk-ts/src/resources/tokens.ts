import type { HttpClient } from '../http.js';
import type { ExchangeTokenParams, ExchangeTokenResponse, RefreshTokenParams, VerifyTokenResponse } from '../types.js';
import { randomUUID } from 'node:crypto';

export class TokensClient {
  readonly #http: HttpClient;
  readonly #refreshRetryKeys = new Map<string, { key: string; expiresAt: number }>();

  constructor(http: HttpClient) {
    this.#http = http;
  }

  exchange(params: ExchangeTokenParams): Promise<ExchangeTokenResponse> {
    return this.#http.post<ExchangeTokenResponse>('/v1/token', params);
  }

  async refresh(params: RefreshTokenParams): Promise<ExchangeTokenResponse> {
    const now = Date.now();
    for (const [token, retry] of this.#refreshRetryKeys) {
      if (retry.expiresAt <= now) this.#refreshRetryKeys.delete(token);
    }
    const cached = this.#refreshRetryKeys.get(params.refreshToken);
    const idempotencyKey = params.idempotencyKey
      ?? (cached && cached.expiresAt > now ? cached.key : randomUUID());
    this.#refreshRetryKeys.set(params.refreshToken, { key: idempotencyKey, expiresAt: now + 300_000 });
    const body = { refreshToken: params.refreshToken, agentId: params.agentId };
    const response = await this.#http.post<ExchangeTokenResponse>('/v1/token/refresh', body, {
      headers: { 'Idempotency-Key': idempotencyKey },
    });
    this.#refreshRetryKeys.delete(params.refreshToken);
    return response;
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
