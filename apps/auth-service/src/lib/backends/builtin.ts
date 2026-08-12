/**
 * Built-in policy backend — wraps the existing evaluatePolicies() function.
 *
 * Queries policies from the database and evaluates them using the
 * priority-ordered first-match-wins algorithm.
 */

import { getSql } from '../../db/client.js';
import { findMatchingPolicy, type PolicyRow } from '../policy.js';
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

    // Take the matched policy itself, not just its effect: the decision has to
    // name the policy that actually decided it. Re-deriving the id by grabbing
    // the first row attributed every decision to the highest-priority policy,
    // regardless of which one matched.
    const matchingPolicy = findMatchingPolicy(policyRows, {
      agentId: ctx.agentId,
      principalId: ctx.principalId,
      scopes: ctx.scopes,
      ...(ctx.time !== undefined ? { nowUtcHHMM: ctx.time } : {}),
    });

    if (matchingPolicy === null) return { effect: null };

    return {
      effect: matchingPolicy.effect,
      policyId: matchingPolicy.id,
    };
  }
}
