import type { HttpClient } from '../http.js';
import type { CreatePrincipalSessionParams, PrincipalSessionResponse } from '../types.js';

export class PrincipalSessionsClient {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  create(params: CreatePrincipalSessionParams): Promise<PrincipalSessionResponse> {
    return this.#http.post<PrincipalSessionResponse>('/v1/principal-sessions', params);
  }
}
