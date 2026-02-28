import { Command } from 'commander';
import chalk from 'chalk';
import { requireClient } from '../client.js';
import { printTable, printRecord, shortDate } from '../format.js';

export function scimCommand(): Command {
  const cmd = new Command('scim').description('Manage SCIM provisioning');

  // ── scim tokens ──────────────────────────────────────────────────────────
  const tokens = new Command('tokens').description('Manage SCIM bearer tokens');

  tokens
    .command('list')
    .description('List SCIM tokens')
    .action(async () => {
      const client = await requireClient();
      const { tokens: list } = await client.scim.listTokens();
      printTable(
        list.map((t) => ({
          ID: t.id,
          LABEL: t.label,
          CREATED: shortDate(t.createdAt),
          'LAST USED': t.lastUsedAt ? shortDate(t.lastUsedAt) : '—',
        })),
        ['ID', 'LABEL', 'CREATED', 'LAST USED'],
      );
    });

  tokens
    .command('create')
    .description('Create a new SCIM token')
    .requiredOption('--label <label>', 'Human-readable label')
    .action(async (opts: { label: string }) => {
      const client = await requireClient();
      const result = await client.scim.createToken({ label: opts.label });
      console.log(chalk.green('✓') + ` SCIM token created: ${result.id}`);
      console.log(`Token: ${chalk.bold(result.token)}  (shown once — store it securely)`);
    });

  tokens
    .command('revoke <tokenId>')
    .description('Revoke a SCIM token')
    .action(async (tokenId: string) => {
      const client = await requireClient();
      await client.scim.revokeToken(tokenId);
      console.log(chalk.green('✓') + ` SCIM token ${tokenId} revoked.`);
    });

  cmd.addCommand(tokens);

  // ── scim users ───────────────────────────────────────────────────────────
  const users = new Command('users').description('View SCIM-provisioned users');

  users
    .command('list')
    .description('List SCIM users')
    .option('--start-index <n>', 'Start index', '1')
    .option('--count <n>', 'Page size', '25')
    .action(async (opts: { startIndex: string; count: string }) => {
      const client = await requireClient();
      const result = await client.scim.listUsers({
        startIndex: parseInt(opts.startIndex, 10),
        count: parseInt(opts.count, 10),
      });
      printTable(
        result.Resources.map((u) => ({
          ID: u.id,
          USERNAME: u.userName,
          DISPLAY: u.displayName ?? '—',
          ACTIVE: u.active ? 'yes' : 'no',
        })),
        ['ID', 'USERNAME', 'DISPLAY', 'ACTIVE'],
      );
    });

  users
    .command('get <userId>')
    .description('Get a SCIM user by ID')
    .action(async (userId: string) => {
      const client = await requireClient();
      const u = await client.scim.getUser(userId);
      printRecord({
        id: u.id,
        userName: u.userName,
        displayName: u.displayName ?? '—',
        active: u.active ? 'yes' : 'no',
        emails: u.emails.map((e) => e.value).join(', ') || '—',
      });
    });

  cmd.addCommand(users);

  return cmd;
}
