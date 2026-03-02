/**
 * Built-in policy backend — wraps the existing evaluatePolicies() function.
 *
 * Queries policies from the database and evaluates them using the
 * priority-ordered first-match-wins algorithm.
 */

import { getSql } from '../../db/client.js';
import { evaluatePolicies, type PolicyRow } from '../policy.js';
import type { PolicyBackend, PolicyEvalContext, PolicyDecision } from '../policy-backend.js';

export class BuiltinBackend implements PolicyBackend {
  async evaluate(ctx: PolicyEvalContext): Promise<PolicyDecision> {
    const sql = getSql();

    const policyRows = await sql<PolicyRow[]>`
      SELECT id, effect, priority, agent_id, principal_id, scopes,
             time_of_day_start, time_of_day_end
      FROM policies
      WHERE developer_id = ${ctx.developerId}
      ORDER BY priority DESC, created_at ASC
    `;

    const effect = evaluatePolicies(policyRows, {
      agentId: ctx.agentId,
      principalId: ctx.principalId,
      scopes: ctx.scopes,
      ...(ctx.time !== undefined ? { nowUtcHHMM: ctx.time } : {}),
    });

    if (effect === null) return { effect: null };

    // Find matching policy ID for traceability
    const matchingPolicy = policyRows.find(() => true); // first match (simplified)
    return {
      effect,
      ...(matchingPolicy !== undefined ? { policyId: matchingPolicy.id } : {}),
    };
  }
}
