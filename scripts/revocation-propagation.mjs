#!/usr/bin/env node
/**
 * Measures the G-6 acceptance criterion with the TypeScript SDK: revoke a
 * parent grant and time how long a child grant keeps being authorised by
 * `enforce()` in feed mode.
 *
 * It runs as a plain Node process — the way an agent runs the SDK — against a
 * real auth service (see scripts/revocation-release-test.sh). The budget is
 * two seconds at the ninety-fifth percentile and is not configurable: that is
 * the requirement, not a setting.
 *
 *   REVOCATION_RELEASE_BASE_URL=http://127.0.0.1:3199 node scripts/revocation-propagation.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sdkPath = join(root, 'packages', 'sdk-ts', 'dist', 'index.js');
const { Grantex, ToolManifest, Permission, DenialReason, RevocationSubReason } = await import(
  `file://${sdkPath.split('\\').join('/')}`
);

const BASE_URL = process.env.REVOCATION_RELEASE_BASE_URL;
if (!BASE_URL) {
  console.error('REVOCATION_RELEASE_BASE_URL is not set');
  process.exit(2);
}
/** The requirement (PRD G-6), deliberately not overridable. */
const BUDGET_MS = 2_000;
const TRIALS = Number(process.env.REVOCATION_RELEASE_TRIALS ?? '40');
const WARMUP = Number(process.env.REVOCATION_RELEASE_WARMUP ?? '2');
const REPORT = process.env.REVOCATION_RELEASE_REPORT;
const SCOPES = ['tool:acme_kyb:read'];

// The SDK the agent process loads must be the one in this checkout.
console.log(`SDK under test: ${sdkPath}`);

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

