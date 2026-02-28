import { describe, it, expect } from 'vitest';
import { reportJson } from '../src/reporter.js';
import type { ConformanceReport } from '../src/types.js';

function makeReport(overrides?: Partial<ConformanceReport>): ConformanceReport {
  return {
    suites: [
      {
        name: 'health',
        description: 'Health check',
        optional: false,
        durationMs: 100,
        tests: [
          { name: 'test1', status: 'pass', durationMs: 50, specRef: '§1' },
          { name: 'test2', status: 'fail', durationMs: 50, specRef: '§2', error: 'oops' },
        ],
      },
    ],
    summary: {
      total: 2,
      passed: 1,
      failed: 1,
      skipped: 0,
      durationMs: 100,
    },
    ...overrides,
  };
}

describe('reportJson()', () => {
  it('outputs valid JSON', () => {
    const report = makeReport();
    const output = reportJson(report);
    const parsed = JSON.parse(output);
    expect(parsed.summary.total).toBe(2);
    expect(parsed.summary.passed).toBe(1);
    expect(parsed.summary.failed).toBe(1);
  });

  it('includes suite and test details', () => {
    const report = makeReport();
    const output = reportJson(report);
    const parsed = JSON.parse(output);
    expect(parsed.suites).toHaveLength(1);
    expect(parsed.suites[0].name).toBe('health');
    expect(parsed.suites[0].tests).toHaveLength(2);
    expect(parsed.suites[0].tests[0].status).toBe('pass');
    expect(parsed.suites[0].tests[1].status).toBe('fail');
    expect(parsed.suites[0].tests[1].error).toBe('oops');
  });

  it('handles all-passing report', () => {
    const report = makeReport({
      suites: [
        {
          name: 'test',
          description: 'All pass',
          optional: false,
          durationMs: 50,
          tests: [
            { name: 'pass1', status: 'pass', durationMs: 25, specRef: '§1' },
            { name: 'pass2', status: 'pass', durationMs: 25, specRef: '§2' },
          ],
        },
      ],
      summary: { total: 2, passed: 2, failed: 0, skipped: 0, durationMs: 50 },
    });
    const parsed = JSON.parse(reportJson(report));
    expect(parsed.summary.failed).toBe(0);
  });

  it('handles skipped tests', () => {
    const report = makeReport({
      suites: [
        {
          name: 'test',
          description: 'With skip',
          optional: true,
          durationMs: 10,
          tests: [
            { name: 'skip1', status: 'skip', durationMs: 0, specRef: '§1', error: 'skipped' },
          ],
        },
      ],
      summary: { total: 1, passed: 0, failed: 0, skipped: 1, durationMs: 10 },
    });
    const parsed = JSON.parse(reportJson(report));
    expect(parsed.summary.skipped).toBe(1);
    expect(parsed.suites[0].optional).toBe(true);
  });
});
