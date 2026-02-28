import type { RunConfig, ConformanceReport, SuiteResult, SuiteContext, SuiteDefinition } from './types.js';
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

// Optional suites
import { policiesSuite } from './suites/policies.js';
import { webhooksSuite } from './suites/webhooks.js';
import { scimSuite } from './suites/scim.js';
import { ssoSuite } from './suites/sso.js';
import { anomaliesSuite } from './suites/anomalies.js';
import { complianceSuite } from './suites/compliance.js';

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
];

const optionalSuites: SuiteDefinition[] = [
  policiesSuite,
  webhooksSuite,
  scimSuite,
  ssoSuite,
  anomaliesSuite,
  complianceSuite,
];

export async function runConformanceTests(config: RunConfig): Promise<ConformanceReport> {
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

    const http = new ConformanceHttpClient(config.baseUrl, config.apiKey);
    const cleanup = new CleanupTracker(http);
    const flow = new AuthFlowHelper(http, cleanup);

    const ctx: SuiteContext = {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      http,
      flow,
      cleanup,
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
