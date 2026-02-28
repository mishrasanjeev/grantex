#!/usr/bin/env node
import { Command } from 'commander';
import { agentsCommand } from './commands/agents.js';
import { anomaliesCommand } from './commands/anomalies.js';
import { auditCommand } from './commands/audit.js';
import { complianceCommand } from './commands/compliance.js';
import { configCommand } from './commands/config.js';
import { grantsCommand } from './commands/grants.js';
import { tokensCommand } from './commands/tokens.js';
import { webhooksCommand } from './commands/webhooks.js';
import { policiesCommand } from './commands/policies.js';
import { billingCommand } from './commands/billing.js';
import { scimCommand } from './commands/scim.js';
import { ssoCommand } from './commands/sso.js';

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
program.addCommand(anomaliesCommand());
program.addCommand(policiesCommand());
program.addCommand(billingCommand());
program.addCommand(scimCommand());
program.addCommand(ssoCommand());

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error((err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
