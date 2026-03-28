import { Command } from 'commander';
import chalk from 'chalk';
import { requireClient } from '../client.js';
import { printTable, printRecord, shortDate, isJsonMode } from '../format.js';

export function agentsCommand(): Command {
  const cmd = new Command('agents').description('Manage registered agents');

  cmd
    .command('list')
    .description('List all agents')
    .action(async () => {
      const client = await requireClient();
      const { agents } = await client.agents.list();
      printTable(
        agents.map((a) => ({
          ID: a.id,
          NAME: a.name,
          DID: a.did,
          CREATED: shortDate(a.createdAt),
        })),
        ['ID', 'NAME', 'DID', 'CREATED'],
        agents.map((a) => ({ ...a })),
      );
    });

  cmd
    .command('register')
    .description('Register a new agent')
    .requiredOption('--name <name>', 'Human-readable agent name')
    .requiredOption('--description <desc>', 'Agent description')
    .requiredOption('--scopes <scopes>', 'Comma-separated list of requested scopes')
    .action(async (opts: { name: string; description: string; scopes: string }) => {
      const client = await requireClient();
      const agent = await client.agents.register({
        name: opts.name,
        description: opts.description,
        scopes: opts.scopes.split(',').map((s) => s.trim()),
      });
      if (isJsonMode()) {
        console.log(JSON.stringify(agent, null, 2));
        return;
      }
      console.log(chalk.green('✓') + ` Agent registered: ${agent.id}`);
      printRecord({
        id: agent.id,
        name: agent.name,
        did: agent.did,
        scopes: agent.scopes.join(', '),
        createdAt: shortDate(agent.createdAt),
      });
    });

  cmd
    .command('get <agentId>')
    .description('Get details for a single agent')
    .action(async (agentId: string) => {
      const client = await requireClient();
      const agent = await client.agents.get(agentId);
      if (isJsonMode()) {
        console.log(JSON.stringify(agent, null, 2));
        return;
      }
      printRecord({
        id: agent.id,
        name: agent.name,
        did: agent.did,
        description: agent.description,
        scopes: agent.scopes.join(', '),
        createdAt: shortDate(agent.createdAt),
      });
    });

  cmd
    .command('update <agentId>')
    .description('Update an agent')
    .option('--name <name>', 'New agent name')
    .option('--description <desc>', 'New agent description')
    .option('--scopes <scopes>', 'New comma-separated scopes')
    .action(async (agentId: string, opts: { name?: string; description?: string; scopes?: string }) => {
      const client = await requireClient();
      const updates: Record<string, unknown> = {};
      if (opts.name !== undefined) updates.name = opts.name;
      if (opts.description !== undefined) updates.description = opts.description;
      if (opts.scopes !== undefined) updates.scopes = opts.scopes.split(',').map((s) => s.trim());
      const agent = await client.agents.update(agentId, updates);
      if (isJsonMode()) {
        console.log(JSON.stringify(agent, null, 2));
        return;
      }
      console.log(chalk.green('✓') + ` Agent ${agentId} updated.`);
    });

  cmd
    .command('delete <agentId>')
    .description('Delete an agent')
    .action(async (agentId: string) => {
      const client = await requireClient();
      await client.agents.delete(agentId);
      if (isJsonMode()) {
        console.log(JSON.stringify({ deleted: agentId }));
        return;
      }
      console.log(chalk.green('✓') + ` Agent ${agentId} deleted.`);
    });

  return cmd;
}
