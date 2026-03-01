import { verifyGrantToken, type VerifiedGrant } from '@grantex/sdk';
import type { AdapterConfig, AdapterResult, CredentialProvider, AuditLogger } from './types.js';
import { findMatchingScope, type ParsedScope } from './scope-utils.js';
import { GrantexAdapterError } from './errors.js';

export abstract class BaseAdapter {
  protected readonly jwksUri: string;
  protected readonly credentials: CredentialProvider;
  protected readonly auditLogger?: AuditLogger;
  protected readonly clockTolerance?: number;
  protected readonly timeout: number;

  constructor(config: AdapterConfig) {
    this.jwksUri = config.jwksUri;
    this.credentials = config.credentials;
    this.auditLogger = config.auditLogger;
    this.clockTolerance = config.clockTolerance;
    this.timeout = config.timeout ?? 30_000;
  }

  protected async verifyAndCheckScope(
    token: string,
    requiredScope: string,
  ): Promise<{ grant: VerifiedGrant; matchedScope: ParsedScope }> {
    let grant: VerifiedGrant;
    try {
      grant = await verifyGrantToken(token, {
        jwksUri: this.jwksUri,
        ...(this.clockTolerance !== undefined ? { clockTolerance: this.clockTolerance } : {}),
      });
    } catch {
      throw new GrantexAdapterError('TOKEN_INVALID', 'Grant token verification failed');
    }

    const matchedScope = findMatchingScope(grant.scopes, requiredScope);
    if (!matchedScope) {
      throw new GrantexAdapterError(
        'SCOPE_MISSING',
        `Grant does not include required scope: ${requiredScope}`,
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
        grantId: grant.grantId,
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
