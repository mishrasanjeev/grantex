/**
 * OPA (Open Policy Agent) backend.
 *
 * Sends policy evaluation context to an OPA server via its Data API
 * and maps the response to a PolicyDecision.
 */

import type { PolicyBackend, PolicyEvalContext, PolicyDecision } from '../policy-backend.js';
import { BuiltinBackend } from './builtin.js';

export class OpaBackend implements PolicyBackend {
  private readonly url: string;
  private readonly fallbackToBuiltin: boolean;
  private readonly fallbackBackend: BuiltinBackend;

  constructor(url: string, fallbackToBuiltin = true) {
    this.url = url.replace(/\/$/, '');
    this.fallbackToBuiltin = fallbackToBuiltin;
    this.fallbackBackend = new BuiltinBackend();
  }

  async evaluate(ctx: PolicyEvalContext): Promise<PolicyDecision> {
    const endpoint = `${this.url}/v1/data/grantex/authz`;

    const body = JSON.stringify({
      input: {
        agent_id: ctx.agentId,
        principal_id: ctx.principalId,
        scopes: ctx.scopes,
        developer_id: ctx.developerId,
        time: ctx.time,
        ...(ctx.grant !== undefined ? { grant: ctx.grant } : {}),
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
      return { effect: null, reason: 'OPA unavailable' };
    }

    if (!response.ok) {
      if (this.fallbackToBuiltin) {
        return this.fallbackBackend.evaluate(ctx);
      }
      return { effect: null, reason: `OPA returned ${response.status}` };
    }

    const data = await response.json() as { result?: { allow?: boolean; reason?: string } };
    const result = data.result;

    if (!result || result.allow === undefined) {
      return { effect: null };
    }

    return {
      effect: result.allow ? 'allow' : 'deny',
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
    };
  }
}
