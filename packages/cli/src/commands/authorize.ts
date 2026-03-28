import { Command } from 'commander';
import chalk from 'chalk';
import { requireClient } from '../client.js';
import { printRecord, shortDate, isJsonMode } from '../format.js';

export function authorizeCommand(): Command {
  const cmd = new Command('authorize').description('Start an authorization request');

  cmd
    .requiredOption('--agent <agentId>', 'Agent ID to authorize')
    .requiredOption('--principal <principalId>', 'Principal (user) identifier')
    .requiredOption('--scopes <scopes>', 'Comma-separated scopes to request')
    .option('--redirect-uri <uri>', 'Redirect URI for callback')
    .option('--expires-in <duration>', 'Expiry duration (e.g. 1h, 24h)')
    .option('--code-challenge <challenge>', 'PKCE S256 code challenge')
    .action(
      async (opts: {
        agent: string;
        principal: string;
        scopes: string;
        redirectUri?: string;
        expiresIn?: string;
        codeChallenge?: string;
      }) => {
        const client = await requireClient();
        const res = await client.authorize({
          agentId: opts.agent,
          userId: opts.principal,
          scopes: opts.scopes.split(',').map((s) => s.trim()),
          ...(opts.redirectUri !== undefined ? { redirectUri: opts.redirectUri } : {}),
          ...(opts.expiresIn !== undefined ? { expiresIn: opts.expiresIn } : {}),
          ...(opts.codeChallenge !== undefined ? { codeChallenge: opts.codeChallenge, codeChallengeMethod: 'S256' } : {}),
        });

        if (isJsonMode()) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }

        console.log(chalk.green('✓') + ` Authorization request created.`);
        const display: Record<string, string> = {
          authRequestId: res.authRequestId,
          consentUrl: res.consentUrl,
          expiresAt: shortDate(res.expiresAt),
        };
        if ('code' in res && res.code) {
          display.code = res.code as string;
          console.log(chalk.yellow('  (sandbox auto-approved — code returned directly)'));
        }
        printRecord(display);
      },
    );

  return cmd;
}
