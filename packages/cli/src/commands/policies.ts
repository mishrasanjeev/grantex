import { Command } from 'commander';
import chalk from 'chalk';
import { requireClient } from '../client.js';
import { printTable, printRecord, shortDate } from '../format.js';

export function policiesCommand(): Command {
  const cmd = new Command('policies').description('Manage authorization policies');

  cmd
    .command('list')
    .description('List all policies')
    .action(async () => {
      const client = await requireClient();
      const { policies } = await client.policies.list();
      printTable(
        policies.map((p) => ({
          ID: p.id,
          NAME: p.name,
          EFFECT: p.effect,
          PRIORITY: String(p.priority),
          CREATED: shortDate(p.createdAt),
        })),
        ['ID', 'NAME', 'EFFECT', 'PRIORITY', 'CREATED'],
      );
    });

  cmd
    .command('get <policyId>')
    .description('Get details for a policy')
    .action(async (policyId: string) => {
      const client = await requireClient();
      const p = await client.policies.get(policyId);
      printRecord({
        id: p.id,
        name: p.name,
        effect: p.effect,
        priority: String(p.priority),
        agentId: p.agentId ?? '(any)',
        principalId: p.principalId ?? '(any)',
        scopes: p.scopes?.join(', ') ?? '(any)',
        timeOfDayStart: p.timeOfDayStart ?? '—',
        timeOfDayEnd: p.timeOfDayEnd ?? '—',
        createdAt: shortDate(p.createdAt),
      });
    });

  cmd
    .command('create')
    .description('Create a new policy')
    .requiredOption('--name <name>', 'Policy name')
    .requiredOption('--effect <effect>', 'Effect: allow or deny')
    .option('--priority <n>', 'Priority (lower = higher priority)', '100')
    .option('--agent-id <id>', 'Restrict to specific agent')
    .option('--principal-id <id>', 'Restrict to specific principal')
    .option('--scopes <scopes>', 'Comma-separated scopes')
    .option('--time-start <HH:mm>', 'Time-of-day window start')
    .option('--time-end <HH:mm>', 'Time-of-day window end')
    .action(async (opts: {
      name: string;
      effect: string;
      priority: string;
      agentId?: string;
      principalId?: string;
      scopes?: string;
      timeStart?: string;
      timeEnd?: string;
    }) => {
      const client = await requireClient();
      const policy = await client.policies.create({
        name: opts.name,
        effect: opts.effect as 'allow' | 'deny',
        priority: parseInt(opts.priority, 10),
        ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
        ...(opts.principalId !== undefined ? { principalId: opts.principalId } : {}),
        ...(opts.scopes !== undefined ? { scopes: opts.scopes.split(',').map((s) => s.trim()) } : {}),
        ...(opts.timeStart !== undefined ? { timeOfDayStart: opts.timeStart } : {}),
        ...(opts.timeEnd !== undefined ? { timeOfDayEnd: opts.timeEnd } : {}),
      });
      console.log(chalk.green('✓') + ` Policy created: ${policy.id}`);
    });

  cmd
    .command('update <policyId>')
    .description('Update a policy')
    .option('--name <name>', 'New name')
    .option('--effect <effect>', 'New effect')
    .option('--priority <n>', 'New priority')
    .action(async (policyId: string, opts: { name?: string; effect?: string; priority?: string }) => {
      const client = await requireClient();
      const policy = await client.policies.update(policyId, {
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        ...(opts.effect !== undefined ? { effect: opts.effect as 'allow' | 'deny' } : {}),
        ...(opts.priority !== undefined ? { priority: parseInt(opts.priority, 10) } : {}),
      });
      console.log(chalk.green('✓') + ` Policy updated: ${policy.id}`);
    });

  cmd
    .command('delete <policyId>')
    .description('Delete a policy')
    .action(async (policyId: string) => {
      const client = await requireClient();
      await client.policies.delete(policyId);
      console.log(chalk.green('✓') + ` Policy ${policyId} deleted.`);
    });

  return cmd;
}
