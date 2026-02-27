import { HttpClient } from './http.js';
import { AgentsClient } from './resources/agents.js';
import { AuditClient } from './resources/audit.js';
import { GrantsClient } from './resources/grants.js';
import { TokensClient } from './resources/tokens.js';
import { WebhooksClient } from './resources/webhooks.js';
import { BillingClient } from './resources/billing.js';
import { PoliciesClient } from './resources/policies.js';
import { ComplianceClient } from './resources/compliance.js';
import { AnomaliesClient } from './resources/anomalies.js';
import { ScimClient } from './resources/scim.js';
import { SsoClient } from './resources/sso.js';
import type {
  AuthorizationRequest,
  AuthorizeParams,
  GrantexClientOptions,
  RotateKeyResponse,
  SignupParams,
  SignupResponse,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.grantex.dev';

export class Grantex {
  readonly #http: HttpClient;

  readonly agents: AgentsClient;
  readonly grants: GrantsClient;
  readonly tokens: TokensClient;
  readonly audit: AuditClient;
  readonly webhooks: WebhooksClient;
  readonly billing: BillingClient;
  readonly policies: PoliciesClient;
  readonly compliance: ComplianceClient;
  readonly anomalies: AnomaliesClient;
  readonly scim: ScimClient;
  readonly sso: SsoClient;

  constructor(options: GrantexClientOptions = {}) {
    const apiKey =
      options.apiKey ?? process.env['GRANTEX_API_KEY'] ?? '';

    if (!apiKey) {
      throw new Error(
        'Grantex API key is required. Pass `apiKey` in options or set the GRANTEX_API_KEY environment variable.',
      );
    }

    this.#http = new HttpClient({
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      apiKey,
      ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    });

    this.agents = new AgentsClient(this.#http);
    this.grants = new GrantsClient(this.#http);
    this.tokens = new TokensClient(this.#http);
    this.audit = new AuditClient(this.#http);
    this.webhooks = new WebhooksClient(this.#http);
    this.billing = new BillingClient(this.#http);
    this.policies = new PoliciesClient(this.#http);
    this.compliance = new ComplianceClient(this.#http);
    this.anomalies = new AnomaliesClient(this.#http);
    this.scim = new ScimClient(this.#http);
    this.sso = new SsoClient(this.#http);
  }

  /**
   * Create a new developer account without an API key.
   * Returns the developer ID and a one-time API key.
   */
  static async signup(
    params: SignupParams,
    options: { baseUrl?: string } = {},
  ): Promise<SignupResponse> {
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/v1/signup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const message =
        body && typeof body === 'object' && 'message' in body
          ? String((body as Record<string, unknown>)['message'])
          : `HTTP ${response.status}`;
      throw new Error(message);
    }

    return response.json() as Promise<SignupResponse>;
  }

  /**
   * Initiate the delegated authorization flow for a user.
   * `userId` is transparently mapped to `principalId` in the request body.
   */
  authorize(params: AuthorizeParams): Promise<AuthorizationRequest> {
    const { userId, ...rest } = params;
    return this.#http.post<AuthorizationRequest>('/v1/authorize', {
      ...rest,
      principalId: userId,
    });
  }

  /**
   * Rotate the current API key. Returns a new key; the old key is invalidated.
   */
  rotateKey(): Promise<RotateKeyResponse> {
    return this.#http.post<RotateKeyResponse>('/v1/keys/rotate');
  }
}
