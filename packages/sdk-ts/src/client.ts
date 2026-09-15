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
import { DpdpClient } from './resources/dpdp.js';
import { CommerceClient } from './resources/commerce.js';
import {
  CapSubReason,
  DenialReason,
  ManifestSubReason,
  PurposeSubReason,
  TokenSubReason,
  ToolSubReason,
} from './denials.js';
import {
  AuthorizationDetailsError,
  parseDecisionReferences,
  parseToolsAuthorization,
  toolsAuthorizationAllows,
  type DecisionReference,
  type ToolsAuthorization,
} from './authorization-details.js';
import { isKnownPurpose, matchPurpose } from './purpose.js';
import {
  CAPS_MODES,
  CapExceededError,
  CapsConfigurationError,
  MeterUnavailableError,
  type CapLimit,
  type CapsMeter,
  type CapsMode,
  type Reservation,
} from './caps/meter.js';
import { MALFORMED_GRANT_CAPS, buildCapLimits, type BuildCapLimitsOptions } from './caps/limits.js';
import { ToolManifest, parseManifestJson, permissionCovers, type WouldDeny, type ToolSpec, type EnforceOptions, type EnforceResult, type WrapToolOptions, type EnforceMiddlewareOptions } from './manifest.js';
import { verifyGrantToken } from './verify.js';
import { DecisionSubReason } from './denials.js';
import { ActionValidationError, computeActionHash, decisionActionFromToolCall, parseDecisionAction, type DecisionAction } from './decisions/action.js';
import { DecisionGrantError, verifyDecisionGrants, type DecisionGrantSet } from './decisions/verify.js';
import { DecisionsClient, type ConsumedDecision, type DecisionConsumer } from './resources/decisions.js';
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

function checkDecisionsMode(mode: unknown): 'enforce' | 'warn' {
  if (mode !== 'enforce' && mode !== 'warn') {
    throw new Error(`decisionsMode must be one of enforce, warn, not ${JSON.stringify(mode)}`);
  }
  return mode;
}

function checkCapsMode(mode: unknown): CapsMode {
  if (!(CAPS_MODES as readonly unknown[]).includes(mode)) {
    throw new Error(`capsMode must be one of ${CAPS_MODES.join(', ')}, not ${JSON.stringify(mode)}`);
  }
  return mode as CapsMode;
}

/**
 * Throw CapExceededError if reserving `limits` now would exceed a cap. A
 * point-in-time check that consumes nothing: a concurrent call can still take
 * the last unit before the reservation is made.
 */
async function checkCaps(meter: CapsMeter, tenantId: string, limits: readonly CapLimit[]): Promise<void> {
  for (const usage of await meter.usage(tenantId, limits)) {
    const limit = usage.limit;
    if (limit.units > 0 && (limit.limit === 0 || usage.used + limit.units > limit.limit)) {
      throw new CapExceededError({
        limit: limit.limit, window: limit.window, used: usage.used, requested: limit.units, scope: limit.scope, kind: limit.kind,
      });
    }
  }
}

export class Grantex {
  readonly #http: HttpClient;
  readonly #manifests: Map<string, ToolManifest> = new Map();
  #jwksUri: string;
  #issuer: string | undefined;
  #legacyClaims: boolean | undefined;
  #enforceMode: 'strict' | 'permissive';
  readonly #capsMeter: CapsMeter | undefined;
  readonly #capsMode: CapsMode;
  readonly #decisionsMode: 'enforce' | 'warn';
  readonly #decisionConsumer: DecisionConsumer;
  readonly #decisionAlgorithms: string[];

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
  readonly dpdp: DpdpClient;
  readonly commerce: CommerceClient;
  readonly decisions: DecisionsClient;

  get lastRateLimit(): RateLimit | undefined {
    return this.#http.lastRateLimit;
  }

