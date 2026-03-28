import { Command } from 'commander';
import chalk from 'chalk';
import { requireClient } from '../client.js';
import { isJsonMode } from '../format.js';

export function eventsCommand(): Command {
  const cmd = new Command('events').description('Stream real-time authorization events');

  cmd
    .command('stream')
    .description('Stream events via SSE (Ctrl+C to stop)')
    .option('--types <types>', 'Comma-separated event types to filter')
    .action(async (opts: { types?: string }) => {
      const client = await requireClient();
      const options: Record<string, unknown> = {};
      if (opts.types !== undefined) {
        options.types = opts.types.split(',').map((t) => t.trim());
      }

      if (!isJsonMode()) {
        console.log(chalk.cyan('⟳') + ' Streaming events (Ctrl+C to stop)...\n');
      }

      for await (const event of client.events.stream(options)) {
        if (isJsonMode()) {
          console.log(JSON.stringify(event));
        } else {
          const type = event.type ?? 'unknown';
          const ts = event.createdAt ?? new Date().toISOString();
          console.log(
            chalk.gray(`[${ts}]`) + ' ' + chalk.bold(type) + ' ' +
            JSON.stringify(event.data, null, 0),
          );
        }
      }
    });

  return cmd;
}
