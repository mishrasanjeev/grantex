import { Command } from 'commander';
import type { RunConfig } from './types.js';
import { runConformanceTests } from './runner.js';
import { reportText, reportJson } from './reporter.js';

export async function run(): Promise<void> {
  const program = new Command();

  program
    .name('grantex-conformance')
    .description('Conformance test suite for the Grantex protocol')
    .requiredOption('--base-url <url>', 'Base URL of the Grantex auth service')
    .requiredOption('--api-key <key>', 'API key for authentication')
    .option('--suite <name>', 'Run a specific suite only')
    .option('--include <extensions>', 'Include optional extensions (comma-separated)')
    .option('--format <format>', 'Output format: text or json', 'text')
    .option('--bail', 'Stop on first failure', false)
    .option('--allow-additional-signing-keys', 'Validate additional ES256/EdDSA signing keys in a mixed JWKS', false)
    .option('--oacp-issuer <url>', 'Pinned OACP issuer identifier (default: the base URL)')
    .option('--oacp-tenant <id>', 'Commerce tenant the oacp suite issues under (default: cten_CONFORMANCE)')
    .action(async (opts: {
      baseUrl: string;
      apiKey: string;
      suite?: string;
      include?: string;
      format: string;
      bail: boolean;
      allowAdditionalSigningKeys: boolean;
      oacpIssuer?: string;
      oacpTenant?: string;
    }) => {
      const config: RunConfig = {
        baseUrl: opts.baseUrl.replace(/\/$/, ''),
        apiKey: opts.apiKey,
        suite: opts.suite,
        include: opts.include ? opts.include.split(',').map((s) => s.trim()) : undefined,
        format: opts.format === 'json' ? 'json' : 'text',
        bail: opts.bail,
        allowAdditionalSigningKeys: opts.allowAdditionalSigningKeys,
        // A secret: read from the environment only, never from argv.
        internalToken: process.env['GRANTEX_CONFORMANCE_INTERNAL_TOKEN'] || undefined,
        oacpIssuer: opts.oacpIssuer?.replace(/\/$/, '') ?? process.env['GRANTEX_CONFORMANCE_OACP_ISSUER'],
        oacpTenantId: opts.oacpTenant ?? process.env['GRANTEX_CONFORMANCE_OACP_TENANT'],
      };

      try {
        const report = await runConformanceTests(config);

        if (config.format === 'json') {
          process.stdout.write(reportJson(report) + '\n');
        } else {
          process.stdout.write(reportText(report));
        }

        process.exit(report.summary.failed > 0 ? 1 : 0);
      } catch (err) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(2);
      }
    });

  await program.parseAsync(process.argv);
}
