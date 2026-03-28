import { Command } from 'commander';
import chalk from 'chalk';
import { requireClient } from '../client.js';
import { printTable, printRecord, shortDate, isJsonMode } from '../format.js';

export function passportsCommand(): Command {
  const cmd = new Command('passports').description('Manage agent passports (MPP spend authorization)');

  cmd
    .command('issue')
    .description('Issue a new agent passport')
    .requiredOption('--agent-id <agentId>', 'Agent to issue passport for')
    .requiredOption('--grant-id <grantId>', 'Grant backing this passport')
    .requiredOption('--categories <cats>', 'Comma-separated MPP categories')
    .requiredOption('--max-amount <n>', 'Maximum transaction amount', parseFloat)
    .option('--currency <currency>', 'Currency code (default: USD)', 'USD')
    .option('--payment-rails <rails>', 'Comma-separated payment rails')
    .option('--expires-in <duration>', 'Expiry duration (e.g. 24h)')
    .option('--parent-passport-id <id>', 'Parent passport for delegation')
    .action(async (opts: {
      agentId: string;
      grantId: string;
      categories: string;
      maxAmount: number;
      currency: string;
      paymentRails?: string;
      expiresIn?: string;
      parentPassportId?: string;
    }) => {
      const client = await requireClient();
      const res = await client.passports.issue({
        agentId: opts.agentId,
        grantId: opts.grantId,
        allowedMPPCategories: opts.categories.split(',').map((c) => c.trim()),
        maxTransactionAmount: { amount: opts.maxAmount, currency: opts.currency },
        ...(opts.paymentRails !== undefined ? { paymentRails: opts.paymentRails.split(',').map((r) => r.trim()) } : {}),
        ...(opts.expiresIn !== undefined ? { expiresIn: opts.expiresIn } : {}),
        ...(opts.parentPassportId !== undefined ? { parentPassportId: opts.parentPassportId } : {}),
      });

      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(chalk.green('✓') + ` Passport issued: ${res.passportId}`);
      printRecord({
        passportId: res.passportId,
        expiresAt: shortDate(res.expiresAt),
        encodedCredential: res.encodedCredential.slice(0, 60) + '...',
      });
    });

  cmd
    .command('get <passportId>')
    .description('Get a passport by ID')
    .action(async (passportId: string) => {
      const client = await requireClient();
      const res = await client.passports.get(passportId);
      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      printRecord({
        status: res.status,
        ...Object.fromEntries(
          Object.entries(res)
            .filter(([k]) => k !== 'status')
            .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
        ),
      });
    });

  cmd
    .command('list')
    .description('List issued passports')
    .option('--agent-id <agentId>', 'Filter by agent ID')
    .option('--grant-id <grantId>', 'Filter by grant ID')
    .option('--status <status>', 'Filter by status')
    .action(async (opts: { agentId?: string; grantId?: string; status?: string }) => {
      const client = await requireClient();
      const passports = await client.passports.list({
        ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
        ...(opts.grantId !== undefined ? { grantId: opts.grantId } : {}),
        ...(opts.status !== undefined ? { status: opts.status } : {}),
      });
      printTable(
        passports.map((p) => ({
          ID: p.passportId,
          EXPIRES: shortDate(p.expiresAt),
        })),
        ['ID', 'EXPIRES'],
        passports.map((p) => ({ ...p })),
      );
    });

  cmd
    .command('revoke <passportId>')
    .description('Revoke an agent passport')
    .action(async (passportId: string) => {
      const client = await requireClient();
      const res = await client.passports.revoke(passportId);
      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(chalk.green('✓') + ` Passport ${passportId} revoked at ${res.revokedAt}.`);
    });

  return cmd;
}
