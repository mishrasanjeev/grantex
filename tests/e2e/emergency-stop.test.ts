/**
 * Release test for the emergency stop (PRD G-6, US-5): agents running under a
 * grant tree are all halted by one call, and each one's next tool call is
 * denied within two seconds.
 *
 * It runs against a real auth service with Postgres and Redis behind it (see
 * scripts/revocation-release-test.sh), never against production: the base URL
 * must be given explicitly.
 *
 *   REVOCATION_RELEASE_BASE_URL=http://127.0.0.1:3199 \
 *   npx vitest run tests/e2e/emergency-stop.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { Grantex, ToolManifest, Permission, DenialReason, RevocationSubReason } from '@grantex/sdk';

const BASE_URL = process.env['REVOCATION_RELEASE_BASE_URL'];
const AGENTS = Number(process.env['EMERGENCY_STOP_AGENTS'] ?? '4');
const BUDGET_MS = Number(process.env['REVOCATION_RELEASE_BUDGET_MS'] ?? '2000');
const REPORT = process.env['EMERGENCY_STOP_REPORT'];
const describeRelease = BASE_URL ? describe : describe.skip;

const manifest = new ToolManifest({
  connector: 'acme_kyb',
  tools: { resolve_business: Permission.READ },
});

interface SimulatedAgent {
  name: string;
  client: Grantex;
  token: string;
  allowedCalls: number;
  deniedAt: number | null;
  denial: { reasonCode?: string; subReason?: string } | null;
  loop: Promise<void> | null;
}

let admin: Grantex;
let apiKey: string;
let developerId: string;
const agents: SimulatedAgent[] = [];
let running = true;

async function approve(authRequestId: string): Promise<string> {
  const response = await fetch(`${BASE_URL}/v1/authorize/${authRequestId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: '{}',
  });
  if (!response.ok) throw new Error(`approve failed: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { code: string }).code;
}

/** One agent's run loop: call the tool until it is refused. */
function runAgent(agent: SimulatedAgent): Promise<void> {
  return (async () => {
    while (running && agent.deniedAt === null) {
      const result = await agent.client.enforce({
        grantToken: agent.token,
        connector: 'acme_kyb',
        tool: 'resolve_business',
      });
      if (result.allowed) {
        agent.allowedCalls += 1;
      } else {
        agent.deniedAt = Date.now();
        agent.denial = { ...(result.reasonCode !== undefined ? { reasonCode: result.reasonCode } : {}),
          ...(result.subReason !== undefined ? { subReason: result.subReason } : {}) };
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  })();
}

describeRelease('the emergency stop halts every agent under a grant tree', () => {
  beforeAll(async () => {
    const account = await Grantex.signup(
      { name: `emergency-stop-${Date.now()}`, mode: 'sandbox' },
      { baseUrl: BASE_URL! },
    );
    apiKey = account.apiKey;
    developerId = account.developerId;
    admin = new Grantex({ apiKey, baseUrl: BASE_URL! });

    const scopes = ['tool:acme_kyb:read'];
    const root = await admin.agents.register({ name: `stop-root-${Date.now()}`, scopes });
    const auth = await admin.authorize({ agentId: root.agentId, userId: `stop-user-${Date.now()}`, scopes });
    const code = 'code' in auth && typeof (auth as unknown as Record<string, unknown>)['code'] === 'string'
      ? (auth as unknown as Record<string, unknown>)['code'] as string
      : await approve(auth.authRequestId);
    const rootGrant = await admin.tokens.exchange({ code, agentId: root.agentId });

    for (let index = 0; index < AGENTS; index += 1) {
      const sub = await admin.agents.register({ name: `stop-agent-${index}-${Date.now()}`, scopes });
      const delegated = await admin.grants.delegate({
        parentGrantToken: rootGrant.grantToken,
        subAgentId: sub.agentId,
        scopes,
        expiresIn: '1h',
      });
      // Each simulated agent is its own process as far as the feed is
      // concerned: its own client, its own stream.
      const client = new Grantex({
        apiKey,
        baseUrl: BASE_URL!,
        issuer: process.env['REVOCATION_RELEASE_ISSUER'] ?? BASE_URL!,
        revocationCheck: 'feed',
        revocationFeed: { staleAfterMs: 5_000 },
      });
      client.loadManifest(manifest);
      expect(await client.revocationFeed().ready(10_000)).toBe(true);
      agents.push({
        name: `agent-${index}`,
        client,
        token: delegated.grantToken,
        allowedCalls: 0,
        deniedAt: null,
        denial: null,
        loop: null,
      });
    }
  }, 300_000);

  afterAll(async () => {
    running = false;
    await Promise.allSettled(agents.map((agent) => agent.loop));
    await Promise.allSettled(agents.map((agent) => agent.client.stopRevocationFeed()));
  });

  it('denies every running agent within two seconds of one call', async () => {
    for (const agent of agents) agent.loop = runAgent(agent);

    // Let every agent get through a few calls first: the stop has to change
    // something that was working.
    const warmupDeadline = Date.now() + 15_000;
    while (Date.now() < warmupDeadline && agents.some((agent) => agent.allowedCalls < 2)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(agents.every((agent) => agent.allowedCalls >= 2), 'every agent should be running before the stop').toBe(true);
    expect(agents.every((agent) => agent.deniedAt === null)).toBe(true);

    const stopAt = Date.now();
    const response = await fetch(`${BASE_URL}/v1/emergency-stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        scope: { type: 'developer', id: developerId },
        reason: 'release rehearsal of the emergency stop',
        confirm: `stop developer:${developerId}`,
      }),
    });
    const responseText = await response.text();
    expect(response.status, responseText).toBe(200);
    const stop = JSON.parse(responseText) as { stopId: string; grantsRevoked: number; agentsStopped: string[] };
    expect(stop.grantsRevoked).toBeGreaterThanOrEqual(AGENTS);

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && agents.some((agent) => agent.deniedAt === null)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    running = false;
    await Promise.allSettled(agents.map((agent) => agent.loop));

    const latencies = agents.map((agent) => {
      expect(agent.deniedAt, `${agent.name} was never denied`).not.toBeNull();
      expect(agent.denial?.reasonCode).toBe(DenialReason.GRANT_REVOKED);
      expect([RevocationSubReason.REVOKED, RevocationSubReason.PARENT_REVOKED]).toContain(agent.denial?.subReason);
      return agent.deniedAt! - stopAt;
    });

    const report = {
      agents: agents.length,
      budget_ms: BUDGET_MS,
      stop_id: stop.stopId,
      grants_revoked: stop.grantsRevoked,
      agents_stopped: stop.agentsStopped.length,
      max_ms: Math.max(...latencies),
      latencies_ms: latencies,
      allowed_calls_before_stop: agents.map((agent) => agent.allowedCalls),
    };
    // eslint-disable-next-line no-console
    console.log(`emergency stop: ${JSON.stringify(report)}`);
    if (REPORT) writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);

    expect(report.max_ms).toBeLessThanOrEqual(BUDGET_MS);
  }, 300_000);
});
