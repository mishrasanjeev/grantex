/**
 * Release test for the emergency stop (PRD G-6, US-5): one call halts every
 * agent under a grant tree, and each agent's next tool call is denied within
 * two seconds.
 *
 * It is built so it can fail for the right reasons:
 *
 * - the agents sit at different depths of a delegation chain, so a stop that
 *   only revoked the roots would leave the deeper ones running;
 * - one agent checks revocations `online` rather than through the feed, so a
 *   feed that silently stopped delivering could not hide it;
 * - the number of grants the stop reports is cross-checked against the live
 *   grants the API lists before it runs;
 * - a grant minted after the stop is asserted to be **live**, because the stop
 *   is a sweep and not a lockout, and the runbook says so.
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
/** The requirement (PRD G-6 / US-5), deliberately not overridable. */
const BUDGET_MS = 2_000;
const REPORT = process.env['EMERGENCY_STOP_REPORT'];
const describeRelease = BASE_URL ? describe : describe.skip;
const SCOPES = ['tool:acme_kyb:read'];

const manifest = new ToolManifest({
  connector: 'acme_kyb',
  tools: { resolve_business: Permission.READ },
});

interface SimulatedAgent {
  name: string;
  /** How far down the delegation chain this agent's grant sits. */
  depth: number;
  mode: 'feed' | 'online';
  client: Grantex;
  token: string;
  grantId: string;
  allowedCalls: number;
  deniedAt: number | null;
  denial: { reasonCode?: string; subReason?: string } | null;
  loop: Promise<void> | null;
}

let admin: Grantex;
let apiKey: string;
let developerId: string;
let rootGrantToken: string;
let leafAgentId: string;
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

async function liveGrantCount(): Promise<number> {
  const grants = await admin.grants.list({ status: 'active' });
  return grants.grants.length;
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
        agent.denial = {
          ...(result.reasonCode !== undefined ? { reasonCode: result.reasonCode } : {}),
          ...(result.subReason !== undefined ? { subReason: result.subReason } : {}),
        };
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  })();
}

