/**
 * Functional check that a revoked parent grant denies its child through the
 * SDK. The G-6 acceptance criterion — two seconds at the ninety-fifth
 * percentile — is measured by scripts/revocation-propagation.mjs in a plain
 * Node process, the way an agent runs the SDK; this file only proves the
 * behaviour is wired up, with a bound loose enough that a slow CI runner does
 * not turn a passing service into a red build.
 *
 * It runs against a real auth service with Postgres and Redis behind it (see
 * scripts/revocation-release-test.sh), never against production: the base URL
 * must be given explicitly.
 *
 *   REVOCATION_RELEASE_BASE_URL=http://127.0.0.1:3199 \
 *   npx vitest run tests/e2e/revocation-propagation.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { Grantex, ToolManifest, Permission, DenialReason, RevocationSubReason } from '@grantex/sdk';

const BASE_URL = process.env['REVOCATION_RELEASE_BASE_URL'];
const TRIALS = 3;
/** Loose on purpose: the measured budget lives in the plain-Node harness. */
const BUDGET_MS = 30_000;
const REPORT = process.env['REVOCATION_RELEASE_REPORT'];
const describeRelease = BASE_URL ? describe : describe.skip;

const manifest = new ToolManifest({
  connector: 'acme_kyb',
  tools: { resolve_business: Permission.READ },
});

interface Pair {
  parentGrantId: string;
  childToken: string;
}

let grantex: Grantex;
let enforcer: Grantex;
let apiKey: string;

async function approve(authRequestId: string): Promise<string> {
  const response = await fetch(`${BASE_URL}/v1/authorize/${authRequestId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: '{}',
  });
  if (!response.ok) throw new Error(`approve failed: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { code: string }).code;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

describeRelease('cascade revocation reaches an agent in feed mode', () => {
  const pairs: Pair[] = [];

  beforeAll(async () => {
    const account = await Grantex.signup(
      { name: `revocation-release-${Date.now()}`, mode: 'sandbox' },
      { baseUrl: BASE_URL! },
    );
    apiKey = account.apiKey;
    grantex = new Grantex({ apiKey, baseUrl: BASE_URL! });

    const scopes = ['tool:acme_kyb:read'];
    const root = await grantex.agents.register({ name: `release-root-${Date.now()}`, scopes });
    const middle = await grantex.agents.register({ name: `release-middle-${Date.now()}`, scopes });
    const leaf = await grantex.agents.register({ name: `release-leaf-${Date.now()}`, scopes });

    // One authorization, then a delegated pair per trial: every trial revokes
    // its own parent, so no trial can be helped by another one's revocation.
    const auth = await grantex.authorize({ agentId: root.agentId, userId: `release-user-${Date.now()}`, scopes });
    const code = 'code' in auth && typeof (auth as unknown as Record<string, unknown>)['code'] === 'string'
      ? (auth as unknown as Record<string, unknown>)['code'] as string
      : await approve(auth.authRequestId);
    const rootGrant = await grantex.tokens.exchange({ code, agentId: root.agentId });

    for (let trial = 0; trial < TRIALS; trial += 1) {
      const parent = await grantex.grants.delegate({
        parentGrantToken: rootGrant.grantToken,
        subAgentId: middle.agentId,
        scopes,
        expiresIn: '1h',
      });
      const child = await grantex.grants.delegate({
        parentGrantToken: parent.grantToken,
        subAgentId: leaf.agentId,
        scopes,
        expiresIn: '1h',
      });
      pairs.push({ parentGrantId: parent.grantId, childToken: child.grantToken });
    }

    enforcer = new Grantex({
      apiKey,
      baseUrl: BASE_URL!,
      issuer: process.env['REVOCATION_RELEASE_ISSUER'] ?? BASE_URL!,
      revocationCheck: 'feed',
      revocationFeed: { staleAfterMs: 5_000 },
    });
    enforcer.loadManifest(manifest);
    expect(await enforcer.revocationFeed().ready(10_000)).toBe(true);
  }, 180_000);

  afterAll(async () => {
    await enforcer?.stopRevocationFeed();
  });

  it('denies a child grant with grant_revoked after its parent is revoked', async () => {
    const allowed = await enforcer.enforce({
      grantToken: pairs[0]!.childToken,
      connector: 'acme_kyb',
      tool: 'resolve_business',
    });
    expect(allowed.allowed).toBe(true);

    const latencies: number[] = [];
    for (const pair of pairs) {
      const started = Date.now();
      await grantex.grants.revoke(pair.parentGrantId);
      let denial: Awaited<ReturnType<Grantex['enforce']>> | null = null;
      while (Date.now() - started < 30_000) {
        const result = await enforcer.enforce({
          grantToken: pair.childToken,
          connector: 'acme_kyb',
          tool: 'resolve_business',
        });
        if (!result.allowed) {
          denial = result;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const elapsed = Date.now() - started;
      expect(denial, `child grant was still allowed ${elapsed} ms after its parent was revoked`).not.toBeNull();
      expect(denial!.reasonCode).toBe(DenialReason.GRANT_REVOKED);
      expect([RevocationSubReason.REVOKED, RevocationSubReason.PARENT_REVOKED]).toContain(denial!.subReason);
      latencies.push(elapsed);
    }

    const report = {
      trials: latencies.length,
      bound_ms: BUDGET_MS,
      min_ms: Math.min(...latencies),
      p50_ms: percentile(latencies, 0.5),
      max_ms: Math.max(...latencies),
      latencies_ms: latencies,
    };
    // eslint-disable-next-line no-console
    console.log(`revocation propagation (TypeScript SDK): ${JSON.stringify(report)}`);
    if (REPORT) writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);

    expect(report.max_ms).toBeLessThanOrEqual(BUDGET_MS);
  }, 600_000);
});
