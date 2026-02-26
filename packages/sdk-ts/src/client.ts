import { HttpClient } from './http.js';
import { AgentsClient } from './resources/agents.js';
import { AuditClient } from './resources/audit.js';
import { GrantsClient } from './resources/grants.js';
import { TokensClient } from './resources/tokens.js';
import { WebhooksClient } from './resources/webhooks.js';
import { BillingClient } from './resources/billing.js';
import { PoliciesClient } from './resources/policies.js';
import { ComplianceClient } from './resources/compliance.js';
import type {
  AuthorizationRequest,
  AuthorizeParams,
  GrantexClientOptions,
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
}
