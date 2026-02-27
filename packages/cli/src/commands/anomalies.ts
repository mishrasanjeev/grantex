import { Command } from 'commander';
import chalk from 'chalk';
import { requireClient } from '../client.js';
import { printTable, shortDate } from '../format.js';
import type { Anomaly } from '@grantex/sdk';

const SEVERITY_COLOR: Record<string, (s: string) => string> = {
  high:   chalk.red,
  medium: chalk.yellow,
  low:    chalk.cyan,
};

function colorSeverity(severity: string): string {
  return (SEVERITY_COLOR[severity] ?? ((s: string) => s))(severity);
}

export function anomaliesCommand(): Command {
  const cmd = new Command('anomalies').description('Detect and manage agent anomalies');

  cmd
    .command('detect')
    .description('Run anomaly detection across all agents')
    .action(async () => {
      const client = await requireClient();
      const result = await client.anomalies.detect();

      if (result.total === 0) {
        console.log(chalk.green('✓') + ' No anomalies detected.');
        return;
      }

      console.log(`Detected ${result.total} anomaly${result.total !== 1 ? 's' : ''}:\n`);
      printTable(
        result.anomalies.map(formatRow),
        ['ID', 'TYPE', 'SEVERITY', 'AGENT', 'DESCRIPTION'],
      );
    });

  cmd
    .command('list')
    .description('List stored anomalies')
    .option('--unacknowledged', 'Show only unacknowledged anomalies')
    .action(async (opts: { unacknowledged?: boolean }) => {
      const client = await requireClient();
      const result = await client.anomalies.list({
        ...(opts.unacknowledged ? { unacknowledged: true } : {}),
      });

      printTable(
        result.anomalies.map(formatRow),
        ['ID', 'TYPE', 'SEVERITY', 'AGENT', 'DESCRIPTION'],
      );
    });

  cmd
    .command('acknowledge <anomalyId>')
    .description('Acknowledge an anomaly')
    .action(async (anomalyId: string) => {
      const client = await requireClient();
      await client.anomalies.acknowledge(anomalyId);
      console.log(chalk.green('✓') + ` Anomaly ${anomalyId} acknowledged.`);
    });

  return cmd;
}

function formatRow(a: Anomaly): Record<string, string> {
  return {
    ID:          a.id,
    TYPE:        a.type,
    SEVERITY:    colorSeverity(a.severity),
    AGENT:       a.agentId ?? '—',
    DESCRIPTION: a.description.length > 60 ? a.description.slice(0, 57) + '...' : a.description,
  };
}
