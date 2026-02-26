import type { z } from 'zod';
import type { ToolExecutionOptions } from 'ai';

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
  /** The scope that must be present in the grant token's `scp` claim. */
  requiredScope: string;
  /** The tool implementation — receives the validated Zod-parsed args. */
  execute: (
    args: z.infer<PARAMETERS>,
    options: ToolExecutionOptions,
  ) => Promise<RESULT>;
}

// ─── withAuditLogging options ─────────────────────────────────────────────────

export interface AuditLoggingOptions {
  /** Grantex agent ID to record in audit entries. */
  agentId: string;
  /** Grant ID associated with tool invocations. */
  grantId: string;
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
