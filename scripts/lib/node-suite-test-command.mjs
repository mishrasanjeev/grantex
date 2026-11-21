export function nodeSuiteTestCommand(script, reportFile) {
  if (script === 'vitest run') {
    if (typeof reportFile !== 'string' || !reportFile) throw new Error('A Vitest report file is required');
    return { runner: 'vitest', args: ['test', '--', '--maxWorkers=2', '--reporter=json', `--outputFile=${reportFile}`], reportFile };
  }
  if (script === 'node ../../tests/helpers/scoped-example.mjs .') {
    return { runner: 'scoped-example', args: ['test'] };
  }
  throw new Error(`Unsupported package test command: ${script}`);
}

export function readScopedExampleProof(stdout) {
  const line = stdout.trimEnd().split(/\r?\n/).at(-1);
  const proof = JSON.parse(line);
  if (proof?.localOnly !== true || proof.paidModelCalls !== false
    || proof.malformedJsonRejected !== true || !Array.isArray(proof.calls)
    || !proof.calls.every(call => typeof call === 'string')
    || !proof.calls.includes('GET /.well-known/jwks.json')
    || proof.calls.filter(call => call === 'POST /v1/audit/log').length < 2
    || !Number.isInteger(proof.auditEntries) || proof.auditEntries < 2) {
    throw new Error('The scoped example did not provide its complete local-only verification proof');
  }
  return proof;
}

export function vitestSuiteCounts(report) {
  if (report?.success !== true || !Number.isInteger(report.numPassedTests) || report.numPassedTests < 1
    || report.numFailedTests !== 0 || !Number.isInteger(report.numPendingTests) || report.numPendingTests < 0) {
    throw new Error('The Vitest report does not verify a successful executed test suite');
  }
  return { passed: report.numPassedTests, failed: report.numFailedTests, pending: report.numPendingTests };
}
