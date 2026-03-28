import { Command } from 'commander';
import chalk from 'chalk';
import { requireClient } from '../client.js';
import { printTable, printRecord, shortDate, isJsonMode } from '../format.js';

export function budgetsCommand(): Command {
  const cmd = new Command('budgets').description('Manage budget allocations and spend tracking');

  cmd
    .command('allocate')
    .description('Allocate a budget to a grant')
    .requiredOption('--grant-id <grantId>', 'Grant to attach the budget to')
    .requiredOption('--amount <amount>', 'Budget amount', parseFloat)
    .option('--currency <currency>', 'Currency code (default: USD)')
    .action(async (opts: { grantId: string; amount: number; currency?: string }) => {
      const client = await requireClient();
      const res = await client.budgets.allocate({
        grantId: opts.grantId,
        initialBudget: opts.amount,
        ...(opts.currency !== undefined ? { currency: opts.currency } : {}),
      });
      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(chalk.green('✓') + ' Budget allocated.');
      printRecord({
        id: res.id,
        grantId: res.grantId,
        initialBudget: String(res.initialBudget),
        remainingBudget: String(res.remainingBudget),
      });
    });

  cmd
    .command('debit')
    .description('Debit an amount from a grant budget')
    .requiredOption('--grant-id <grantId>', 'Grant to debit from')
    .requiredOption('--amount <amount>', 'Amount to debit', parseFloat)
    .option('--description <desc>', 'Transaction description')
    .action(async (opts: { grantId: string; amount: number; description?: string }) => {
      const client = await requireClient();
      const res = await client.budgets.debit({
        grantId: opts.grantId,
        amount: opts.amount,
        ...(opts.description !== undefined ? { description: opts.description } : {}),
      });
      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(chalk.green('✓') + ` Debited. Remaining: ${res.remaining}`);
    });

  cmd
    .command('balance <grantId>')
    .description('Get current budget balance for a grant')
    .action(async (grantId: string) => {
      const client = await requireClient();
      const res = await client.budgets.balance(grantId);
      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      printRecord({
        grantId: res.grantId,
        initialBudget: String(res.initialBudget),
        remainingBudget: String(res.remainingBudget),
        currency: res.currency ?? 'USD',
      });
    });

  cmd
    .command('transactions <grantId>')
    .description('List budget transactions for a grant')
    .action(async (grantId: string) => {
      const client = await requireClient();
      const res = await client.budgets.transactions(grantId);
      printTable(
        res.transactions.map((t) => ({
          ID: t.id,
          AMOUNT: t.amount,
          DESCRIPTION: t.description,
          CREATED: shortDate(t.createdAt),
        })),
        ['ID', 'AMOUNT', 'DESCRIPTION', 'CREATED'],
        res.transactions.map((t) => ({ ...t })),
      );
    });

  return cmd;
}
