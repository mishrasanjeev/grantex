import { verifyGrantToken, type VerifiedGrant } from '@grantex/sdk';
import type { AdapterConfig, AdapterResult, CredentialProvider, AuditLogger } from './types.js';
import { findMatchingScope, type ParsedScope } from './scope-utils.js';
import { GrantexAdapterError } from './errors.js';
import {
  audienceDenial,
  checkAudienceCheck,
  checkExpectedAudience,
  readTokenAudience,
  type AudienceCheck,
} from './audience.js';

export abstract class BaseAdapter {
  protected readonly jwksUri: string;
  protected readonly credentials: CredentialProvider;
  protected readonly auditLogger?: AuditLogger;
  protected readonly clockTolerance?: number;
  protected readonly timeout: number;
  protected readonly audienceCheck: AudienceCheck;
  protected readonly audience: string | undefined;
  private readonly currentAuthority: AdapterConfig['currentAuthority'];
  private readonly expectedPrincipalId: string | undefined;
  private readonly expectedAgentDid: string | undefined;

  constructor(config: AdapterConfig) {
    this.jwksUri = config.jwksUri;
    this.credentials = config.credentials;
    this.currentAuthority = config.currentAuthority;
    this.expectedPrincipalId = config.expectedPrincipalId;
    this.expectedAgentDid = config.expectedAgentDid;
    this.auditLogger = config.auditLogger;
    this.clockTolerance = config.clockTolerance;
    this.timeout = config.timeout ?? 30_000;
    // An invalid audience setting stops the adapter from being created rather
    // than being read as "no audience", which would accept tokens meant elsewhere.
    this.audienceCheck = checkAudienceCheck(config.audienceCheck === undefined ? 'on' : config.audienceCheck);
    this.audience = checkExpectedAudience(config.audience, this.audienceCheck);
    if (this.currentAuthority !== undefined && (typeof this.currentAuthority !== 'function'
      || this.audienceCheck !== 'on' || !this.audience)) {
      throw new Error('Current authority verification requires a callback, audience and audienceCheck on');
    }
  }

  /**
   * Verifies the token and checks `requiredScope`.
   *
   * Core Grantex semantics are exact-match: a constrained grant such as
   * `payments:initiate:max_500` does NOT satisfy a bare `payments:initiate`
   * requirement. Adapters that can enforce the constraint themselves (Stripe
   * enforces `max_N` against the amount) opt in with `enforcesConstraint: true`
   * and receive the parsed constraint; every other caller gets a
   * `CONSTRAINT_VIOLATED` error instead of silently ignoring the limit.
   *
   * The token's audience is checked right after its signature, with the same
   * semantics as the SDKs' `enforce()` (RFC 7519 section 4.1.3):
   * `AUDIENCE_MISMATCH` when its `aud` does not contain the configured
   * `audience` (or it has none), `AUDIENCE_UNCONFIGURED` when it carries `aud`
   * and no audience is configured. `audienceCheck: 'off'` skips the check.
   */
  protected async verifyAndCheckScope(
    token: string,
    requiredScope: string,
    options: { enforcesConstraint?: boolean } = {},
  ): Promise<{ grant: VerifiedGrant; matchedScope: ParsedScope }> {
    let grant: VerifiedGrant;
    try {
      grant = await verifyGrantToken(token, {
        jwksUri: this.jwksUri,
        ...(this.currentAuthority !== undefined ? { currentAuthority: this.currentAuthority } : {}),
        ...(this.currentAuthority !== undefined && this.audience !== undefined ? { audience: this.audience } : {}),
        ...(this.expectedPrincipalId !== undefined ? { expectedPrincipalId: this.expectedPrincipalId } : {}),
        ...(this.expectedAgentDid !== undefined ? { expectedAgentDid: this.expectedAgentDid } : {}),
        ...(this.clockTolerance !== undefined ? { clockTolerance: this.clockTolerance } : {}),
      });
    } catch {
      throw new GrantexAdapterError('TOKEN_INVALID', 'Grant token verification failed');
    }

    if (this.audienceCheck === 'on') {
      let tokenAudience: string[] | undefined;
      try {
        tokenAudience = readTokenAudience(token);
      } catch {
        // Fail closed: a token whose audience cannot be read may be meant for
        // another relying party.
        throw new GrantexAdapterError('TOKEN_INVALID', 'Grant token audience cannot be read');
      }
      const denial = audienceDenial(tokenAudience, this.audience);
      if (denial === 'AUDIENCE_UNCONFIGURED') {
        throw new GrantexAdapterError(
          denial,
          'The grant token is for a specific audience and this adapter has no audience configured',
        );
      }
      if (denial === 'AUDIENCE_MISMATCH') {
        throw new GrantexAdapterError(denial, 'The grant token audience does not include the configured audience');
      }
    }

    const matchedScope = findMatchingScope(grant.scopes, requiredScope);
    if (!matchedScope) {
      throw new GrantexAdapterError(
        'SCOPE_MISSING',
        `Grant does not include required scope: ${requiredScope}`,
      );
    }
    if (matchedScope.constraint && options.enforcesConstraint !== true) {
      throw new GrantexAdapterError(
        'CONSTRAINT_VIOLATED',
        `Grant scope ${requiredScope} carries a constraint this adapter cannot enforce`,
      );
    }

    return { grant, matchedScope };
  }

  protected async resolveCredential(): Promise<string> {
    try {
      if (typeof this.credentials === 'string') {
        return this.credentials;
      }
      return await this.credentials();
    } catch {
      throw new GrantexAdapterError('CREDENTIAL_ERROR', 'Failed to resolve credentials');
    }
  }

  protected async logAudit(
    grant: VerifiedGrant,
    action: string,
    status: 'success' | 'failure' | 'blocked',
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.auditLogger) return;
    try {
      await this.auditLogger({
        agentId: grant.agentDid,
        agentDid: grant.agentDid,
        grantId: grant.grantId,
        principalId: grant.principalId,
        action,
        status,
        ...(metadata !== undefined ? { metadata } : {}),
      });
    } catch {
      // Audit logging is best-effort
    }
  }

  protected async callUpstream<T>(
    url: string,
    options: RequestInit,
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new GrantexAdapterError(
          'UPSTREAM_ERROR',
          `Upstream API returned ${response.status}: ${body}`,
        );
      }

      return (await response.json()) as T;
    } catch (err) {
      if (err instanceof GrantexAdapterError) throw err;
      throw new GrantexAdapterError(
        'UPSTREAM_ERROR',
        `Upstream request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  protected wrapResult<T>(
    grant: VerifiedGrant,
    data: T,
  ): AdapterResult<T> {
    return { success: true, data, grant };
  }

  protected wrapError(
    grant: VerifiedGrant,
    error: string,
  ): AdapterResult {
    return { success: false, error, grant };
  }
}