async function approve(apiKey, authRequestId) {
  const response = await fetch(`${BASE_URL}/v1/authorize/${authRequestId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: '{}',
  });
  if (!response.ok) throw new Error(`approve failed: ${response.status} ${await response.text()}`);
  return (await response.json()).code;
}

const account = await Grantex.signup(
  { name: `revocation-release-${Date.now()}`, mode: 'sandbox' },
  { baseUrl: BASE_URL },
);
const admin = new Grantex({ apiKey: account.apiKey, baseUrl: BASE_URL });
const stamp = Date.now();
const root_ = await admin.agents.register({ name: `release-root-${stamp}`, scopes: SCOPES });
const middle = await admin.agents.register({ name: `release-middle-${stamp}`, scopes: SCOPES });
const leaf = await admin.agents.register({ name: `release-leaf-${stamp}`, scopes: SCOPES });

const auth = await admin.authorize({ agentId: root_.agentId, userId: `release-user-${stamp}`, scopes: SCOPES });
const code = typeof auth.code === 'string' ? auth.code : await approve(account.apiKey, auth.authRequestId);
const rootGrant = await admin.tokens.exchange({ code, agentId: root_.agentId });

const pairs = [];
for (let index = 0; index < TRIALS + WARMUP; index += 1) {
  const parent = await admin.grants.delegate({
    parentGrantToken: rootGrant.grantToken, subAgentId: middle.agentId, scopes: SCOPES, expiresIn: '1h',
  });
  const child = await admin.grants.delegate({
    parentGrantToken: parent.grantToken, subAgentId: leaf.agentId, scopes: SCOPES, expiresIn: '1h',
  });
  pairs.push({ parentGrantId: parent.grantId, childToken: child.grantToken });
}

const enforcer = new Grantex({
  apiKey: account.apiKey,
  baseUrl: BASE_URL,
  issuer: process.env.REVOCATION_RELEASE_ISSUER ?? BASE_URL,
  revocationCheck: 'feed',
  revocationFeed: { staleAfterMs: 5_000 },
});
enforcer.loadManifest(new ToolManifest({ connector: 'acme_kyb', tools: { resolve_business: Permission.READ } }));

let failures = 0;
const latencies = [];
const revokeCalls = [];
try {
  if (!await enforcer.revocationFeed().ready(10_000)) {
    console.error('the revocation feed never became fresh');
    process.exit(1);
  }
  const first = await enforcer.enforce({ grantToken: pairs[0].childToken, connector: 'acme_kyb', tool: 'resolve_business' });
  if (!first.allowed) {
    console.error(`the child grant was denied before any revocation: ${first.reason}`);
    process.exit(1);
  }

  for (const [index, pair] of pairs.entries()) {
    const started = Date.now();
    await admin.grants.revoke(pair.parentGrantId);
    // Propagation is measured from the moment the revocation is committed —
    // when the API returns — not from when the call was made. A developer on
    // the free plan is rate limited to 100 requests a minute, and the SDK
    // waits out `Retry-After`; that wait is reported separately rather than
    // charged to the feed.
    const revokedAt = Date.now();
    let denial = null;
    while (Date.now() - revokedAt < 30_000) {
      const result = await enforcer.enforce({
        grantToken: pair.childToken, connector: 'acme_kyb', tool: 'resolve_business',
      });
      if (!result.allowed) {
        denial = result;
        break;
      }
      await new Promise((resolve_) => setTimeout(resolve_, 20));
    }
    const elapsed = Date.now() - revokedAt;
    const revokeMs = revokedAt - started;
    if (revokeMs > 1_000) {
      console.log(`trial ${index}: the revoke call waited ${revokeMs} ms (plan rate limit), not counted`);
    }
    if (!denial) {
      console.error(`trial ${index}: child grant still allowed ${elapsed} ms after its parent was revoked`
        + ` (the revoke call itself took ${revokeMs} ms)`);
      if (process.env.REVOCATION_RELEASE_DIAGNOSE === '1') {
        const state = enforcer.revocationFeedState();
        const feedResponse = await fetch(`${BASE_URL}/v1/revocations?since=0&limit=1000`, {
          headers: { Authorization: `Bearer ${account.apiKey}` },
        });
        const feedBody = await feedResponse.json();
        console.error(`  client feed state: ${JSON.stringify(state)}`);
        console.error(`  server entries for this parent: ${JSON.stringify(
          feedBody.entries.filter((entry) => entry.grantId === pair.parentGrantId || entry.jti !== null).slice(0, 5),
        )}`);
        console.error(`  server entry count: ${feedBody.entries.length}, cursor ${feedBody.cursor}`);
      }
      failures += 1;
      continue;
    }
    if (denial.reasonCode !== DenialReason.GRANT_REVOKED
        || ![RevocationSubReason.REVOKED, RevocationSubReason.PARENT_REVOKED].includes(denial.subReason)) {
      console.error(`trial ${index}: unexpected denial ${denial.reasonCode}/${denial.subReason}: ${denial.reason}`);
      failures += 1;
      continue;
    }
    // The first trials warm the connection and the JWKS cache; they are
    // reported but not measured.
    if (index >= WARMUP) {
      latencies.push(elapsed);
      revokeCalls.push(revokeMs);
    } else console.log(`warmup ${index}: ${elapsed} ms (revoke call ${revokeMs} ms)`);
  }
} finally {
  await enforcer.stopRevocationFeed();
}

const report = {
  sdk: 'typescript',
  trials: latencies.length,
  warmup: WARMUP,
  budget_ms: BUDGET_MS,
  failures,
  min_ms: Math.min(...latencies),
  p50_ms: percentile(latencies, 0.5),
  p95_ms: percentile(latencies, 0.95),
  p99_ms: percentile(latencies, 0.99),
  max_ms: Math.max(...latencies),
  revoke_call_p95_ms: percentile(revokeCalls, 0.95),
  revoke_call_max_ms: Math.max(...revokeCalls),
  latencies_ms: latencies,
};
console.log(`revocation propagation (TypeScript SDK): ${JSON.stringify(report)}`);
if (REPORT) writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);

if (failures > 0) {
  console.error(`${failures} trial(s) did not deny the child grant correctly`);
  process.exit(1);
}
if (report.p95_ms > BUDGET_MS || report.max_ms > 4 * BUDGET_MS) {
  console.error(`p95 ${report.p95_ms} ms / max ${report.max_ms} ms is outside the ${BUDGET_MS} ms budget`);
  process.exit(1);
}
