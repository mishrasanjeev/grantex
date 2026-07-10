/**
 * AWS Cedar policy backend.
 *
 * Sends policy evaluation context to a Cedar authorization service
 * and maps the response to a PolicyDecision.
 */

import type { PolicyBackend, PolicyEvalContext, PolicyDecision } from '../policy-backend.js';
import { BuiltinBackend } from './builtin.js';
import { safeFetch } from '../url-security.js';

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

  private async backendFailure(ctx: PolicyEvalContext, reason: string): Promise<PolicyDecision> {
    if (this.fallbackToBuiltin) return this.fallbackBackend.evaluate(ctx);
    return { effect: 'deny', reason };
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
      response = await safeFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(5000),
      }, {
        // Cedar authorization services are often private HTTP services.
        // safeFetch still prevents redirects/rebinding and caps the response.
        allowedProtocols: ['https:', 'http:'],
        allowInsecureHttp: true,
        allowPrivateHosts: true,
      });
    } catch {
      return this.backendFailure(ctx, 'Cedar unavailable');
    }

    if (!response.ok) {
      return this.backendFailure(ctx, `Cedar returned ${response.status}`);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return this.backendFailure(ctx, 'Cedar returned invalid JSON');
    }
    if (typeof data !== 'object' || data === null) {
      return this.backendFailure(ctx, 'Cedar returned an invalid decision');
    }
    const decision = (data as { decision?: unknown }).decision;
    if (decision !== 'Allow' && decision !== 'Deny') {
      return this.backendFailure(ctx, 'Cedar returned an invalid decision');
    }
    const diagnostics = (data as CedarResponse).diagnostics;
    const reasons = Array.isArray(diagnostics?.reason)
      ? diagnostics.reason.filter((reason): reason is string => typeof reason === 'string')
      : [];

    return {
      effect: decision === 'Allow' ? 'allow' : 'deny',
      ...(reasons.length
        ? { reason: reasons.join('; ') }
        : {}),
    };
  }
}
