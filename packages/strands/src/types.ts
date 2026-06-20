import type { ToolContext, JSONValue } from '@strands-agents/sdk';
import type { EnforceOptions, EnforceResult, VerifyGrantTokenOptions } from '@grantex/sdk';
import type { z } from 'zod';

export interface GrantexEnforcer {
  enforce(options: EnforceOptions): Promise<EnforceResult>;
}

export interface CreateGrantexToolOptions<
  INPUT extends z.ZodType,
  RESULT extends JSONValue = JSONValue,
> {
  /** Tool name shown to the model. */
  name: string;
  /** Human-readable tool description. */
  description: string;
  /** Zod schema for tool input. */
  inputSchema: INPUT;
  /** Grantex grant token obtained from the token exchange. */
  grantToken: string;
  /** Scope the agent must hold to invoke this tool. */
  requiredScope: string;
  /** Tool implementation. */
  callback: (input: z.infer<INPUT>, context?: ToolContext) => Promise<RESULT> | RESULT;
  /** JWKS URL used to verify the grant token. Defaults to https://api.grantex.dev/.well-known/jwks.json. */
  jwksUri?: string;
  /** Expected JWT issuer when it differs from the JWKS origin. */
  issuer?: string;
  /** did:web issuer used to derive the JWKS URL. */
  issuerDid?: string;
  /** Expected JWT audience. */
  audience?: string;
  /** Clock tolerance in seconds for token verification. */
  clockTolerance?: number;
  /** Grantex client instance for online manifest enforcement. */
  client?: GrantexEnforcer;
  /** Connector name for online manifest enforcement. */
  connector?: string;
  /** Use client.enforce() instead of JWKS-backed local verification. */
  online?: boolean;
  /** Optional amount for capped online enforcement. */
  amount?: number;
}

export type GrantexVerifyOptions = Pick<
  VerifyGrantTokenOptions,
  'jwksUri' | 'issuer' | 'issuerDid' | 'audience' | 'clockTolerance'
>;

export class GrantexScopeError extends Error {
  readonly requiredScope: string;
  readonly grantedScopes: string[];
  readonly reason?: string;

  constructor(requiredScope: string, grantedScopes: string[], reason?: string) {
    super(
      `Grantex: grant token is missing required scope '${requiredScope}'. ` +
        `Granted scopes: ${grantedScopes.join(', ') || 'none'}.` +
        (reason ? ` Reason: ${reason}` : ''),
    );
    this.name = 'GrantexScopeError';
    this.requiredScope = requiredScope;
    this.grantedScopes = grantedScopes;
    if (reason !== undefined) {
      this.reason = reason;
    }
  }
}