function clientFor(mode: 'feed' | 'online'): Grantex {
  const client = new Grantex({
    apiKey,
    baseUrl: BASE_URL!,
    issuer: process.env['REVOCATION_RELEASE_ISSUER'] ?? BASE_URL!,
    revocationCheck: mode,
    ...(mode === 'feed' ? { revocationFeed: { staleAfterMs: 5_000 } } : {}),
  });
  client.loadManifest(manifest);
  return client;
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

    const stamp = Date.now();
    const rootAgent = await admin.agents.register({ name: `stop-root-${stamp}`, scopes: SCOPES });
    const chainAgents = await Promise.all([1, 2, 3].map((depth) =>
      admin.agents.register({ name: `stop-depth-${depth}-${stamp}`, scopes: SCOPES })));
    const onlineAgent = await admin.agents.register({ name: `stop-online-${stamp}`, scopes: SCOPES });
    leafAgentId = chainAgents[2]!.agentId;

    const auth = await admin.authorize({ agentId: rootAgent.agentId, userId: `stop-user-${stamp}`, scopes: SCOPES });
    const code = 'code' in auth && typeof (auth as unknown as Record<string, unknown>)['code'] === 'string'
      ? (auth as unknown as Record<string, unknown>)['code'] as string
      : await approve(auth.authRequestId);
    const rootGrant = await admin.tokens.exchange({ code, agentId: rootAgent.agentId });
    rootGrantToken = rootGrant.grantToken;

    // A chain: root → depth 1 → depth 2 → depth 3. An agent runs at each
    // level, so a stop that only reached the roots would leave two running.
    let parentToken = rootGrant.grantToken;
    for (const [index, agent] of chainAgents.entries()) {
      const delegated = await admin.grants.delegate({
        parentGrantToken: parentToken, subAgentId: agent.agentId, scopes: SCOPES, expiresIn: '1h',
      });
      parentToken = delegated.grantToken;
      agents.push({
        name: `depth-${index + 1}`,
        depth: index + 1,
        mode: 'feed',
        client: clientFor('feed'),
        token: delegated.grantToken,
        grantId: delegated.grantId,
        allowedCalls: 0,
        deniedAt: null,
        denial: null,
        loop: null,
      });
    }

    // And one agent that does not use the feed at all.
    const onlineGrant = await admin.grants.delegate({
      parentGrantToken: rootGrant.grantToken, subAgentId: onlineAgent.agentId, scopes: SCOPES, expiresIn: '1h',
    });
    agents.push({
      name: 'online',
      depth: 1,
      mode: 'online',
      client: clientFor('online'),
      token: onlineGrant.grantToken,
      grantId: onlineGrant.grantId,
      allowedCalls: 0,
      deniedAt: null,
      denial: null,
      loop: null,
    });

    for (const agent of agents.filter((candidate) => candidate.mode === 'feed')) {
      expect(await agent.client.revocationFeed().ready(10_000)).toBe(true);
    }
  }, 300_000);

  afterAll(async () => {
    running = false;
    await Promise.allSettled(agents.map((agent) => agent.loop));
    await Promise.allSettled(agents.map((agent) => agent.client.stopRevocationFeed()));
  });

  it('denies every running agent, at every depth and in both modes, within two seconds', async () => {
    for (const agent of agents) agent.loop = runAgent(agent);

    // Let every agent get through a few calls first: the stop has to change
    // something that was working.
    const warmupDeadline = Date.now() + 20_000;
    while (Date.now() < warmupDeadline && agents.some((agent) => agent.allowedCalls < 2)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(agents.every((agent) => agent.allowedCalls >= 2), 'every agent should be running before the stop').toBe(true);
    expect(agents.every((agent) => agent.deniedAt === null)).toBe(true);
    expect(agents.map((agent) => `${agent.name}:${agent.mode}`).sort()).toEqual(
      ['depth-1:feed', 'depth-2:feed', 'depth-3:feed', 'online:online'],
    );

    const liveBefore = await liveGrantCount();
    expect(liveBefore).toBe(agents.length + 1); // the four delegated grants and the root

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
    const stop = JSON.parse(responseText) as {
      stopId: string; status: string; sweeps: number; grantsRevoked: number;
      agentsStopped: string[]; lockout: boolean;
    };
    expect(stop.status).toBe('completed');
    expect(stop.lockout).toBe(false);
    // Nothing was delegated during this stop, so one pass that found grants
    // and one that found none is the whole story. `sweeps >= 2` used to be
    // asserted here and could not fail: the counter increments before the
    // empty check, so a stop that swept exactly once still reported 2. What
    // sweeping is actually for is covered by the next test.
    expect(stop.sweeps).toBe(2);
    // Cross-checked against what the API said was live, not a lower bound.
    expect(stop.grantsRevoked).toBe(liveBefore);
    expect(await liveGrantCount()).toBe(0);

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && agents.some((agent) => agent.deniedAt === null)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    running = false;
    await Promise.allSettled(agents.map((agent) => agent.loop));

    const latencies = agents.map((agent) => {
      expect(agent.deniedAt, `${agent.name} (${agent.mode}) was never denied`).not.toBeNull();
      expect(agent.denial?.reasonCode, `${agent.name} was denied for the wrong reason`).toBe(DenialReason.GRANT_REVOKED);
      expect([RevocationSubReason.REVOKED, RevocationSubReason.PARENT_REVOKED]).toContain(agent.denial?.subReason);
      return agent.deniedAt! - stopAt;
    });

    // The stop is a sweep, not a lockout: the same key can mint a new grant
    // straight afterwards, and the runbook says to rotate it. If this ever
    // starts failing, the behaviour changed and the runbook is now wrong.
    const auth = await admin.authorize({
      agentId: leafAgentId, userId: `stop-after-${Date.now()}`, scopes: SCOPES,
    });
    const code = 'code' in auth && typeof (auth as unknown as Record<string, unknown>)['code'] === 'string'
      ? (auth as unknown as Record<string, unknown>)['code'] as string
      : await approve(auth.authRequestId);
    const afterwards = await admin.tokens.exchange({ code, agentId: leafAgentId });
    expect(afterwards.grantToken).toBeTruthy();
    expect(await liveGrantCount()).toBe(1);
    void rootGrantToken;

    const report = {
      agents: agents.map((agent) => ({
        name: agent.name, mode: agent.mode, depth: agent.depth, allowed_calls_before_stop: agent.allowedCalls,
      })),
      budget_ms: BUDGET_MS,
      stop_id: stop.stopId,
      status: stop.status,
      sweeps: stop.sweeps,
      live_grants_before: liveBefore,
      grants_revoked: stop.grantsRevoked,
      agents_stopped: stop.agentsStopped.length,
      max_ms: Math.max(...latencies),
      latencies_ms: latencies,
      lockout: stop.lockout,
    };
    // eslint-disable-next-line no-console
    console.log(`emergency stop: ${JSON.stringify(report)}`);
    if (REPORT) writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);

    expect(report.max_ms).toBeLessThanOrEqual(BUDGET_MS);
  }, 300_000);

  /**
   * What sweeping is for: a grant delegated **while the stop is running**.
   * The first pass cannot have seen it, so only a later pass catches it —
   * and if the sweep loop were removed, this grant would survive the stop
   * with a live parent chain behind it.
   *
   * The delegations race a real stop, so some of them are expected to be
   * refused once their parent is revoked. That is fine: what must hold is
   * that nothing this developer owns is live afterwards.
   */
  it('catches a grant delegated while the stop is running', async () => {
    const stamp = Date.now();
    const parentAgent = await admin.agents.register({ name: `race-parent-${stamp}`, scopes: SCOPES });
    const childAgent = await admin.agents.register({ name: `race-child-${stamp}`, scopes: SCOPES });

    const auth = await admin.authorize({ agentId: parentAgent.agentId, userId: `race-user-${stamp}`, scopes: SCOPES });
    const code = 'code' in auth && typeof (auth as unknown as Record<string, unknown>)['code'] === 'string'
      ? (auth as unknown as Record<string, unknown>)['code'] as string
      : await approve(auth.authRequestId);
    const root = await admin.tokens.exchange({ code, agentId: parentAgent.agentId });
    expect(await liveGrantCount()).toBeGreaterThan(0);

    // Delegations fired alongside the stop, not before it.
    const delegated: string[] = [];
    let racing = true;
    const race = (async () => {
      while (racing) {
        try {
          const child = await admin.grants.delegate({
            parentGrantToken: root.grantToken, subAgentId: childAgent.agentId, scopes: SCOPES, expiresIn: '1h',
          });
          delegated.push(child.grantId);
        } catch {
          // Expected once the parent is revoked.
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    })();

    const response = await fetch(`${BASE_URL}/v1/emergency-stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        scope: { type: 'developer', id: developerId },
        reason: 'release rehearsal: delegation racing the stop',
        confirm: `stop developer:${developerId}`,
      }),
    });
    // The stop takes longer than one 25 ms delegation cycle, but stop racing
    // only after it returns so the overlap is not a matter of luck.
    racing = false;
    await race;

    const text = await response.text();
    expect(response.status, text).toBe(200);
    const stop = JSON.parse(text) as { status: string; sweeps: number; grantsRevoked: number };
    expect(stop.status).toBe('completed');

    // The race has to have happened for the assertion below to mean
    // anything: without a delegation landing during the stop, "nothing is
    // live afterwards" is true of any stop at all.
    expect(delegated.length, 'no grant was delegated while the stop ran').toBeGreaterThan(0);

    // And nothing is left running. A single-pass stop leaves whatever was
    // created after its one read.
    expect(await liveGrantCount()).toBe(0);
    const survivors = await Promise.all(delegated.map(async (grantId) => {
      const grant = await admin.grants.get(grantId).catch(() => null);
      return grant && grant.status === 'active' ? grantId : null;
    }));
    expect(survivors.filter(Boolean)).toEqual([]);
    // eslint-disable-next-line no-console
    console.log(`emergency stop race: ${JSON.stringify({
      delegated_during_stop: delegated.length, sweeps: stop.sweeps, grants_revoked: stop.grantsRevoked,
    })}`);
  }, 300_000);
});