  constructor(options: GrantexClientOptions = {}) {
    const apiKey =
      options.apiKey ?? process.env['GRANTEX_API_KEY'] ?? '';
    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    const normalizedBaseUrl = baseUrl.replace(/\/$/, '');

    if (!apiKey) {
      throw new Error(
        'Grantex API key is required. Pass `apiKey` in options or set the GRANTEX_API_KEY environment variable.',
      );
    }

    this.#http = new HttpClient({
      baseUrl,
      apiKey,
      ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
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
    this.vault = new VaultClient(this.#http, baseUrl);
    this.budgets = new BudgetsClient(this.#http);
    this.events = new EventsClient(this.#http);
    this.usage = new UsageClient(this.#http);
    this.domains = new DomainsClient(this.#http);
    this.webauthn = new WebAuthnClient(this.#http);
    this.credentials = new CredentialsClient(this.#http);
    this.passports = new PassportsClient(this.#http);
    this.dpdp = new DpdpClient(this.#http);
    this.commerce = new CommerceClient(this.#http);
    this.#jwksUri = options.jwksUri ?? `${normalizedBaseUrl}/.well-known/jwks.json`;
    this.#issuer = options.issuer;
    this.#legacyClaims = options.legacyClaims;
    this.#enforceMode = (options as Record<string, unknown>)['enforceMode'] as 'strict' | 'permissive' ?? 'strict';
    this.#capsMeter = options.capsMeter;
    this.#capsMode = checkCapsMode(options.capsMode ?? 'enforce');
    this.#decisionsMode = checkDecisionsMode(options.decisionsMode ?? 'enforce');
    const algorithms = [...(options.decisionAlgorithms ?? ['RS256', 'ES256'])];
    if (algorithms.length === 0 || algorithms.some((a) => a !== 'RS256' && a !== 'ES256')) {
      throw new Error('decisionAlgorithms must be a non-empty subset of RS256, ES256');
    }
    this.#decisionAlgorithms = algorithms;
    this.decisions = new DecisionsClient(this.#http);
    const decisions = this.decisions;
    this.#decisionConsumer = options.decisionConsumer ?? {
      consume: (grants, consumeOptions) => decisions.consume(grants, consumeOptions ?? {}),
    };
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
      const data = parseManifestJson(content);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw new Error(`ToolManifest: a manifest must be a JSON object (${file})`);
      }
      this.loadManifest(ToolManifest.fromJSON(data as Record<string, unknown>));
    }
  }

  /**
   * Enforce scope for a tool call.
   *
   * 1. Verifies the grant token JWT locally using the issuer's JWKS
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
    const { grantToken, connector, tool, amount, caseId, costComponents, reserve = true, capsTenantId } = options;
    const capsMode = options.capsMode === undefined ? this.#capsMode : checkCapsMode(options.capsMode);
    const decisionsMode = options.decisionsMode === undefined ? this.#decisionsMode : checkDecisionsMode(options.decisionsMode);
    const base: Omit<EnforceResult, 'allowed' | 'reason'> = {
      grantId: '',
      agentDid: '',
      scopes: [],
      permission: '',
      connector,
      tool,
    };
    let resultPurpose: string | undefined;
    const denied = (
      reason: string,
      reasonCode: DenialReason,
      subReason?: string,
      details?: Record<string, unknown>,
    ): EnforceResult =>
      this.#applyEnforceMode({
        ...base,
        allowed: false,
        reason,
        reasonCode,
        ...(subReason !== undefined ? { subReason } : {}),
        ...(details !== undefined ? { details } : {}),
        ...(resultPurpose !== undefined ? { purpose: resultPurpose } : {}),
      });

    // 1. Verify the token locally using JWKS retrieved from the configured URI
    let grant: VerifiedGrant;
    try {
      grant = await verifyGrantToken(grantToken, {
        jwksUri: this.#jwksUri,
        ...(this.#issuer !== undefined ? { issuer: this.#issuer } : {}),
        ...(this.#legacyClaims !== undefined ? { legacyClaims: this.#legacyClaims } : {}),
      });
    } catch (err) {
      return denied(
        `Token verification failed: ${err instanceof Error ? err.message : String(err)}`,
        DenialReason.TOKEN_INVALID,
      );
    }

    base.grantId = grant.grantId;
    base.agentDid = grant.agentDid;
    base.scopes = grant.scopes;

    // 2. Read the grant's tools authorization for this connector. A claim that
    //    cannot be read unambiguously denies every call.
    let entry: ToolsAuthorization | undefined;
    let decisionReference: DecisionReference | undefined;
    try {
      entry = parseToolsAuthorization(grant.authorizationDetails).get(connector);
      decisionReference = parseDecisionReferences(grant.authorizationDetails).get(connector);
    } catch (err) {
      if (!(err instanceof AuthorizationDetailsError)) throw err;
      return denied(
        `Grant token authorization_details cannot be used: ${err.message}.`,
        DenialReason.TOKEN_INVALID,
        TokenSubReason.MALFORMED_AUTHORIZATION_DETAILS,
      );
    }
    const purpose = entry?.purpose;
    resultPurpose = purpose;

    // 3. Look up manifest for the connector
    const manifest = this.#manifests.get(connector);
    if (!manifest) {
      return denied(
        `No manifest loaded for connector '${connector}'. Load a manifest first.`,
        DenialReason.MANIFEST_UNKNOWN_TOOL,
        ManifestSubReason.UNKNOWN_CONNECTOR,
      );
    }

    // 4. Look up tool permission from manifest
    const requiredPermission = manifest.getPermission(tool);
    if (!requiredPermission) {
      return denied(
        `Unknown tool '${tool}' on connector '${connector}'. Tool not found in manifest.`,
        DenialReason.MANIFEST_UNKNOWN_TOOL,
        ManifestSubReason.UNKNOWN_TOOL,
      );
    }
    base.permission = requiredPermission;
    let spec: ToolSpec | undefined;
    try {
      spec = manifest.getToolSpec(tool);
    } catch (err) {
      return denied(
        `Tool '${tool}' on connector '${connector}' has an invalid declaration: ${err instanceof Error ? err.message : String(err)}`,
        DenialReason.MANIFEST_UNKNOWN_TOOL,
        ManifestSubReason.INVALID_DECLARATION,
      );
    }
    if (spec === undefined) {
      return denied(
        `Unknown tool '${tool}' on connector '${connector}'. Tool not found in manifest.`,
        DenialReason.MANIFEST_UNKNOWN_TOOL,
        ManifestSubReason.UNKNOWN_TOOL,
      );
    }

    // 5. Find the best matching scope for this connector
    const grantedPermission = this.#resolveGrantedPermission(grant.scopes, connector);
    if (!grantedPermission) {
      return denied(`No scope grants access to connector '${connector}'.`, DenialReason.TOOL_NOT_GRANTED);
    }

    // 6. Check permission hierarchy
    if (!permissionCovers(grantedPermission, requiredPermission)) {
      return denied(
        `${grantedPermission} scope does not permit ${requiredPermission} operations on ${connector}.`,
        DenialReason.PERMISSION_INSUFFICIENT,
      );
    }

    // 7. The grant's tools list, when it has one, must name the tool.
    if (entry !== undefined && !toolsAuthorizationAllows(entry, tool)) {
      return denied(
        `Grant does not list tool '${tool}' on connector '${connector}'.`,
        DenialReason.TOOL_NOT_GRANTED,
        ToolSubReason.NOT_IN_AUTHORIZATION_DETAILS,
      );
    }

    // 8. Purpose. A tool that declares allowed_purposes needs a grant whose
    //    purpose is known and matches one of them.
    if (spec.allowedPurposes !== undefined) {
      const allowedPurposes = [...spec.allowedPurposes];
      if (purpose === undefined) {
        return denied(
          `Tool '${tool}' on ${connector} is restricted to purposes ${allowedPurposes.join(', ')}; the grant carries no purpose.`,
          DenialReason.PURPOSE_NOT_ALLOWED,
          PurposeSubReason.MISSING,
          { allowed_purposes: allowedPurposes },
        );
      }
      if (!isKnownPurpose(purpose)) {
        return denied(
          `Grant purpose ${JSON.stringify(purpose)} is not in the purpose vocabulary.`,
          DenialReason.PURPOSE_NOT_ALLOWED,
          PurposeSubReason.UNKNOWN_PURPOSE,
          { allowed_purposes: allowedPurposes, purpose },
        );
      }
      if (matchPurpose(allowedPurposes, purpose) === undefined) {
        return denied(
          `Grant purpose '${purpose}' is not allowed for tool '${tool}' on ${connector}; allowed purposes: ${allowedPurposes.join(', ')}.`,
          DenialReason.PURPOSE_NOT_ALLOWED,
          PurposeSubReason.NOT_MATCHED,
          { allowed_purposes: allowedPurposes, purpose },
        );
      }
    }

    // 9. Decision. A tool that requires a decision, in the manifest or in the
    //    grant's decision references, needs decision grants that verify
    //    offline for this exact action; they are consumed at the issuer as the
    //    last step, after caps are reserved. A decision needs two approvers if
    //    either the manifest or the grant says so.
    let decisionSet: DecisionGrantSet | undefined;
    let wouldDeny: WouldDeny | undefined;
    if (spec.requiresDecision || decisionReference?.tools.includes(tool)) {
      const fourEyesOn = [...new Set([...spec.fourEyesOn, ...(decisionReference?.fourEyesOn[tool] ?? [])])];
      const requirement = { decision_required: `${connector}:${tool}` };
      let decisionDenial: WouldDeny | undefined;
      try {
        decisionSet = await this.#verifyDecision(grant, connector, tool, fourEyesOn, spec.decisionFields ?? [], options);
      } catch (err) {
        if (!(err instanceof DecisionGrantError)) throw err;
        decisionDenial = err.subReason === DecisionSubReason.ABSENT
          ? { reason_code: DenialReason.DECISION_REQUIRED, sub_reason: '', reason: `Tool '${tool}' on ${connector} requires a decision grant.`, details: requirement }
          : { reason_code: DenialReason.DECISION_INVALID, sub_reason: err.subReason, reason: `The decision grant for tool '${tool}' on ${connector} is not valid: ${err.message}`, details: requirement };
      }
      if (decisionDenial !== undefined) {
        if (decisionsMode !== 'warn') {
          return denied(
            decisionDenial.reason,
            decisionDenial.reason_code as DenialReason,
            decisionDenial.sub_reason === '' ? undefined : decisionDenial.sub_reason,
            decisionDenial.details,
          );
        }
        wouldDeny = decisionDenial;
      }
    }

    // 10. Check capped amount if provided
    if (amount !== undefined) {
      if (typeof amount !== 'number' || !Number.isFinite(amount)) {
        return denied(
          `Amount must be a finite number to enforce a budget cap on ${connector}.`,
          DenialReason.CAP_EXCEEDED,
          CapSubReason.INVALID_AMOUNT,
        );
      }
      const cap = this.#extractCap(grant.scopes, connector);
      if (cap === 'invalid') {
        return denied(
          `A capped scope on ${connector} carries a malformed cap; refusing to authorize amount ${amount}.`,
          DenialReason.CAP_EXCEEDED,
          CapSubReason.MALFORMED_CAP,
        );
      }
      if (cap !== undefined && amount > cap) {
        return denied(
          `Amount ${amount} exceeds budget cap of ${cap} on ${connector}.`,
          DenialReason.CAP_EXCEEDED,
          CapSubReason.AMOUNT_CAP,
          { limit: cap, amount },
        );
      }
    }

    // 11. Call caps and cost units (declared by the manifest or by the grant).
    //     Reserving is the last step, so a denied call never consumes a cap;
    //     without a meter the call is denied.
    const grantCaps = entry?.caps;
    const grantCapsApply = grantCaps !== undefined
      && (Object.prototype.hasOwnProperty.call(grantCaps, tool)
        || (spec.costUnits !== undefined && Object.prototype.hasOwnProperty.call(grantCaps, 'cost_units')));
    let reservation: Reservation | undefined;
    let capLimits: CapLimit[] = [];
    const capsTenant = capsTenantId ?? grant.developerId;
    if ((spec.caps !== undefined || spec.costUnits !== undefined || grantCapsApply) && capsMode !== 'off') {
      let capDenial: WouldDeny | undefined;
      const meter = this.#capsMeter;
      if (meter === undefined) {
        capDenial = {
          reason_code: DenialReason.CAP_EXCEEDED,
          sub_reason: CapSubReason.METER_UNAVAILABLE,
          reason: `Tool '${tool}' on ${connector} declares caps or cost units and no caps meter is configured.`,
          details: {},
        };
      } else {
        try {
          const buildOptions: BuildCapLimitsOptions = {
            connector,
            tool,
            spec,
            grantId: grant.grantId,
            ...(grantCaps !== undefined ? { grantCaps } : {}),
            ...(caseId !== undefined ? { caseId } : {}),
            ...(costComponents !== undefined ? { costComponents } : {}),
          };
          capLimits = buildCapLimits(buildOptions);
        } catch (err) {
          if (!(err instanceof CapsConfigurationError)) throw err;
          if (err.subReason === MALFORMED_GRANT_CAPS) {
            // A token problem, not a cap decision: denied in every mode.
            return denied(
              `Grant token authorization_details cannot be used: ${err.message}.`,
              DenialReason.TOKEN_INVALID,
              TokenSubReason.MALFORMED_AUTHORIZATION_DETAILS,
            );
          }
          capDenial = {
            reason_code: DenialReason.CAP_EXCEEDED,
            sub_reason: err.subReason,
            reason: `Cannot meter tool '${tool}' on ${connector}: ${err.message}.`,
            details: {},
          };
        }
        if (capDenial === undefined) {
          try {
            if (reserve) {
              reservation = await meter.reserve(capsTenant, capLimits);
            } else {
              await checkCaps(meter, capsTenant, capLimits);
            }
          } catch (err) {
            if (err instanceof CapExceededError) {
              capDenial = {
                reason_code: DenialReason.CAP_EXCEEDED,
                sub_reason: CapSubReason.LIMIT_REACHED,
                reason: `${err.message} on ${connector}.${tool}.`,
                details: {
                  code: err.code,
                  limit: err.limit,
                  window: err.window,
                  used: err.used,
                  requested: err.requested,
                  scope: err.scope,
                  kind: err.kind,
                },
              };
            } else {
              // Any other failure, including an invalid tenant, leaves the call unmetered.
              const message = err instanceof MeterUnavailableError || err instanceof CapsConfigurationError
                ? err.message
                : 'caps meter failed';
              capDenial = {
                reason_code: DenialReason.CAP_EXCEEDED,
                sub_reason: CapSubReason.METER_UNAVAILABLE,
                reason: `Caps meter could not evaluate tool '${tool}' on ${connector}: ${message}.`,
                details: {},
              };
            }
          }
        }
      }
      if (capDenial !== undefined) {
        if (capsMode !== 'warn') {
          return denied(capDenial.reason, capDenial.reason_code as DenialReason, capDenial.sub_reason, capDenial.details);
        }
        wouldDeny ??= capDenial;
      }
    }

    // 12. Consume the decision grants at the issuer. Offline verification
    //     alone never allows a call: one grant authorises one call.
    let decision: ConsumedDecision | undefined;
    if (decisionSet !== undefined) {
      try {
        decision = await this.#decisionConsumer.consume(decisionSet, grant.grantId ? { grantId: grant.grantId } : {});
      } catch (err) {
        const subReason = err instanceof DecisionGrantError ? err.subReason : DecisionSubReason.CONSUME_UNAVAILABLE;
        if (reservation !== undefined && this.#capsMeter !== undefined) {
          await this.#capsMeter.refundUnsent(reservation).catch(() => undefined);
          reservation = undefined;
        }
        const message = `The decision grant for tool '${tool}' on ${connector} was not consumed: ${err instanceof Error ? err.message : 'consumption failed'}`;
        const details = { decision_required: `${connector}:${tool}` };
        if (decisionsMode !== 'warn') return denied(message, DenialReason.DECISION_INVALID, subReason, details);
        wouldDeny ??= { reason_code: DenialReason.DECISION_INVALID, sub_reason: subReason, reason: message, details };
      }
    }

    return {
      ...base,
      allowed: true,
      reason: '',
      ...(purpose !== undefined ? { purpose } : {}),
      ...(reservation !== undefined ? { reservation } : {}),
      ...(capLimits.length > 0 ? { capLimits, capsTenantId: capsTenant } : {}),
      ...(wouldDeny !== undefined ? { wouldDeny } : {}),
      ...(decision !== undefined ? { decision } : {}),
    };
  }

  /** Offline checks of the decision grants for one call (see `enforce`). */
  async #verifyDecision(
    grant: VerifiedGrant,
    connector: string,
    tool: string,
    fourEyesOn: readonly string[],
    decisionFields: readonly string[],
    options: EnforceOptions,
  ): Promise<DecisionGrantSet> {
    const tokens = options.decisionGrants;
    if (tokens === undefined || tokens.length === 0) {
      throw new DecisionGrantError(DecisionSubReason.ABSENT, 'no decision grant was presented');
    }
    let given: DecisionAction | undefined;
    let fromArguments: DecisionAction | undefined;
    try {
      if (options.decisionAction !== undefined) given = parseDecisionAction(options.decisionAction);
      if (options.arguments !== undefined) fromArguments = decisionActionFromToolCall(tool, options.arguments, decisionFields);
    } catch (err) {
      if (err instanceof ActionValidationError) {
        throw new DecisionGrantError(DecisionSubReason.MALFORMED, `the call's action is invalid: ${err.message}`);
      }
      throw err;
    }
    if (given !== undefined && fromArguments !== undefined && computeActionHash(given) !== computeActionHash(fromArguments)) {
      // The call would do something other than what the caller says it approves.
      throw new DecisionGrantError(DecisionSubReason.ACTION_MISMATCH, 'decisionAction does not match the action derived from the call arguments');
    }
    const action = given ?? fromArguments;
    if (action === undefined) {
      throw new DecisionGrantError(DecisionSubReason.MALFORMED, 'enforce() needs decisionAction or arguments to compare the decision grant with');
    }
    const missingFields = decisionFields.filter((name) => action.extra === undefined || !Object.prototype.hasOwnProperty.call(action.extra, name));
    if (missingFields.length > 0) {
      throw new DecisionGrantError(DecisionSubReason.MALFORMED, `the action does not bind the declared decision fields: ${missingFields.join(', ')}`);
    }
    if (action.action !== tool) {
      throw new DecisionGrantError(DecisionSubReason.ACTION_MISMATCH, 'the decision action names another tool');
    }
    if (typeof options.caseVersion !== 'string' || options.caseVersion.length === 0) {
      throw new DecisionGrantError(DecisionSubReason.MALFORMED, 'enforce() needs caseVersion for a decision');
    }
    return verifyDecisionGrants(tokens, action, options.caseVersion, {
      issuer: this.#decisionIssuer(),
      jwksUri: this.#jwksUri,
      developerId: grant.developerId,
      connector,
      approvalsRequired: fourEyesOn.includes(action.decision) ? 2 : 1,
      algorithms: this.#decisionAlgorithms,
    });
  }

  #decisionIssuer(): string {
    if (this.#issuer !== undefined) return this.#issuer;
    const url = new URL(this.#jwksUri);
    if (url.href.replace(/\/$/, '') === 'https://api.grantex.dev/.well-known/jwks.json') return 'https://grantex.dev';
    return url.pathname.endsWith('/.well-known/jwks.json')
      ? `${url.origin}${url.pathname.slice(0, -'/.well-known/jwks.json'.length)}`
      : `${url.origin}${url.pathname.replace(/\/$/, '')}`;
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
  #extractCap(scopes: string[], connector: string): number | 'invalid' | undefined {
    // The tightest cap on the connector wins. Returning the first capped scope
    // encountered let `tool:x:read:capped:1000` shadow `tool:x:write:capped:10`
    // purely by ordering, and a malformed cap (`capped:abc` → NaN) disabled the
    // check entirely because `amount > NaN` is always false.
    let cap: number | undefined;
    for (const scope of scopes) {
      const parts = scope.split(':');
      if ((parts[0] !== 'tool' && parts[0] !== 'agenticorg') || parts[1] !== connector) continue;
      const cappedIdx = parts.indexOf('capped');
      if (cappedIdx === -1) continue;
      const raw = parts[cappedIdx + 1];
      const value = raw !== undefined && /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : Number.NaN;
      if (!Number.isFinite(value) || value < 0) return 'invalid';
      cap = cap === undefined ? value : Math.min(cap, value);
    }
    return cap;
  }

  #applyEnforceMode(result: EnforceResult): EnforceResult {
    if (!result.allowed && this.#enforceMode === 'permissive') {
      if (process.env['NODE_ENV'] !== 'production') {
        console.warn(`[grantex] PERMISSIVE MODE — would deny: ${result.reason} (connector=${result.connector}, tool=${result.tool})`);
      }
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
      const caseId = typeof options.caseId === 'function' ? options.caseId() : options.caseId;
      const costComponents = typeof options.costComponents === 'function' ? options.costComponents() : options.costComponents;
      const decisionGrants = typeof options.decisionGrants === 'function' ? options.decisionGrants() : options.decisionGrants;
      const caseVersion = typeof options.caseVersion === 'function' ? options.caseVersion() : options.caseVersion;
      const input = args[0];
      const callOptions = {
        connector: options.connector,
        tool: options.tool,
        ...(caseId !== undefined ? { caseId } : {}),
        ...(costComponents !== undefined ? { costComponents } : {}),
        ...(decisionGrants !== undefined ? { decisionGrants } : {}),
        ...(caseVersion !== undefined ? { caseVersion } : {}),
        ...(typeof input === 'object' && input !== null && !Array.isArray(input) ? { arguments: input as Record<string, unknown> } : {}),
      };

      let result = await self.enforce({ grantToken: getToken(), ...callOptions });

      // Retry once with refreshed token if expired and grantToken is a getter. An
      // expired token is denied before caps are reserved, so this cannot reserve twice.
      if (!result.allowed && result.reason.includes('expired') && typeof options.grantToken === 'function') {
        result = await self.enforce({ grantToken: getToken(), ...callOptions });
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

      const caseId = options.extractCaseId?.(request);
      const costComponents = options.extractCostComponents?.(request);
      const decisionGrants = options.extractDecisionGrants?.(request);
      const callArguments = options.extractArguments?.(request);
      const caseVersion = options.extractCaseVersion?.(request);
      self.enforce({
        grantToken: token,
        connector,
        tool,
        ...(caseId !== undefined ? { caseId } : {}),
        ...(costComponents !== undefined ? { costComponents } : {}),
        ...(decisionGrants !== undefined ? { decisionGrants } : {}),
        ...(callArguments !== undefined ? { arguments: callArguments } : {}),
        ...(caseVersion !== undefined ? { caseVersion } : {}),
      })
        .then((result) => {
          if (!result.allowed) {
            const statusFn = response['status'] as (code: number) => Record<string, unknown>;
            const jsonFn = statusFn.call(response, 403)['json'] as (body: unknown) => void;
            jsonFn.call(statusFn.call(response, 403), {
              error: {
                code: 'SCOPE_DENIED',
                message: result.reason,
                connector,
                tool,
                ...(result.reasonCode !== undefined ? { reason: result.reasonCode } : {}),
                ...(result.subReason !== undefined ? { subReason: result.subReason } : {}),
              },
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
