/**
 * AWS Cedar policy backend.
 *
 * Sends policy evaluation context to a Cedar authorization service
 * and maps the response to a PolicyDecision.
 */

import type { PolicyBackend, PolicyEvalContext, PolicyDecision } from '../policy-backend.js';
import { BuiltinBackend } from './builtin.js';

interface CedarResponse {
  decision: 'Allow' | 'Deny';
  diagnostics?: {
    reason?: string[];
    errors?: string[];
  };
}

export class CedarBackend implements PolicyBackend {
  private readonly url: string;
  private readonly fallbackToBuiltin: boolean;
  private readonly fallbackBackend: BuiltinBackend;

  constructor(url: string, fallbackToBuiltin = true) {
    this.url = url.replace(/\/$/, '');
    this.fallbackToBuiltin = fallbackToBuiltin;
    this.fallbackBackend = new BuiltinBackend();
  }

  async evaluate(ctx: PolicyEvalContext): Promise<PolicyDecision> {
    const endpoint = `${this.url}/v1/is_authorized`;

    const body = JSON.stringify({
      principal: {
        type: 'Grantex::Agent',
        id: ctx.agentId,
      },
      action: {
        type: 'Grantex::Action',
        id: 'authorize',
      },
      resource: {
        type: 'Grantex::Grant',
        id: ctx.grant?.id ?? 'pending',
      },
      context: {
        principalId: ctx.principalId,
        scopes: ctx.scopes,
        developerId: ctx.developerId,
        ...(ctx.time !== undefined ? { time: ctx.time } : {}),
        ...(ctx.grant?.delegationDepth !== undefined
          ? { delegationDepth: ctx.grant.delegationDepth }
          : {}),
        ...(ctx.request !== undefined ? { request: ctx.request } : {}),
      },
    });

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      if (this.fallbackToBuiltin) {
        return this.fallbackBackend.evaluate(ctx);
      }
      return { effect: null, reason: 'Cedar unavailable' };
    }

    if (!response.ok) {
      if (this.fallbackToBuiltin) {
        return this.fallbackBackend.evaluate(ctx);
      }
      return { effect: null, reason: `Cedar returned ${response.status}` };
    }

    const data = await response.json() as CedarResponse;

    return {
      effect: data.decision === 'Allow' ? 'allow' : 'deny',
      ...(data.diagnostics?.reason?.length
        ? { reason: data.diagnostics.reason.join('; ') }
        : {}),
    };
  }
}
