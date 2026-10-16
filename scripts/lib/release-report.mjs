// SPDX-License-Identifier: Apache-2.0

function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid release report count');
  return Number(value);
}

function latency(value) {
  if (!Number.isFinite(value) || value < 0) throw new Error('Invalid release report latency');
  return Number(value);
}

export function releaseLoopbackUrl(value) {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Release rehearsals require an explicit loopback HTTP origin');
  }
  return url.origin;
}

export function emergencyStopReport({ runId, agents, budgetMs, stop, liveBefore, latencies }) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(runId)
    || stop.status !== 'completed' || stop.lockout !== false
    || !Array.isArray(stop.agentsStopped) || !Array.isArray(latencies) || latencies.length === 0) {
    throw new Error('Invalid emergency stop report');
  }
  const measurements = latencies.map(latency);
  return {
    run_id: runId,
    agents: agents.map((agent) => ({
      name: agent.name, mode: agent.mode, depth: count(agent.depth),
      allowed_calls_before_stop: count(agent.allowedCalls),
    })),
    budget_ms: latency(budgetMs),
    status: 'completed',
    sweeps: count(stop.sweeps),
    live_grants_before: count(liveBefore),
    grants_revoked: count(stop.grantsRevoked),
    agents_stopped: stop.agentsStopped.length,
    max_ms: Math.max(...measurements),
    latencies_ms: measurements,
    lockout: false,
  };
}
