import { Command } from 'commander';
import chalk from 'chalk';
import { requireClient } from '../client.js';
import { printTable, printRecord, shortDate, isJsonMode } from '../format.js';

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
        list.map((t) => ({ ...t })),
      );
    });

  tokens
    .command('create')
    .description('Create a new SCIM token')
    .requiredOption('--label <label>', 'Human-readable label')
    .action(async (opts: { label: string }) => {
      const client = await requireClient();
      const result = await client.scim.createToken({ label: opts.label });
      if (isJsonMode()) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(chalk.green('✓') + ` SCIM token created: ${result.id}`);
      console.log(`Token: ${chalk.bold(result.token)}  (shown once — store it securely)`);
    });

  tokens
    .command('revoke <tokenId>')
    .description('Revoke a SCIM token')
    .action(async (tokenId: string) => {
      const client = await requireClient();
      await client.scim.revokeToken(tokenId);
      if (isJsonMode()) {
        console.log(JSON.stringify({ revoked: tokenId }));
        return;
      }
      console.log(chalk.green('✓') + ` SCIM token ${tokenId} revoked.`);
    });

  cmd.addCommand(tokens);

  // ── scim users ───────────────────────────────────────────────────────────
  const users = new Command('users').description('Manage SCIM-provisioned users');

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
        result.Resources.map((u) => ({ ...u })),
      );
    });

  users
    .command('get <userId>')
    .description('Get a SCIM user by ID')
    .action(async (userId: string) => {
      const client = await requireClient();
      const u = await client.scim.getUser(userId);
      if (isJsonMode()) {
        console.log(JSON.stringify(u, null, 2));
        return;
      }
      printRecord({
        id: u.id,
        userName: u.userName,
        displayName: u.displayName ?? '—',
        active: u.active ? 'yes' : 'no',
        emails: u.emails.map((e) => e.value).join(', ') || '—',
      });
    });

  users
    .command('create')
    .description('Create a SCIM user')
    .requiredOption('--user-name <userName>', 'Unique user name')
    .option('--display-name <name>', 'Display name')
    .option('--external-id <id>', 'External system user ID')
    .option('--email <email>', 'Primary email address')
    .action(async (opts: { userName: string; displayName?: string; externalId?: string; email?: string }) => {
      const client = await requireClient();
      const res = await client.scim.createUser({
        userName: opts.userName,
        ...(opts.displayName !== undefined ? { displayName: opts.displayName } : {}),
        ...(opts.externalId !== undefined ? { externalId: opts.externalId } : {}),
        ...(opts.email !== undefined ? { emails: [{ value: opts.email, primary: true }] } : {}),
      });
      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(chalk.green('✓') + ` SCIM user created: ${res.id}`);
    });

  users
    .command('update <userId>')
    .description('Update a SCIM user (PATCH)')
    .option('--display-name <name>', 'New display name')
    .option('--active <bool>', 'Set active status (true/false)')
    .option('--user-name <userName>', 'New user name')
    .action(async (userId: string, opts: { displayName?: string; active?: string; userName?: string }) => {
      const client = await requireClient();
      const operations: Array<{ op: string; path: string; value: unknown }> = [];
      if (opts.displayName !== undefined) operations.push({ op: 'replace', path: 'displayName', value: opts.displayName });
      if (opts.active !== undefined) operations.push({ op: 'replace', path: 'active', value: opts.active === 'true' });
      if (opts.userName !== undefined) operations.push({ op: 'replace', path: 'userName', value: opts.userName });

      if (operations.length === 0) {
        console.error('Error: provide at least one field to update (--display-name, --active, --user-name).');
        process.exit(1);
      }

      const res = await client.scim.updateUser(userId, operations);
      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(chalk.green('✓') + ` SCIM user ${userId} updated.`);
    });

  users
    .command('replace <userId>')
    .description('Replace a SCIM user (PUT)')
    .requiredOption('--user-name <userName>', 'User name')
    .option('--display-name <name>', 'Display name')
    .option('--email <email>', 'Primary email address')
    .option('--active <bool>', 'Active status (true/false)', 'true')
    .action(async (userId: string, opts: { userName: string; displayName?: string; email?: string; active: string }) => {
      const client = await requireClient();
      const res = await client.scim.replaceUser(userId, {
        userName: opts.userName,
        ...(opts.displayName !== undefined ? { displayName: opts.displayName } : {}),
        ...(opts.email !== undefined ? { emails: [{ value: opts.email, primary: true }] } : {}),
        active: opts.active === 'true',
      });
      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(chalk.green('✓') + ` SCIM user ${userId} replaced.`);
    });

  users
    .command('delete <userId>')
    .description('Delete a SCIM user')
    .action(async (userId: string) => {
      const client = await requireClient();
      await client.scim.deleteUser(userId);
      if (isJsonMode()) {
        console.log(JSON.stringify({ deleted: userId }));
        return;
      }
      console.log(chalk.green('✓') + ` SCIM user ${userId} deleted.`);
    });

  cmd.addCommand(users);

  return cmd;
}
