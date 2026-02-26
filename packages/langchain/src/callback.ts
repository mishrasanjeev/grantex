import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { Grantex } from '@grantex/sdk';
import { decodeJwtPayload } from './_jwt.js';

export interface GrantexAuditHandlerOptions {
  /** Authenticated Grantex SDK client. */
  client: Grantex;
  /** The Grantex agent ID (e.g. `ag_01XYZ`) to attribute audit entries to. */
  agentId: string;
  /** Grantex grant token — the grantId is decoded from the `grnt` (or `jti`) claim. */
  grantToken: string;
}

/**
 * LangChain callback handler that writes tool invocations to the Grantex audit trail.
 *
 * Attach it to any chain, agent, or tool executor via the `callbacks` option.
 *
 * @example
 * ```ts
 * const handler = new GrantexAuditHandler({
 *   client: grantex,
 *   agentId: myAgent.id,
 *   grantToken: tokenResponse.grantToken,
 * });
 *
 * const executor = new AgentExecutor({ agent, tools, callbacks: [handler] });
 * ```
 */
export class GrantexAuditHandler extends BaseCallbackHandler {
  name = 'GrantexAuditHandler' as const;

  readonly #client: Grantex;
  readonly #agentId: string;
  readonly #grantId: string;

  constructor(options: GrantexAuditHandlerOptions) {
    super();
    this.#client = options.client;
    this.#agentId = options.agentId;

    const payload = decodeJwtPayload(options.grantToken);
    const grantId = payload['grnt'] ?? payload['jti'];
    if (typeof grantId !== 'string') {
      throw new Error(
        'Grantex: grantToken does not contain a valid grantId (expected grnt or jti claim)',
      );
    }
    this.#grantId = grantId;
  }

  /**
   * Fires when a tool is invoked. Logs the action with `status: 'success'`
   * to indicate the agent successfully initiated the tool call.
   */
  override async handleToolStart(
    tool: { name?: string },
    input: string,
  ): Promise<void> {
    const toolName = tool.name ?? 'unknown';
    await this.#client.audit.log({
      agentId: this.#agentId,
      grantId: this.#grantId,
      action: `tool:${toolName}`,
      metadata: { input },
      status: 'success' as const,
    });
  }

  /**
   * Fires when a tool throws an error. Logs the failure to the audit trail.
   */
  override async handleToolError(err: Error): Promise<void> {
    await this.#client.audit.log({
      agentId: this.#agentId,
      grantId: this.#grantId,
      action: 'tool:error',
      metadata: { error: err.message },
      status: 'failure' as const,
    });
  }
}
