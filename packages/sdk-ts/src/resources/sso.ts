import type { HttpClient } from '../http.js';
import type {
  SsoConfig,
  CreateSsoConfigParams,
  SsoLoginResponse,
  SsoCallbackResponse,
  SsoConnection,
  CreateSsoConnectionParams,
  UpdateSsoConnectionParams,
  SsoConnectionListResponse,
  SsoConnectionTestResult,
  SsoEnforcementParams,
  SsoEnforcementResponse,
  SsoSession,
  SsoSessionListResponse,
  SsoOidcCallbackParams,
  SsoSamlCallbackParams,
  SsoCallbackResult,
} from '../types.js';

export class SsoClient {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  // ── Enterprise SSO Connections ──────────────────────────────────────────

  /** Create a new SSO connection (OIDC or SAML). */
  createConnection(params: CreateSsoConnectionParams): Promise<SsoConnection> {
    return this.#http.post<SsoConnection>('/v1/sso/connections', params);
  }

  /** List all SSO connections for this org. */
  listConnections(): Promise<SsoConnectionListResponse> {
    return this.#http.get<SsoConnectionListResponse>('/v1/sso/connections');
  }

  /** Get a single SSO connection by ID. */
  getConnection(id: string): Promise<SsoConnection> {
    return this.#http.get<SsoConnection>(`/v1/sso/connections/${encodeURIComponent(id)}`);
  }

  /** Update an SSO connection. */
  updateConnection(id: string, params: UpdateSsoConnectionParams): Promise<SsoConnection> {
    return this.#http.patch<SsoConnection>(`/v1/sso/connections/${encodeURIComponent(id)}`, params);
  }

  /** Delete an SSO connection. */
  deleteConnection(id: string): Promise<void> {
    return this.#http.delete<void>(`/v1/sso/connections/${encodeURIComponent(id)}`);
  }

  /** Test an SSO connection's IdP reachability. */
  testConnection(id: string): Promise<SsoConnectionTestResult> {
    return this.#http.post<SsoConnectionTestResult>(`/v1/sso/connections/${encodeURIComponent(id)}/test`, {});
  }

  // ── SSO enforcement ──────────────────────────────────���──────────────────

  /** Enable or disable org-wide SSO enforcement. */
  setEnforcement(params: SsoEnforcementParams): Promise<SsoEnforcementResponse> {
    return this.#http.post<SsoEnforcementResponse>('/v1/sso/enforce', params);
  }

  // ── SSO sessions ────────────────────────────────────────────────────────

  /** List active SSO sessions. */
  listSessions(): Promise<SsoSessionListResponse> {
    return this.#http.get<SsoSessionListResponse>('/v1/sso/sessions');
  }

  /** Revoke an SSO session by ID. */
  revokeSession(id: string): Promise<void> {
    return this.#http.delete<void>(`/v1/sso/sessions/${encodeURIComponent(id)}`);
  }

  // ── SSO login flow ──────────────────────────────────────────────────────

  /** Get the IdP authorization URL. Optionally pass a domain for auto-routing. */
  getLoginUrl(org: string, domain?: string): Promise<SsoLoginResponse> {
    let url = `/sso/login?org=${encodeURIComponent(org)}`;
    if (domain) url += `&domain=${encodeURIComponent(domain)}`;
    return this.#http.get<SsoLoginResponse>(url);
  }

  /** Handle an OIDC callback with ID-token verification. */
  handleOidcCallback(params: SsoOidcCallbackParams): Promise<SsoCallbackResult> {
    return this.#http.post<SsoCallbackResult>('/sso/callback/oidc', params);
  }

  /** Handle a SAML callback with assertion verification. */
  handleSamlCallback(params: SsoSamlCallbackParams): Promise<SsoCallbackResult> {
    return this.#http.post<SsoCallbackResult>('/sso/callback/saml', params);
  }

  // ── Legacy methods (backward compatible) ────────────────────────────────

  /** @deprecated Use createConnection() instead. */
  createConfig(params: CreateSsoConfigParams): Promise<SsoConfig> {
    return this.#http.post<SsoConfig>('/v1/sso/config', params);
  }

  /** @deprecated Use listConnections() instead. */
  getConfig(): Promise<SsoConfig> {
    return this.#http.get<SsoConfig>('/v1/sso/config');
  }

  /** @deprecated Use deleteConnection() instead. */
  deleteConfig(): Promise<void> {
    return this.#http.delete<void>('/v1/sso/config');
  }

  /** @deprecated Use handleOidcCallback() instead. */
  handleCallback(code: string, state: string): Promise<SsoCallbackResponse> {
    return this.#http.get<SsoCallbackResponse>(
      `/sso/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    );
  }
}
