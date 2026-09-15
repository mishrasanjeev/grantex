import { Command, Option } from 'commander';
import chalk from 'chalk';
import { readFileSync, writeFileSync } from 'node:fs';
import { evidence } from '@grantex/sdk';
import { defaultConfigPath, loadConfig, resolveConfig } from '../config.js';
import { isJsonMode } from '../format.js';

/** Exit codes: 0 verified, 1 verification or export failed, 2 usage or input error. */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

const SAFE_FILE_STEM = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;
const ROOT = /^sha256:[0-9a-f]{64}$/;
const AUDIT_HASH = /^[0-9a-f]{64}$/;

function printResult(result: evidence.VerificationResult): void {
  if (isJsonMode()) {
    console.log(JSON.stringify(evidence.verificationResultToJson(result), null, 2));
    return;
  }
  if (result.ok) {
    const checks = ['hash chain', 'trusted root'];
    if (result.anchorChecked) checks.push('anchor');
    if (result.signatureChecked) checks.push('signature');
    console.log(`${chalk.green('verified')}: ${result.entryCount} entries, root ${result.root}`);
    console.log(`  checked: ${checks.join(', ')}`);
    return;
  }
  console.error(`${chalk.red('FAILED')} ${result.code}: ${result.message}`);
  const rows: Array<[string, unknown]> = [
    ['entry', result.entryIndex],
    ['field', result.fieldPath],
    ['expected', result.expected],
    ['actual', result.actual],
  ];
  for (const [label, value] of rows) {
    if (value !== null && value !== undefined) console.error(`  ${`${label}:`.padEnd(9)} ${String(value)}`);
  }
}

function usage(message: string): never {
  console.error(`error: ${message}`);
  process.exit(EXIT_USAGE);
}

interface VerifyFlags {
  root: string;
  anchor?: string;
  requireAnchor?: boolean;
  jwks?: string;
  requireSignature?: boolean;
  skipSignature?: boolean;
  maxBytes?: string;
}

interface ExportFlags {
  out?: string;
  disclose?: string[];
  sign?: boolean;
  state?: string;
  url?: string;
}

function readInput(file: string): Uint8Array {
  try {
    return file === '-' ? readFileSync(0) : readFileSync(file);
  } catch (err) {
    return usage(`cannot read ${file}: ${(err as Error).message}`);
  }
}

