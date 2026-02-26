/**
 * Policy evaluation logic.
 *
 * Policies are evaluated highest-priority first. The first matching policy
 * wins. If no policy matches, the caller continues with the normal consent
 * flow.
 */

export interface PolicyRow {
  id: string;
  effect: 'allow' | 'deny';
  priority: number;
  agent_id: string | null;
  principal_id: string | null;
  scopes: string[] | null;
  time_of_day_start: string | null;
  time_of_day_end: string | null;
}

export interface PolicyContext {
  agentId: string;
  principalId: string;
  scopes: string[];
  /** Current UTC time as "HH:MM" — injectable for testing. */
  nowUtcHHMM?: string;
}

/**
 * Return the effect of the first matching policy, or `null` if none match.
 *
 * Policies must be provided in priority order (highest first).
 */
export function evaluatePolicies(
  policies: PolicyRow[],
  ctx: PolicyContext,
): 'allow' | 'deny' | null {
  const time = ctx.nowUtcHHMM ?? utcHHMM(new Date());

  for (const policy of policies) {
    if (!matchesPolicy(policy, ctx, time)) continue;
    return policy.effect;
  }

  return null;
}

function matchesPolicy(
  policy: PolicyRow,
  ctx: PolicyContext,
  nowHHMM: string,
): boolean {
  // Agent condition
  if (policy.agent_id !== null && policy.agent_id !== ctx.agentId) return false;

  // Principal condition
  if (policy.principal_id !== null && policy.principal_id !== ctx.principalId)
    return false;

  // Scope condition: all requested scopes must be covered by the policy's scopes
  if (policy.scopes !== null) {
    const allowed = new Set(policy.scopes);
    if (!ctx.scopes.every((s) => allowed.has(s))) return false;
  }

  // Time-of-day condition
  if (policy.time_of_day_start !== null && policy.time_of_day_end !== null) {
    if (!isInTimeWindow(nowHHMM, policy.time_of_day_start, policy.time_of_day_end))
      return false;
  }

  return true;
}

/** Returns true if `now` is within [start, end) (handles midnight wrap). */
function isInTimeWindow(now: string, start: string, end: string): boolean {
  if (start <= end) {
    return now >= start && now < end;
  }
  // Wraps midnight: e.g. start=22:00, end=06:00
  return now >= start || now < end;
}

function utcHHMM(date: Date): string {
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
