import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Run from the repository root, including inside a disposable Docker container.
const reportDir = resolve(process.env.GRANTEX_TEST_REPORT_DIR ?? `${tmpdir()}/grantex-node-suite`);
mkdirSync(reportDir, { recursive: true });
const results = [];
const packages = ['sdk-ts', 'cli', 'adapters', 'gateway', 'express', 'langchain', 'anthropic', 'autogen', 'vercel-ai', 'a2a', 'strands', 'mcp', 'mcp-auth', 'dpdp', 'mpp', 'destinations', 'conformance', 'gemma', 'x402'];
const examples = ['adapter-google-calendar', 'anthropic-tool-use', 'audit-dashboard', 'gateway-proxy', 'langchain-agent', 'multi-agent-delegation', 'multi-agent-email-flow', 'quickstart-ts', 'token-expiry-refresh', 'vercel-ai-chatbot', 'x402-agent-demo', 'x402-weather-api', 'nextjs-starter'];
const group = process.argv[2] ?? 'all';
if (!['all', 'packages', 'apps', 'examples'].includes(group)) throw new Error('Expected all, packages, apps or examples');

function run(directory, args, label) {
  const start = Date.now();
  const id = `${directory.replaceAll('/', '-')}-${label}`;
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd: resolve(directory), encoding: 'utf8', timeout: 1_200_000, maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32', env: { ...process.env, CI: 'true', NEXT_TELEMETRY_DISABLED: '1' },
  });
  writeFileSync(resolve(reportDir, `${id}.log`), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  const record = { directory, command: args, status: result.status, seconds: (Date.now() - start) / 1000 };
  if (label === 'test' && result.status === 0) {
    const tests = JSON.parse(readFileSync(resolve(reportDir, `${id}.json`), 'utf8'));
    record.passed = tests.numPassedTests;
    record.failed = tests.numFailedTests;
    record.pending = tests.numPendingTests;
  }
  results.push(record);
  writeFileSync(resolve(reportDir, `summary-${group}.json`), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(record));
  return result.status === 0;
}

if (!run('.', ['ci', '--no-audit', '--no-fund'], 'install')) process.exit(1);
const directories = [];
if (group === 'all' || group === 'packages') directories.push(...packages.map(p => `packages/${p}`));
if (group === 'all' || group === 'apps') directories.push('apps/auth-service', 'apps/portal', 'apps/mpp-demo-service');
if (group === 'all' || group === 'examples') directories.push(...examples.map(p => `examples/${p}`));
for (const directory of directories) {
  if (!run(directory, ['ci', '--no-audit', '--no-fund'], 'install')) continue;
  const { scripts = {} } = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
  if (scripts.typecheck) run(directory, ['run', 'typecheck'], 'typecheck');
  if (scripts.test) run(directory, ['test', '--', '--maxWorkers=2', '--reporter=json', `--outputFile=${resolve(reportDir, `${directory.replaceAll('/', '-')}-test.json`)}`], 'test');
  if (scripts.build) run(directory, ['run', 'build'], 'build');
}
process.exitCode = results.some(result => result.status !== 0) ? 1 : 0;
