import type { HttpClient } from '../http.js';
import type {
  SsoConfig,
  CreateSsoConfigParams,
  SsoLoginResponse,
  SsoCallbackResponse,
} from '../types.js';

export class SsoClient {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  /** Create or update the OIDC SSO configuration for this developer org. */
  createConfig(params: CreateSsoConfigParams): Promise<SsoConfig> {
    return this.#http.post<SsoConfig>('/v1/sso/config', params);
  }

  /** Get the current SSO configuration (client secret is not returned). */
  getConfig(): Promise<SsoConfig> {
    return this.#http.get<SsoConfig>('/v1/sso/config');
  }

  /** Remove the SSO configuration. */
  deleteConfig(): Promise<void> {
    return this.#http.delete<void>('/v1/sso/config');
  }

  /**
   * Get the OIDC authorization URL to redirect the user to.
   * Pass `org` as the developer ID of the org initiating SSO.
   */
  getLoginUrl(org: string): Promise<SsoLoginResponse> {
    return this.#http.get<SsoLoginResponse>(`/sso/login?org=${encodeURIComponent(org)}`);
  }

  /**
   * Exchange the OIDC authorization code for user info.
   * Called after the IdP redirects back to your callback URL.
   */
  handleCallback(code: string, state: string): Promise<SsoCallbackResponse> {
    return this.#http.get<SsoCallbackResponse>(
      `/sso/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    );
  }
}
