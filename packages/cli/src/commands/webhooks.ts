import { Command } from 'commander';
import chalk from 'chalk';
import { requireClient } from '../client.js';
import { printTable, shortDate } from '../format.js';
import type { WebhookEventType } from '@grantex/sdk';

const VALID_EVENTS: WebhookEventType[] = ['grant.created', 'grant.revoked', 'token.issued'];

export function webhooksCommand(): Command {
  const cmd = new Command('webhooks').description('Manage webhook endpoints');

  cmd
    .command('list')
    .description('List registered webhook endpoints')
    .action(async () => {
      const client = await requireClient();
      const { webhooks } = await client.webhooks.list();
      printTable(
        webhooks.map((w) => ({
          ID: w.id,
          URL: w.url,
          EVENTS: w.events.join(', '),
          CREATED: shortDate(w.createdAt),
        })),
        ['ID', 'URL', 'EVENTS', 'CREATED'],
      );
    });

  cmd
    .command('create')
    .description('Register a new webhook endpoint')
    .requiredOption('--url <url>', 'HTTPS endpoint URL to deliver events to')
    .requiredOption(
      '--events <events>',
      `Comma-separated event types (${VALID_EVENTS.join(', ')})`,
    )
    .action(async (opts: { url: string; events: string }) => {
      const events = opts.events.split(',').map((e) => e.trim()) as WebhookEventType[];
      const invalid = events.filter((e) => !VALID_EVENTS.includes(e));
      if (invalid.length > 0) {
        console.error(
          chalk.red('Error:') +
            ` Unknown event type(s): ${invalid.join(', ')}\n` +
            `Valid events: ${VALID_EVENTS.join(', ')}`,
        );
        process.exit(1);
      }

      const client = await requireClient();
      const wh = await client.webhooks.create({ url: opts.url, events });
      console.log(chalk.green('✓') + ` Webhook registered: ${wh.id}`);
      console.log(`Secret: ${chalk.bold(wh.secret)}  (shown once — store it securely)`);
    });

  cmd
    .command('delete <webhookId>')
    .description('Delete a webhook endpoint')
    .action(async (webhookId: string) => {
      const client = await requireClient();
      await client.webhooks.delete(webhookId);
      console.log(chalk.green('✓') + ` Webhook ${webhookId} deleted.`);
    });

  return cmd;
}
