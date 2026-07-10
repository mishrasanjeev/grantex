/**
 * OPA (Open Policy Agent) backend.
 *
 * Sends policy evaluation context to an OPA server via its Data API
 * and maps the response to a PolicyDecision.
 */

import type { PolicyBackend, PolicyEvalContext, PolicyDecision } from '../policy-backend.js';
import { BuiltinBackend } from './builtin.js';
import { safeFetch } from '../url-security.js';

export class OpaBackend implements PolicyBackend {
  private readonly url: string;
  private readonly fallbackToBuiltin: boolean;
  private readonly fallbackBackend: BuiltinBackend;

  constructor(url: string, fallbackToBuiltin = true) {
    this.url = url.replace(/\/$/, '');
    this.fallbackToBuiltin = fallbackToBuiltin;
    this.fallbackBackend = new BuiltinBackend();
  }

  private async backendFailure(ctx: PolicyEvalContext, reason: string): Promise<PolicyDecision> {
    if (this.fallbackToBuiltin) return this.fallbackBackend.evaluate(ctx);
    // An unavailable or malformed PDP must not silently fall through to the
    // end-user consent flow. External-policy failures are fail-closed unless
    // the operator explicitly selected the built-in fallback.
    return { effect: 'deny', reason };
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
      response = await safeFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(5000),
      }, {
        // OPA commonly runs as an internal HTTP sidecar/service. safeFetch is
        // still used for DNS pinning, redirect refusal, and response limits.
        allowedProtocols: ['https:', 'http:'],
        allowInsecureHttp: true,
        allowPrivateHosts: true,
      });
    } catch {
      return this.backendFailure(ctx, 'OPA unavailable');
    }

    if (!response.ok) {
      return this.backendFailure(ctx, `OPA returned ${response.status}`);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return this.backendFailure(ctx, 'OPA returned invalid JSON');
    }

    if (typeof data !== 'object' || data === null) {
      return this.backendFailure(ctx, 'OPA returned an invalid decision');
    }
    const result = (data as { result?: unknown }).result;

    if (result === undefined) {
      return { effect: null };
    }
    if (typeof result !== 'object' || result === null) {
      return this.backendFailure(ctx, 'OPA returned an invalid decision');
    }
    const allow = (result as { allow?: unknown }).allow;
    if (allow === undefined) return { effect: null };
    if (typeof allow !== 'boolean') {
      return this.backendFailure(ctx, 'OPA returned a non-boolean decision');
    }
    const reason = (result as { reason?: unknown }).reason;

    return {
      effect: allow ? 'allow' : 'deny',
      ...(typeof reason === 'string' ? { reason } : {}),
    };
  }
}
