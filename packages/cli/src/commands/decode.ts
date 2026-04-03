import { Command } from 'commander';
import chalk from 'chalk';
import * as jose from 'jose';
import { readFileSync } from 'node:fs';
import { isJsonMode } from '../format.js';

export function decodeCommand(): Command {
  const cmd = new Command('decode')
    .description('Decode a JWT without verifying its signature (like jwt.io)')
    .argument('[token]', 'JWT token to decode')
    .option('--file <path>', 'Read token from a file')
    .option('--json', 'Machine-readable JSON output')
    .action(async (tokenArg: string | undefined, opts: { file?: string; json?: boolean }) => {
      const useJson = opts.json || isJsonMode();

      // Read token
      let token: string;
      if (opts.file) {
        try {
          token = readFileSync(opts.file, 'utf8').trim();
        } catch (err) {
          const msg = `Cannot read file: ${(err as Error).message}`;
          if (useJson) {
            console.log(JSON.stringify({ error: msg }));
          } else {
            console.error(chalk.red('\u2717') + ` ${msg}`);
          }
          process.exit(1);
          return;
        }
      } else if (tokenArg) {
        token = tokenArg;
      } else {
        const msg = 'No token provided. Pass a token argument or --file <path>.';
        if (useJson) {
          console.log(JSON.stringify({ error: msg }));
        } else {
          console.error(chalk.red('\u2717') + ` ${msg}`);
        }
        process.exit(1);
        return;
      }

      // Decode without verification
      let header: jose.ProtectedHeaderParameters;
      let payload: jose.JWTPayload;
      try {
        header = jose.decodeProtectedHeader(token);
        payload = jose.decodeJwt(token);
      } catch {
        const msg = 'Not a valid JWT. Could not decode header or payload.';
        if (useJson) {
          console.log(JSON.stringify({ error: msg }));
        } else {
          console.error(chalk.red('\u2717') + ` ${msg}`);
        }
        process.exit(1);
        return;
      }

      if (useJson) {
        console.log(JSON.stringify({ header, payload }, null, 2));
        return;
      }

      console.log('');
      console.log(chalk.bold('  JWT Header'));
      console.log(chalk.cyan('  ' + JSON.stringify(header, null, 2).split('\n').join('\n  ')));
      console.log('');
      console.log(chalk.bold('  JWT Payload'));
      console.log(chalk.cyan('  ' + JSON.stringify(payload, null, 2).split('\n').join('\n  ')));

      // Show human-readable expiry if present
      if (payload.exp) {
        const expDate = new Date(payload.exp * 1000);
        const now = new Date();
        const expired = expDate < now;
        console.log('');
        if (expired) {
          console.log(chalk.red(`  Expired: ${expDate.toISOString()}`));
        } else {
          console.log(chalk.green(`  Expires: ${expDate.toISOString()}`));
        }
      }

      console.log('');
      console.log(chalk.dim('  Note: Signature was NOT verified. Use "grantex verify" for full verification.'));
      console.log('');
    });

  return cmd;
}
