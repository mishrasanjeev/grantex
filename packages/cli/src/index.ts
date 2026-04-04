#!/usr/bin/env node
import { Command } from 'commander';
import { setJsonMode } from './format.js';
import { agentsCommand } from './commands/agents.js';
import { anomaliesCommand } from './commands/anomalies.js';
import { auditCommand } from './commands/audit.js';
import { authorizeCommand } from './commands/authorize.js';
import { billingCommand } from './commands/billing.js';
import { budgetsCommand } from './commands/budgets.js';
import { complianceCommand } from './commands/compliance.js';
import { configCommand } from './commands/config.js';
import { credentialsCommand } from './commands/credentials.js';
import { domainsCommand } from './commands/domains.js';
import { eventsCommand } from './commands/events.js';
import { grantsCommand } from './commands/grants.js';
import { meCommand } from './commands/me.js';
import { passportsCommand } from './commands/passports.js';
import { policiesCommand } from './commands/policies.js';
import { principalSessionsCommand } from './commands/principal-sessions.js';
import { scimCommand } from './commands/scim.js';
import { ssoCommand } from './commands/sso.js';
import { tokensCommand } from './commands/tokens.js';
import { usageCommand } from './commands/usage.js';
import { vaultCommand } from './commands/vault.js';
import { webauthnCommand } from './commands/webauthn.js';
import { webhooksCommand } from './commands/webhooks.js';
import { verifyCommand } from './commands/verify.js';
import { decodeCommand } from './commands/decode.js';
import { auditCmdCommand } from './commands/audit-cmd.js';
import { registryCommand } from './commands/registry-cmd.js';
import { initCommand } from './commands/init.js';
import { manifestCommand } from './commands/manifest.js';
import { enforceCommand } from './commands/enforce.js';

export function createProgram(): Command {
  const program = new Command();

  program
    .name('grantex')
    .description('CLI for the Grantex delegated authorization protocol')
    .version('0.2.0')
    .option('--json', 'Output results as JSON (machine-readable)')
    .hook('preAction', () => {
      if (program.opts().json) {
        setJsonMode(true);
      }
    });

  program.addCommand(configCommand());
  program.addCommand(meCommand());
  program.addCommand(agentsCommand());
  program.addCommand(authorizeCommand());
  program.addCommand(grantsCommand());
  program.addCommand(tokensCommand());
  program.addCommand(auditCommand());
  program.addCommand(webhooksCommand());
  program.addCommand(policiesCommand());
  program.addCommand(budgetsCommand());
  program.addCommand(usageCommand());
  program.addCommand(domainsCommand());
  program.addCommand(eventsCommand());
  program.addCommand(principalSessionsCommand());
  program.addCommand(credentialsCommand());
  program.addCommand(passportsCommand());
  program.addCommand(vaultCommand());
  program.addCommand(webauthnCommand());
  program.addCommand(complianceCommand());
  program.addCommand(anomaliesCommand());
  program.addCommand(billingCommand());
  program.addCommand(scimCommand());
  program.addCommand(ssoCommand());
  program.addCommand(verifyCommand());
  program.addCommand(decodeCommand());
  program.addCommand(auditCmdCommand());
  program.addCommand(registryCommand());
  program.addCommand(initCommand());
  program.addCommand(manifestCommand());
  program.addCommand(enforceCommand());

  return program;
}

// Only run when executed directly (not when imported in tests)
/* c8 ignore next 7 */
if (process.env['VITEST'] === undefined) {
  const program = createProgram();
  program.parseAsync(process.argv).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
