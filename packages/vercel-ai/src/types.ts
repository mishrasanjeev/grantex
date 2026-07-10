import type { Tool } from 'ai';
import type { z } from 'zod';

/** Tool execution context inferred from the installed AI SDK version. */
export type GrantexToolExecutionOptions = NonNullable<Tool<unknown, unknown>['execute']> extends (
  input: unknown,
  options: infer OPTIONS,
) => unknown
  ? Partial<OPTIONS>
  : never;

// ─── createGrantexTool options ────────────────────────────────────────────────

export interface CreateGrantexToolOptions<
  PARAMETERS extends z.ZodTypeAny,
  RESULT,
> {
  /**
   * The name of the tool. Used as the action label in audit log entries
   * (e.g. `"tool:fetch_data"`). Typically matches the key you use in the
   * Vercel AI `tools` map.
   */
  name: string;
  /** Human-readable description shown to the language model. */
  description: string;
  /** Zod schema describing the tool's input parameters. */
  parameters: PARAMETERS;
  /**
   * A Grantex grant token (JWT). The token is decoded offline to verify
   * that `requiredScope` appears in its `scp` claim. Throws
   * {@link GrantexScopeError} at construction time if the scope is missing.
   */
  grantToken: string;
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
  /** The scope that must be present in the grant token's `scp` claim. */
  requiredScope: string;
  /** The tool implementation — receives the validated Zod-parsed args. */
  execute: (
    args: z.infer<PARAMETERS>,
    options: GrantexToolExecutionOptions,
  ) => PromiseLike<RESULT>;
}

// ─── withAuditLogging options ─────────────────────────────────────────────────

export interface AuditLoggingOptions {
  /** Grantex agent ID to record in audit entries. */
  agentId: string;
  /** Agent DID (e.g. `'did:key:z6Mk...'`). */
  agentDid: string;
  /** Grant ID associated with tool invocations. */
  grantId: string;
  /** Principal ID that granted authorization. */
  principalId: string;
  /**
   * The tool name used as the audit action label
   * (e.g. `"tool:fetch_data"`). Inferred from the tool's `_grantexName`
   * metadata when omitted.
   */
  toolName?: string;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class GrantexScopeError extends Error {
  readonly requiredScope: string;
  readonly grantedScopes: string[];

  constructor(requiredScope: string, grantedScopes: string[]) {
    super(
      `Grantex: grant token is missing required scope '${requiredScope}'. ` +
        `Granted scopes: [${grantedScopes.join(', ')}]`,
    );
    this.name = 'GrantexScopeError';
    this.requiredScope = requiredScope;
    this.grantedScopes = grantedScopes;
  }
}
