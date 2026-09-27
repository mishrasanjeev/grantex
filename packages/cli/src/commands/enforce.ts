import { Command, Option } from 'commander';
import chalk from 'chalk';
import * as sdk from '@grantex/sdk';
import { requireClient, type ClientOverrides } from '../client.js';
import { isJsonMode } from '../format.js';
import { readTokenInput } from '../token-input.js';

/**
 * Whether the installed @grantex/sdk checks the grant token audience in
 * enforce(). A release without the check ignores the audience options, so a
 * dry run would report a token for another relying party as allowed.
 */
function sdkChecksAudience(): boolean {
  try {
    const subReasons = (sdk as Record<string, unknown>)['TokenSubReason'] as Record<string, unknown> | undefined;
    return subReasons?.['AUDIENCE_MISMATCH'] === 'audience_mismatch';
  } catch {
    return false; // some module loaders throw for a missing export instead of returning undefined
  }
}

/** The audience settings for the client and the call, or the reason they are refused. */
function audienceOptions(audience: string | undefined, audienceCheck: 'on' | 'off' | undefined):
  { client: ClientOverrides; call: { audience?: string } } | { error: string } {
  if (audience === undefined && audienceCheck === undefined) return { client: {}, call: {} };
  if (audience === '') return { error: '--audience must not be empty' };
  if (audience !== undefined && audienceCheck === 'off') {
    return { error: '--audience cannot be combined with --audience-check off' };
  }
  if (!sdkChecksAudience()) {
    return {
      error: 'the installed @grantex/sdk does not check the grant token audience; '
        + 'upgrade @grantex/sdk to use --audience or --audience-check',
    };
  }
  return {
    client: audienceCheck !== undefined ? { audienceCheck } : {},
    call: audience !== undefined ? { audience } : {},
  };
}

function reportInputError(reason: string): void {
  if (isJsonMode()) {
    console.log(JSON.stringify({ allowed: false, reason }));
  } else {
    console.error(chalk.red('✗') + ` ${reason}`);
  }
  process.exitCode = 1;
}

export function enforceCommand(): Command {
  const cmd = new Command('enforce').description('Test scope enforcement against a grant token');

  cmd
    .command('test')
    .description('Dry-run scope enforcement for a tool call')
    .option('--token <token>', 'Grantex grant token (JWT)')
    .option('--token-file <path>', 'Read grant token from a file')
    .option('--token-stdin', 'Read grant token from stdin')
    .option('--token-env <name>', 'Read grant token from an environment variable')
    .requiredOption('--connector <connector>', 'Connector name (e.g., salesforce)')
    .requiredOption('--tool <tool>', 'Tool name (e.g., delete_contact)')
    .option('--amount <amount>', 'Amount for capped scope check', parseFloat)
    .option(
      '--audience <audience>',
      'Grant token audience the relying party expects (matched against the token aud claim)',
    )
    .addOption(
      new Option('--audience-check <on|off>', 'Grant token audience check (default: on; off ignores aud)')
        .choices(['on', 'off']),
    )
    .action(async (opts: {
      token?: string;
      tokenFile?: string;
      tokenStdin?: boolean;
      tokenEnv?: string;
      connector: string;
      tool: string;
      amount?: number;
      audience?: string;
      audienceCheck?: 'on' | 'off';
    }) => {
      let token: string;
      try {
        token = readTokenInput(opts.token, {
          file: opts.tokenFile,
          stdin: opts.tokenStdin,
          env: opts.tokenEnv,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (isJsonMode()) {
          console.log(JSON.stringify({ allowed: false, reason }));
          process.exitCode = 1;
          return;
        }
        console.error(chalk.red('\u2717') + ` ${reason}`);
        process.exit(1);
        return;
      }
      const audience = audienceOptions(opts.audience, opts.audienceCheck);
      if ('error' in audience) {
        reportInputError(audience.error);
        return;
      }
      const client = await requireClient(audience.client);

      // Load the manifest for the connector
      try {
        const mod = await import(`@grantex/sdk/manifests/${opts.connector}.js`);
        const manifest = Object.values(mod)[0] as import('@grantex/sdk').ToolManifest;
        client.loadManifest(manifest);
      } catch {
        if (isJsonMode()) {
          console.log(JSON.stringify({
            allowed: false,
            reason: `No manifest found for connector '${opts.connector}'`,
          }));
          process.exitCode = 1;
          return;
        }
        console.log(chalk.red(`\n  ❌ No manifest found for connector '${opts.connector}'`));
        console.log(chalk.dim('  Run `grantex manifest list` to see available connectors.'));
        process.exitCode = 1;
        return;
      }

      const result = await client.enforce({
        grantToken: token,
        connector: opts.connector,
        tool: opts.tool,
        ...(opts.amount !== undefined ? { amount: opts.amount } : {}),
        ...audience.call,
      });

      if (isJsonMode()) {
        console.log(JSON.stringify(result, null, 2));
        if (!result.allowed) process.exitCode = 1;
        return;
      }

      console.log();
      if (result.allowed) {
        console.log(chalk.green('  ✅ ALLOWED'));
      } else {
        console.log(chalk.red('  ❌ DENIED'));
      }
      console.log();
      console.log(`  ${chalk.dim('Token scopes:')}  [${result.scopes.join(', ')}]`);
      console.log(`  ${chalk.dim('Tool permission:')} ${result.permission || '?'} (from manifest)`);
      if (!result.allowed) {
        console.log(`  ${chalk.dim('Reason:')}         ${result.reason}`);
        process.exitCode = 1;
      }
      if (result.grantId) {
        console.log(`  ${chalk.dim('Grant ID:')}       ${result.grantId}`);
        console.log(`  ${chalk.dim('Agent DID:')}      ${result.agentDid}`);
      }
      console.log();
    });

  return cmd;
}
