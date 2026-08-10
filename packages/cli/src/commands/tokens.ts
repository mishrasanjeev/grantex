import { Command } from 'commander';
import chalk from 'chalk';
import { requireClient } from '../client.js';
import { printRecord, shortDate, isJsonMode } from '../format.js';
import { readTokenInput } from '../token-input.js';

export function tokensCommand(): Command {
  const cmd = new Command('tokens').description('Exchange, verify, refresh, and revoke grant tokens');

  cmd
    .command('exchange')
    .description('Exchange an authorization code for a grant token')
    .requiredOption('--code <code>', 'Authorization code from consent approval')
    .requiredOption('--agent-id <agentId>', 'Agent ID that was authorized')
    .option('--code-verifier <verifier>', 'PKCE code verifier (if challenge was sent)')
    .action(async (opts: { code: string; agentId: string; codeVerifier?: string }) => {
      const client = await requireClient();
      const res = await client.tokens.exchange({
        code: opts.code,
        agentId: opts.agentId,
        ...(opts.codeVerifier !== undefined ? { codeVerifier: opts.codeVerifier } : {}),
      });

      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }

      console.log(chalk.green('✓') + ' Token exchanged successfully.');
      printRecord({
        grantToken: res.grantToken.slice(0, 40) + '...',
        grantId: res.grantId,
        scopes: res.scopes.join(', '),
        refreshToken: res.refreshToken,
        expiresAt: shortDate(res.expiresAt),
      });
    });

  cmd
    .command('verify [token]')
    .description('Verify a grant token (online check)')
    .option('--file <path>', 'Read token from a file')
    .option('--stdin', 'Read token from stdin')
    .option('--env <name>', 'Read token from an environment variable')
    .action(async (tokenArg: string | undefined, opts: {
      file?: string;
      stdin?: boolean;
      env?: string;
    }) => {
      let token: string;
      try {
        token = readTokenInput(tokenArg, opts);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isJsonMode()) {
          console.log(JSON.stringify({ valid: false, error: message }));
          process.exitCode = 1;
          return;
        }
        console.error(chalk.red('\u2717') + ` ${message}`);
        process.exit(1);
        return;
      }
      const client = await requireClient();
      const res = await client.tokens.verify(token);

      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        if (!res.valid) process.exitCode = 1;
        return;
      }

      if (!res.valid) {
        console.error(chalk.red('✗') + ' Token is invalid or has been revoked.');
        process.exit(1);
      }

      console.log(chalk.green('✓') + ' Token is valid.');
      printRecord({
        grantId: res.grantId ?? '',
        scopes: (res.scopes ?? []).join(', '),
        principal: res.principal ?? '',
        agent: res.agent ?? '',
        expiresAt: res.expiresAt ? shortDate(res.expiresAt) : '',
      });
    });

  cmd
    .command('refresh')
    .description('Refresh a grant token (rotates refresh token)')
    .requiredOption('--refresh-token <token>', 'Current refresh token')
    .requiredOption('--agent-id <agentId>', 'Agent ID for the grant')
    .action(async (opts: { refreshToken: string; agentId: string }) => {
      const client = await requireClient();
      const res = await client.tokens.refresh({
        refreshToken: opts.refreshToken,
        agentId: opts.agentId,
      });

      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }

      console.log(chalk.green('✓') + ' Token refreshed successfully.');
      printRecord({
        grantToken: res.grantToken.slice(0, 40) + '...',
        grantId: res.grantId,
        scopes: res.scopes.join(', '),
        refreshToken: res.refreshToken,
        expiresAt: shortDate(res.expiresAt),
      });
    });

  cmd
    .command('revoke <jti>')
    .description('Revoke a grant token by JTI')
    .action(async (jti: string) => {
      const client = await requireClient();
      await client.tokens.revoke(jti);
      if (isJsonMode()) {
        console.log(JSON.stringify({ revoked: jti }));
        return;
      }
      console.log(chalk.green('✓') + ` Token ${jti} revoked.`);
    });

  return cmd;
}
