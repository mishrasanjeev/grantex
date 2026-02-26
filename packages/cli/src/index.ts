#!/usr/bin/env node
import { Command } from 'commander';
import { agentsCommand } from './commands/agents.js';
import { auditCommand } from './commands/audit.js';
import { complianceCommand } from './commands/compliance.js';
import { configCommand } from './commands/config.js';
import { grantsCommand } from './commands/grants.js';
import { tokensCommand } from './commands/tokens.js';
import { webhooksCommand } from './commands/webhooks.js';

const program = new Command();

program
  .name('grantex')
  .description('CLI tool for local Grantex development')
  .version('0.1.0');

program.addCommand(configCommand());
program.addCommand(agentsCommand());
program.addCommand(grantsCommand());
program.addCommand(tokensCommand());
program.addCommand(auditCommand());
program.addCommand(webhooksCommand());
program.addCommand(complianceCommand());

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error((err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
