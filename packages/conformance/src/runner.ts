import type { RunConfig, ConformanceReport, SuiteResult, SuiteContext, SuiteDefinition, SharedAgent } from './types.js';
import { ConformanceHttpClient } from './http-client.js';
import { CleanupTracker } from './cleanup.js';
import { AuthFlowHelper } from './flow.js';

// Core suites
import { healthSuite } from './suites/health.js';
import { agentsSuite } from './suites/agents.js';
import { authorizeSuite } from './suites/authorize.js';
import { tokenSuite } from './suites/token.js';
import { tokensSuite } from './suites/tokens.js';
import { grantsSuite } from './suites/grants.js';
import { delegationSuite } from './suites/delegation.js';
import { auditSuite } from './suites/audit.js';
import { securitySuite } from './suites/security.js';
import { rateLimitHeadersSuite } from './suites/rate-limit-headers.js';

// Optional suites
import { policiesSuite } from './suites/policies.js';
import { webhooksSuite } from './suites/webhooks.js';
import { scimSuite } from './suites/scim.js';
import { ssoSuite } from './suites/sso.js';
import { anomaliesSuite } from './suites/anomalies.js';
import { complianceSuite } from './suites/compliance.js';
import { principalSessionsSuite } from './suites/principal-sessions.js';
import { tokenRefreshSuite } from './suites/token-refresh.js';

const coreSuites: SuiteDefinition[] = [
  healthSuite,
  agentsSuite,
  authorizeSuite,
  tokenSuite,
  tokensSuite,
  grantsSuite,
  delegationSuite,
  auditSuite,
  securitySuite,
  rateLimitHeadersSuite,
];

const optionalSuites: SuiteDefinition[] = [
  policiesSuite,
  webhooksSuite,
  scimSuite,
  ssoSuite,
  anomaliesSuite,
  complianceSuite,
  principalSessionsSuite,
  tokenRefreshSuite,
];

/** Name of the agent the conformance runner owns. Only agents with this exact name are ever reused. */
export const SHARED_AGENT_NAME = 'conformance-shared';

/**
 * Suites that exercise `ctx.sharedAgent` and therefore cannot run when no
 * shared agent could be obtained (e.g. the tenant's plan limit is reached).
 */
const SUITES_REQUIRING_SHARED_AGENT = new Set([
  'agents',
  'authorize',
  'token',
  'tokens',
  'grants',
  'delegation',
  'audit',
  'security',
  'principal-sessions',
  'token-refresh',
]);

interface SharedAgentSetup {
  agent: SharedAgent | null;
  /** Human-readable reason when `agent` is null. */
  skipReason?: string;
}

/**
 * Obtains the shared agent used across suites.
 *
 * Safety contract: the runner must NEVER mutate or delete agents it did not
 * create. A pre-existing agent is reused only when it is unambiguously ours
 * (name === SHARED_AGENT_NAME); otherwise a new agent is created and tracked
 * for cleanup at the end of the run. If creation is refused because of the
 * tenant's plan limit (402), the dependent suites are skipped instead of
 * freeing slots by deleting somebody else's agents.
 */
export async function setupSharedAgent(
  http: ConformanceHttpClient,
  cleanup: CleanupTracker,
): Promise<SharedAgentSetup> {
  const listRes = await http.get<{ agents: Array<{ agentId: string; did: string; name: string; scopes: string[] }> }>('/v1/agents');

  if (listRes.status === 200 && Array.isArray(listRes.body.agents)) {
    const ours = listRes.body.agents.find((a) => a.name === SHARED_AGENT_NAME);
    if (ours) {
      const scopes = Array.isArray(ours.scopes) ? ours.scopes : [];
      // The agent is ours by name; make sure it still carries the scopes the suites need.
      if (!scopes.includes('read') || !scopes.includes('write')) {
        const patchRes = await http.patch(`/v1/agents/${ours.agentId}`, {
          scopes: Array.from(new Set([...scopes, 'read', 'write'])),
        });
        if (patchRes.status !== 200) {
          throw new Error(`Failed to update shared agent scopes: ${patchRes.status} ${patchRes.rawText}`);
        }
      }
      return { agent: { agentId: ours.agentId, agentDid: ours.did, name: ours.name } };
    }
  }

  // No conformance-owned agent exists — create one and track it for cleanup.
  const res = await http.post<{ agentId: string; did: string; name: string }>('/v1/agents', {
    name: SHARED_AGENT_NAME,
    scopes: ['read', 'write'],
  });
  if (res.status === 402) {
    return {
      agent: null,
      skipReason: `Plan limit reached — could not create shared agent (${res.status} ${res.rawText}). ` +
        'Free an agent slot or upgrade the plan; the conformance runner never deletes agents it did not create.',
    };
  }
  if (res.status !== 201) {
    throw new Error(`Failed to create shared agent: ${res.status} ${res.rawText}`);
  }
  cleanup.trackAgent(res.body.agentId);
  return { agent: { agentId: res.body.agentId, agentDid: res.body.did, name: res.body.name } };
}