export function evidenceCommand(): Command {
  const cmd = new Command('evidence').description('Verify and export evidence packages');

  cmd
    .command('verify <package>')
    .description('Verify an evidence package against a trusted root (exits 1 on any break)')
    .requiredOption('--root <root>', 'trusted package root, sha256:<64 hex>')
    .option('--anchor <hash>', 'trusted anchor audit entry hash (64 hex)')
    .option('--require-anchor', 'fail when the package has no anchor')
    .option('--jwks <file>', 'JSON Web Key Set file to verify a signature')
    .option('--require-signature', 'fail when the package is not signed')
    .option('--skip-signature', 'accept a signed package without checking its signature')
    .option('--max-bytes <n>', 'size limit in bytes (default 64 MiB)')
    .action((file: string, flags: VerifyFlags) => {
      if (flags.skipSignature && (flags.jwks || flags.requireSignature)) {
        usage('--skip-signature cannot be combined with --jwks or --require-signature');
      }
      const data = readInput(file);
      let jwks: unknown;
      if (flags.jwks) {
        try {
          jwks = JSON.parse(readFileSync(flags.jwks, 'utf8')) as unknown;
        } catch (err) {
          usage(`cannot read key set ${flags.jwks}: ${(err as Error).message}`);
        }
        if (jwks === null || typeof jwks !== 'object' || Array.isArray(jwks)) usage(`key set ${flags.jwks} is not a JSON object`);
      }
      const options: evidence.VerifyOptions = {
        expectedRoot: flags.root,
        requireAnchor: flags.requireAnchor ?? false,
        requireSignature: flags.requireSignature ?? false,
        allowUnverifiedSignature: flags.skipSignature ?? false,
      };
      if (flags.anchor !== undefined) options.expectedAnchorHash = flags.anchor;
      if (jwks !== undefined) options.jwks = jwks;
      if (flags.maxBytes !== undefined) {
        const limit = Number(flags.maxBytes);
        if (!Number.isSafeInteger(limit) || limit < 0) usage('--max-bytes must be a non-negative integer');
        options.maxBytes = limit;
      }
      const result = evidence.verifyPackage(data, options);
      printResult(result);
      if (!result.ok) process.exit(EXIT_FAILED);
    });

  cmd
    .command('export <caseId>')
    .description("Export a case's evidence package from the auth service")
    .option('-o, --out <file>', 'write the package here (default: <caseId>.evidence.json)')
    .addOption(new Option('--disclose <class...>', 'identifier classes to include in the clear').choices([...evidence.IDENTIFIER_CLASSES]))
    .option('--sign', 'ask the service to sign the package root')
    .addOption(new Option('--state <state>', 'case state').choices(['open', 'decided', 'closed']))
    .option('--url <url>', 'auth service URL (default: configured URL or GRANTEX_URL)')
    .action(async (caseId: string, flags: ExportFlags) => {
      const config = resolveConfig(await loadConfig(defaultConfigPath()));
      const baseUrl = flags.url ?? config?.baseUrl;
      const apiKey = config?.apiKey;
      if (!baseUrl || !apiKey) usage('configure the CLI (grantex config set) or set GRANTEX_URL and GRANTEX_KEY');
      const path = flags.out ?? (SAFE_FILE_STEM.test(caseId) ? `${caseId}.evidence.json` : usage('the case id is not a safe file name; pass --out'));

      const body: Record<string, unknown> = { disclose: [...new Set(flags.disclose ?? [])].sort(), sign: flags.sign ?? false };
      if (flags.state !== undefined) body['state'] = flags.state;
      let response: Response;
      try {
        response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/evidence/cases/${encodeURIComponent(caseId)}/export`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err) {
        console.error(`${chalk.red('FAILED')} export: ${(err as Error).message}`);
        process.exit(EXIT_FAILED);
      }
      const data = new Uint8Array(await response.arrayBuffer());
      if (!response.ok) {
        let detail = response.statusText;
        try {
          const parsed = JSON.parse(new TextDecoder().decode(data)) as { code?: string; message?: string };
          detail = `${parsed.code ?? 'HTTP_ERROR'}: ${parsed.message ?? response.statusText}`;
        } catch {
          // keep the status text
        }
        console.error(`${chalk.red('FAILED')} export: ${response.status} ${detail}`);
        process.exit(EXIT_FAILED);
      }
      const root = response.headers.get('grantex-evidence-root') ?? '';
      const anchor = response.headers.get('grantex-evidence-anchor');
      if (!ROOT.test(root) || (anchor !== null && !AUDIT_HASH.test(anchor))) {
        console.error(`${chalk.red('FAILED')} export: EVIDENCE_ROOT_HEADER_INVALID: response has no valid root or anchor header`);
        process.exit(EXIT_FAILED);
      }
      // Refuse to save a package that does not verify against the root the
      // service says it anchored.
      const options: evidence.VerifyOptions = { expectedRoot: root, requireAnchor: true, allowUnverifiedSignature: true };
      if (anchor !== null) options.expectedAnchorHash = anchor;
      const result = evidence.verifyPackage(data, options);
      if (!result.ok) {
        printResult(result);
        process.exit(EXIT_FAILED);
      }
      try {
        writeFileSync(path, data);
      } catch (err) {
        usage(`cannot write ${path}: ${(err as Error).message}`);
      }
      if (isJsonMode()) {
        console.log(JSON.stringify({ path, root, anchor_hash: anchor, entry_count: result.entryCount }, null, 2));
      } else {
        console.log(`exported: ${path} (${result.entryCount} entries)`);
        console.log(`  root:   ${root}`);
        console.log(`  anchor: ${anchor ?? ''}`);
        console.log(`  verify: grantex evidence verify ${path} --root ${root}`);
      }
    });

  return cmd;
}
