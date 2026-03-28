import { Command } from 'commander';
import { requireClient } from '../client.js';
import { printRecord, printTable, isJsonMode } from '../format.js';

export function usageCommand(): Command {
  const cmd = new Command('usage').description('View API usage metrics');

  cmd
    .command('current')
    .description('Get current period usage')
    .action(async () => {
      const client = await requireClient();
      const res = await client.usage.current();
      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      printRecord({
        developerId: res.developerId,
        period: res.period,
        tokenExchanges: String(res.tokenExchanges),
        authorizations: String(res.authorizations),
        verifications: String(res.verifications),
        totalRequests: String(res.totalRequests),
      });
    });

  cmd
    .command('history')
    .description('Get historical usage')
    .option('--days <n>', 'Number of days to look back (default: 30)', parseInt)
    .action(async (opts: { days?: number }) => {
      const client = await requireClient();
      const res = await client.usage.history({
        ...(opts.days !== undefined ? { days: opts.days } : {}),
      });
      printTable(
        res.entries.map((e) => ({
          DATE: e.date,
          EXCHANGES: String(e.tokenExchanges),
          AUTHORIZATIONS: String(e.authorizations),
          VERIFICATIONS: String(e.verifications),
          TOTAL: String(e.totalRequests),
        })),
        ['DATE', 'EXCHANGES', 'AUTHORIZATIONS', 'VERIFICATIONS', 'TOTAL'],
        res.entries.map((e) => ({ ...e })),
      );
    });

  return cmd;
}