export async function runConformanceTests(config: RunConfig): Promise<ConformanceReport> {
  const setupHttp = new ConformanceHttpClient(config.baseUrl, config.apiKey);
  const runCleanup = new CleanupTracker(setupHttp);

  try {
    return await runSuites(config, setupHttp, runCleanup);
  } finally {
    // Remove only what this run created (e.g. the shared agent).
    await runCleanup.teardown();
  }
}

async function runSuites(
  config: RunConfig,
  setupHttp: ConformanceHttpClient,
  runCleanup: CleanupTracker,
): Promise<ConformanceReport> {
  // Set up a shared agent for all suites (reuses our own existing agent or creates a new one)
  const { agent: sharedAgent, skipReason } = await setupSharedAgent(setupHttp, runCleanup);

  const allSuites = [...coreSuites];

  if (config.include) {
    for (const ext of config.include) {
      const found = optionalSuites.find((s) => s.name === ext);
      if (found) {
        allSuites.push(found);
      }
    }
  }

  let suitesToRun = allSuites;
  if (config.suite) {
    suitesToRun = allSuites.filter((s) => s.name === config.suite);
    if (suitesToRun.length === 0) {
      const available = allSuites.map((s) => s.name).join(', ');
      throw new Error(`Unknown suite "${config.suite}". Available: ${available}`);
    }
  }

  const results: SuiteResult[] = [];
  const overallStart = Date.now();
  let bailed = false;

  for (const suite of suitesToRun) {
    if (bailed) break;

    if (sharedAgent === null) {
      if (SUITES_REQUIRING_SHARED_AGENT.has(suite.name)) {
        results.push({
          name: suite.name,
          description: suite.description,
          optional: suite.optional,
          tests: [
            {
              name: `${suite.name} setup`,
              status: 'skip',
              durationMs: 0,
              specRef: '',
              error: skipReason ?? 'No shared agent available',
            },
          ],
          durationMs: 0,
        });
        continue;
      }
    }

    const http = new ConformanceHttpClient(config.baseUrl, config.apiKey);
    const cleanup = new CleanupTracker(http);
    const flow = new AuthFlowHelper(http, cleanup);

    const ctx: SuiteContext = {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      http,
      flow,
      cleanup,
      // Suites that need the shared agent were skipped above when it is null;
      // the remaining suites never touch it, so an empty placeholder is safe.
      sharedAgent: sharedAgent ?? { agentId: '', agentDid: '', name: '' },
    };

    const suiteStart = Date.now();
    try {
      const tests = await suite.run(ctx);
      results.push({
        name: suite.name,
        description: suite.description,
        optional: suite.optional,
        tests,
        durationMs: Date.now() - suiteStart,
      });

      if (config.bail && tests.some((t) => t.status === 'fail')) {
        bailed = true;
      }
    } catch (err) {
      results.push({
        name: suite.name,
        description: suite.description,
        optional: suite.optional,
        tests: [
          {
            name: `${suite.name} setup`,
            status: 'fail',
            durationMs: Date.now() - suiteStart,
            specRef: '',
            error: err instanceof Error ? err.message : String(err),
          },
        ],
        durationMs: Date.now() - suiteStart,
      });
      if (config.bail) bailed = true;
    } finally {
      await cleanup.teardown();
    }
  }

  const allTests = results.flatMap((s) => s.tests);
  return {
    suites: results,
    summary: {
      total: allTests.length,
      passed: allTests.filter((t) => t.status === 'pass').length,
      failed: allTests.filter((t) => t.status === 'fail').length,
      skipped: allTests.filter((t) => t.status === 'skip').length,
      durationMs: Date.now() - overallStart,
    },
  };
}
