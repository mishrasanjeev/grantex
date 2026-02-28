import chalk from 'chalk';
import type { ConformanceReport, TestResult, SuiteResult } from './types.js';

function statusIcon(status: TestResult['status']): string {
  switch (status) {
    case 'pass':
      return chalk.green('✓');
    case 'fail':
      return chalk.red('✗');
    case 'skip':
      return chalk.yellow('○');
  }
}

function statusLabel(status: TestResult['status']): string {
  switch (status) {
    case 'pass':
      return chalk.green('PASS');
    case 'fail':
      return chalk.red('FAIL');
    case 'skip':
      return chalk.yellow('SKIP');
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function reportText(report: ConformanceReport): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(chalk.bold('Grantex Conformance Test Suite'));
  lines.push(chalk.dim('─'.repeat(50)));
  lines.push('');

  for (const suite of report.suites) {
    const tag = suite.optional ? chalk.dim(' (optional)') : '';
    lines.push(chalk.bold(`  ${suite.name}${tag}`));
    lines.push(chalk.dim(`  ${suite.description}`));
    lines.push('');

    for (const t of suite.tests) {
      const duration = chalk.dim(`(${formatDuration(t.durationMs)})`);
      const ref = chalk.dim(`[${t.specRef}]`);
      lines.push(`    ${statusIcon(t.status)} ${t.name} ${duration} ${ref}`);
      if (t.error) {
        lines.push(chalk.red(`      ${t.error}`));
      }
    }
    lines.push('');
  }

  lines.push(chalk.dim('─'.repeat(50)));

  const { total, passed, failed, skipped, durationMs } = report.summary;
  const parts: string[] = [];
  if (passed > 0) parts.push(chalk.green(`${passed} passed`));
  if (failed > 0) parts.push(chalk.red(`${failed} failed`));
  if (skipped > 0) parts.push(chalk.yellow(`${skipped} skipped`));
  parts.push(`${total} total`);

  lines.push(`  ${parts.join(', ')} ${chalk.dim(`in ${formatDuration(durationMs)}`)}`);
  lines.push('');

  if (failed === 0) {
    lines.push(chalk.green.bold('  All tests passed!'));
  } else {
    lines.push(chalk.red.bold(`  ${failed} test(s) failed.`));
  }
  lines.push('');

  return lines.join('\n');
}

export function reportJson(report: ConformanceReport): string {
  return JSON.stringify(report, null, 2);
}
