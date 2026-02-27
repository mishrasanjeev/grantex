import type { HttpClient } from '../http.js';
import type {
  ScimToken,
  ScimTokenWithSecret,
  CreateScimTokenParams,
  ListScimTokensResponse,
  ScimUser,
  ScimListResponse,
  CreateScimUserParams,
  UpdateScimUserParams,
} from '../types.js';

export class ScimClient {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  // ── SCIM token management ─────────────────────────────────────────────

  /** Create a new SCIM bearer token. The raw token is returned once only. */
  createToken(params: CreateScimTokenParams): Promise<ScimTokenWithSecret> {
    return this.#http.post<ScimTokenWithSecret>('/v1/scim/tokens', params);
  }

  /** List all SCIM tokens for this developer org (without raw secrets). */
  listTokens(): Promise<ListScimTokensResponse> {
    return this.#http.get<ListScimTokensResponse>('/v1/scim/tokens');
  }

  /** Revoke a SCIM token by ID. */
  revokeToken(tokenId: string): Promise<void> {
    return this.#http.delete<void>(`/v1/scim/tokens/${tokenId}`);
  }

  // ── SCIM 2.0 Users ────────────────────────────────────────────────────

  /** List provisioned users (SCIM 2.0 ListResponse). */
  listUsers(params?: { startIndex?: number; count?: number }): Promise<ScimListResponse> {
    const qs = new URLSearchParams();
    if (params?.startIndex !== undefined) qs.set('startIndex', String(params.startIndex));
    if (params?.count !== undefined) qs.set('count', String(params.count));
    const query = qs.toString();
    return this.#http.get<ScimListResponse>(query ? `/scim/v2/Users?${query}` : '/scim/v2/Users');
  }

  /** Get a single provisioned user by ID. */
  getUser(userId: string): Promise<ScimUser> {
    return this.#http.get<ScimUser>(`/scim/v2/Users/${userId}`);
  }

  /** Provision a new user. */
  createUser(params: CreateScimUserParams): Promise<ScimUser> {
    return this.#http.post<ScimUser>('/scim/v2/Users', params);
  }

  /** Full replace of a user (PUT). */
  replaceUser(userId: string, params: CreateScimUserParams): Promise<ScimUser> {
    return this.#http.put<ScimUser>(`/scim/v2/Users/${userId}`, params);
  }

  /** Partial update via SCIM Operations (PATCH). */
  updateUser(
    userId: string,
    operations: Array<{ op: string; path?: string; value: unknown }>,
  ): Promise<ScimUser> {
    return this.#http.patch<ScimUser>(`/scim/v2/Users/${userId}`, { Operations: operations });
  }

  /** Deprovision a user (DELETE). */
  deleteUser(userId: string): Promise<void> {
    return this.#http.delete<void>(`/scim/v2/Users/${userId}`);
  }
}

// Re-export UpdateScimUserParams to avoid unused-import warnings in tests
export type { UpdateScimUserParams };
