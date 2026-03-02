/**
 * Pluggable policy backend abstraction.
 *
 * Allows the auth service to dispatch policy evaluation to built-in logic,
 * OPA, or Cedar backends via a strategy pattern.
 */

import { config } from '../config.js';
import { BuiltinBackend } from './backends/builtin.js';
import { OpaBackend } from './backends/opa.js';
import { CedarBackend } from './backends/cedar.js';

export interface PolicyEvalContext {
  agentId: string;
  principalId: string;
  scopes: string[];
  developerId: string;
  /** Current UTC time as "HH:MM" — injectable for testing. */
  time?: string;
  grant?: { id: string; delegationDepth?: number };
  request?: { ip: string; userAgent: string };
}

export interface PolicyDecision {
  effect: 'allow' | 'deny' | null;
  reason?: string;
  policyId?: string;
}

export interface PolicyBackend {
  evaluate(ctx: PolicyEvalContext): Promise<PolicyDecision>;
}

let backend: PolicyBackend | null = null;

export function getPolicyBackend(): PolicyBackend {
  if (backend) return backend;

  switch (config.policyBackend) {
    case 'opa':
      backend = new OpaBackend(config.opaUrl!, config.opaFallbackToBuiltin);
      break;
    case 'cedar':
      backend = new CedarBackend(config.cedarUrl!, config.cedarFallbackToBuiltin);
      break;
    default:
      backend = new BuiltinBackend();
  }

  return backend;
}

/** Reset the singleton — used for testing. */
export function resetPolicyBackend(): void {
  backend = null;
}
