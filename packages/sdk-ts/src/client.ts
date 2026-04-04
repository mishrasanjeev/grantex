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
import { PrincipalSessionsClient } from './resources/principal-sessions.js';
import { VaultClient } from './resources/vault.js';
import { BudgetsClient } from './resources/budgets.js';
import { EventsClient } from './resources/events.js';
import { UsageClient } from './resources/usage.js';
import { DomainsClient } from './resources/domains.js';
import { WebAuthnClient } from './resources/webauthn.js';
import { CredentialsClient } from './resources/credentials.js';
import { PassportsClient } from './resources/passports.js';
import { ToolManifest, permissionCovers, type EnforceOptions, type EnforceResult, type WrapToolOptions, type EnforceMiddlewareOptions } from './manifest.js';
import { verifyGrantToken } from './verify.js';
import type {
  AuthorizationRequest,
  AuthorizeParams,
  GrantexClientOptions,
  RateLimit,
  RotateKeyResponse,
  SignupParams,
  SignupResponse,
  UpdateDeveloperSettingsParams,
  UpdateDeveloperSettingsResponse,
  VerifiedGrant,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.grantex.dev';

export class Grantex {
  readonly #http: HttpClient;
  readonly #manifests: Map<string, ToolManifest> = new Map();
  #jwksUri: string;
  #enforceMode: 'strict' | 'permissive';

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
  readonly principalSessions: PrincipalSessionsClient;
  readonly vault: VaultClient;
  readonly budgets: BudgetsClient;
  readonly events: EventsClient;
  readonly usage: UsageClient;
  readonly domains: DomainsClient;
  readonly webauthn: WebAuthnClient;
  readonly credentials: CredentialsClient;
  readonly passports: PassportsClient;

  get lastRateLimit(): RateLimit | undefined {
    return this.#http.lastRateLimit;
  }

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
    this.principalSessions = new PrincipalSessionsClient(this.#http);
    this.vault = new VaultClient(this.#http, options.baseUrl ?? DEFAULT_BASE_URL);
    this.budgets = new BudgetsClient(this.#http);
    this.events = new EventsClient(this.#http);
    this.usage = new UsageClient(this.#http);
    this.domains = new DomainsClient(this.#http);
    this.webauthn = new WebAuthnClient(this.#http);
    this.credentials = new CredentialsClient(this.#http);
    this.passports = new PassportsClient(this.#http);
    this.#jwksUri = `${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')}/.well-known/jwks.json`;
    this.#enforceMode = (options as Record<string, unknown>)['enforceMode'] as 'strict' | 'permissive' ?? 'strict';
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

  /**
   * Update developer settings (e.g. FIDO/WebAuthn requirements).
   */
  updateSettings(params: UpdateDeveloperSettingsParams): Promise<UpdateDeveloperSettingsResponse> {
    return this.#http.patch<UpdateDeveloperSettingsResponse>('/v1/me', params);
  }

  /**
   * Load a tool manifest for scope enforcement.
   * Manifests define what permission level each tool requires.
   */
  loadManifest(manifest: ToolManifest): void {
    this.#manifests.set(manifest.connector, manifest);
  }

  /**
   * Load multiple tool manifests at once.
   */
  loadManifests(manifests: ToolManifest[]): void {
    for (const m of manifests) {
      this.#manifests.set(m.connector, m);
    }
  }

  /**
   * Load all JSON manifest files from a directory.
   * Each `.json` file is parsed as a ToolManifest and loaded.
   */
  async loadManifestsFromDir(dirPath: string): Promise<void> {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const files = fs.readdirSync(dirPath).filter((f: string) => f.endsWith('.json'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(dirPath, file), 'utf-8');
      const data = JSON.parse(content) as Record<string, unknown>;
      this.loadManifest(ToolManifest.fromJSON(data));
    }
  }

  /**
   * Enforce scope for a tool call.
   *
   * 1. Verifies the grant token JWT offline (JWKS cached, <1ms after first call)
   * 2. Looks up the tool's required permission from loaded manifests
   * 3. Checks if the granted scope level covers the required permission
   *
   * Fails closed: unknown connectors/tools are denied by default.
   *
   * @example
   * ```ts
   * const result = await grantex.enforce({
   *   grantToken: token,
   *   connector: 'salesforce',
   *   tool: 'delete_contact',
   * });
   * if (!result.allowed) throw new Error(result.reason);
   * ```
   */
  async enforce(options: EnforceOptions): Promise<EnforceResult> {
    const { grantToken, connector, tool, amount } = options;
    const base: Omit<EnforceResult, 'allowed' | 'reason'> = {
      grantId: '',
      agentDid: '',
      scopes: [],
      permission: '',
      connector,
      tool,
    };

    // 1. Verify the token offline via JWKS
    let grant: VerifiedGrant;
    try {
      grant = await verifyGrantToken(grantToken, { jwksUri: this.#jwksUri });
    } catch (err) {
      return this.#applyEnforceMode({
        ...base,
        allowed: false,
        reason: `Token verification failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    base.grantId = grant.grantId;
    base.agentDid = grant.agentDid;
    base.scopes = grant.scopes;

    // 2. Look up manifest for the connector
    const manifest = this.#manifests.get(connector);
    if (!manifest) {
      return this.#applyEnforceMode({
        ...base,
        allowed: false,
        reason: `No manifest loaded for connector '${connector}'. Load a manifest first.`,
      });
    }

    // 3. Look up tool permission from manifest
    const requiredPermission = manifest.getPermission(tool);
    if (!requiredPermission) {
      return this.#applyEnforceMode({
        ...base,
        allowed: false,
        reason: `Unknown tool '${tool}' on connector '${connector}'. Tool not found in manifest.`,
      });
    }
    base.permission = requiredPermission;

    // 4. Find the best matching scope for this connector
    const grantedPermission = this.#resolveGrantedPermission(grant.scopes, connector);
    if (!grantedPermission) {
      return this.#applyEnforceMode({
        ...base,
        allowed: false,
        reason: `No scope grants access to connector '${connector}'.`,
      });
    }

    // 5. Check permission hierarchy
    if (!permissionCovers(grantedPermission, requiredPermission)) {
      return this.#applyEnforceMode({
        ...base,
        allowed: false,
        reason: `${grantedPermission} scope does not permit ${requiredPermission} operations on ${connector}.`,
      });
    }

    // 6. Check capped amount if provided
    if (amount !== undefined) {
      const cap = this.#extractCap(grant.scopes, connector);
      if (cap !== undefined && amount > cap) {
        return this.#applyEnforceMode({
          ...base,
          allowed: false,
          reason: `Amount ${amount} exceeds budget cap of ${cap} on ${connector}.`,
        });
      }
    }

    return { ...base, allowed: true, reason: '' };
  }

  /**
   * Resolve the highest granted permission level for a connector from scope strings.
   * Scope format: `tool:{connector}:{permission}[:{resource}][:capped:{N}]`
   */
  #resolveGrantedPermission(scopes: string[], connector: string): string | undefined {
    let best: string | undefined;
    let bestLevel = -1;

    const levels: Record<string, number> = { read: 0, write: 1, delete: 2, admin: 3 };

    for (const scope of scopes) {
      const parts = scope.split(':');
      // Match: tool:{connector}:{permission}:...
      if (parts[0] === 'tool' && parts[1] === connector && parts[2]) {
        const level = levels[parts[2]] ?? -1;
        if (level > bestLevel) {
          bestLevel = level;
          best = parts[2];
        }
      }
      // Also match agenticorg:{connector}:{permission}
      if (parts[0] === 'agenticorg' && parts[1] === connector && parts[2]) {
        const level = levels[parts[2]] ?? -1;
        if (level > bestLevel) {
          bestLevel = level;
          best = parts[2];
        }
      }
    }

    return best;
  }

  /**
   * Extract the budget cap from capped scopes for a connector.
   * Scope format: `tool:{connector}:{permission}:{resource}:capped:{N}`
   */
  #extractCap(scopes: string[], connector: string): number | undefined {
    for (const scope of scopes) {
      const parts = scope.split(':');
      if (parts[0] === 'tool' && parts[1] === connector) {
        const cappedIdx = parts.indexOf('capped');
        if (cappedIdx !== -1 && parts[cappedIdx + 1]) {
          return Number(parts[cappedIdx + 1]);
        }
      }
    }
    return undefined;
  }

  #applyEnforceMode(result: EnforceResult): EnforceResult {
    if (!result.allowed && this.#enforceMode === 'permissive') {
      console.warn(`[grantex] PERMISSIVE MODE — would deny: ${result.reason} (connector=${result.connector}, tool=${result.tool})`);
      return { ...result, allowed: true };
    }
    return result;
  }

  /**
   * Wrap a LangChain StructuredTool with automatic Grantex scope enforcement.
   * Before each tool invocation, the grant token is verified and scopes are checked.
   *
   * @param tool - The LangChain StructuredTool to wrap
   * @param options - Connector name, tool name, and grant token (string or getter function)
   * @returns A new StructuredTool that enforces scopes before calling the original
   *
   * @example
   * ```ts
   * const protectedTool = grantex.wrapTool(myTool, {
   *   connector: 'salesforce',
   *   tool: 'create_lead',
   *   grantToken: () => currentState.grant_token,
   * });
   * ```
   */
  wrapTool<T extends { name: string; description: string; invoke: (...args: unknown[]) => Promise<unknown> }>(
    tool: T,
    options: WrapToolOptions,
  ): T {
    const self = this;
    const originalInvoke = tool.invoke.bind(tool);

    const wrapped = Object.create(tool);
    wrapped.invoke = async function (...args: unknown[]): Promise<unknown> {
      const getToken = () => typeof options.grantToken === 'function' ? options.grantToken() : options.grantToken;

      let result = await self.enforce({
        grantToken: getToken(),
        connector: options.connector,
        tool: options.tool,
      });

      // Retry once with refreshed token if expired and grantToken is a getter
      if (!result.allowed && result.reason.includes('expired') && typeof options.grantToken === 'function') {
        result = await self.enforce({
          grantToken: getToken(),
          connector: options.connector,
          tool: options.tool,
        });
      }

      if (!result.allowed) {
        throw new Error(`Grantex scope denied: ${result.reason}`);
      }

      return originalInvoke(...args);
    };

    return wrapped as T;
  }

  /**
   * Create Express/Fastify middleware that enforces Grantex scopes on every request.
   *
   * @example
   * ```ts
   * app.use('/api/tools/*', grantex.enforceMiddleware({
   *   extractToken: (req) => req.headers.authorization?.replace('Bearer ', ''),
   *   extractConnector: (req) => req.params.connector,
   *   extractTool: (req) => req.params.tool,
   * }));
   * ```
   */
  enforceMiddleware(options: EnforceMiddlewareOptions): (req: unknown, res: unknown, next: unknown) => void {
    const self = this;
    return function grantexEnforce(req: unknown, res: unknown, next: unknown) {
      const request = req as Record<string, unknown>;
      const response = res as Record<string, unknown>;
      const nextFn = next as (err?: unknown) => void;

      const token = options.extractToken(request);
      const connector = options.extractConnector(request);
      const tool = options.extractTool(request);

      if (!token) {
        const statusFn = response['status'] as (code: number) => Record<string, unknown>;
        const jsonFn = statusFn.call(response, 401)['json'] as (body: unknown) => void;
        jsonFn.call(statusFn.call(response, 401), { error: { code: 'UNAUTHORIZED', message: 'Missing grant token' } });
        return;
      }

      self.enforce({ grantToken: token, connector, tool })
        .then((result) => {
          if (!result.allowed) {
            const statusFn = response['status'] as (code: number) => Record<string, unknown>;
            const jsonFn = statusFn.call(response, 403)['json'] as (body: unknown) => void;
            jsonFn.call(statusFn.call(response, 403), {
              error: { code: 'SCOPE_DENIED', message: result.reason, connector, tool },
            });
            return;
          }
          // Attach enforce result to request for downstream use
          (request as Record<string, unknown>)['grantexEnforce'] = result;
          nextFn();
        })
        .catch((err) => nextFn(err));
    };
  }
}
