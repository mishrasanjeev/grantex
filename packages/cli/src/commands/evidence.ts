import { Command, Option } from 'commander';
import chalk from 'chalk';
import { readFileSync, writeFileSync } from 'node:fs';
import type { evidence as EvidenceModule } from '@grantex/sdk';
import { defaultConfigPath, loadConfig, resolveConfig } from '../config.js';
import { isJsonMode } from '../format.js';

/** Exit codes: 0 verified, 1 verification or export failed, 2 usage or input error. */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

/** The first @grantex/sdk release that ships the evidence module. */
export const EVIDENCE_SDK_VERSION = '0.7.0';

const SAFE_FILE_STEM = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;
const ROOT = /^sha256:[0-9a-f]{64}$/;
const AUDIT_HASH = /^[0-9a-f]{64}$/;
const IDENTIFIER_CLASSES = ['approver', 'content', 'principal', 'record', 'subject'];
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

type Evidence = typeof EvidenceModule;

/**
 * Load the evidence module lazily, so the CLI still starts (and every other
 * command works) with an older @grantex/sdk that does not ship it.
 */
export async function loadEvidence(importer: () => Promise<Record<string, unknown>> = () => import('@grantex/sdk')): Promise<Evidence> {
  let sdk: Record<string, unknown>;
  try {
    sdk = await importer();
  } catch (err) {
    return usage(`cannot load @grantex/sdk: ${(err as Error).message}`);
  }
  let module: Evidence | undefined;
  try {
    module = sdk['evidence'] as Evidence | undefined;
  } catch {
    module = undefined; // some module loaders throw for a missing export instead of returning undefined
  }
  if (!module || typeof module.verifyPackage !== 'function') {
    return usage(`grantex evidence requires @grantex/sdk >= ${EVIDENCE_SDK_VERSION}; upgrade @grantex/sdk`);
  }
  return module;
}

function describeTrust(result: EvidenceModule.VerificationResult): string[] {
  const anchor = {
    absent: 'absent',
    'internal-consistency-only': 'internal-consistency-only (verify the service signature, or pin --anchor from the audit log)',
    pinned: 'pinned to the --anchor hash you supplied',
    signed: 'covered by the verified service signature',
  }[result.anchorStatus];
  const signature = {
    absent: 'absent',
    unchecked: 'present but not checked (--skip-signature)',
    verified: `verified (kid ${String(result.signatureKid)})`,
  }[result.signatureStatus];
  const lines = ['  root:      matches --root', `  anchor:    ${anchor}`, `  signature: ${signature}`];
  if (result.unsourcedInputs) lines.push(`  unsourced policy inputs: ${result.unsourcedInputs}`);
  if (result.lateEntries) lines.push(`  entries recorded late:   ${result.lateEntries}`);
  if (result.tenantAssertedEntries) lines.push(`  tenant-asserted entries: ${result.tenantAssertedEntries}`);
  return lines;
}

function printResult(evidence: Evidence, result: EvidenceModule.VerificationResult): void {
  if (isJsonMode()) {
    console.log(JSON.stringify(evidence.verificationResultToJson(result), null, 2));
    return;
  }
  if (result.ok) {
    console.log(`${chalk.green('verified')}: ${result.entryCount} entries, root ${result.root}`);
    for (const line of describeTrust(result)) console.log(line);
    return;
  }
  console.error(`${chalk.red('FAILED')} ${result.code}: ${result.message}`);
  const rows: Array<[string, unknown]> = [['entry', result.entryIndex], ['field', result.fieldPath], ['expected', result.expected], ['actual', result.actual]];
  for (const [label, value] of rows) {
    if (value !== null && value !== undefined) console.error(`  ${`${label}:`.padEnd(9)} ${String(value)}`);
  }
}

function usage(message: string): never {
  console.error(`error: ${message}`);
  process.exit(EXIT_USAGE);
}

function evidenceExportUrl(baseUrl: string, caseId: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return usage('--url must be an absolute http(s) URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return usage('--url must use http or https');
  }
  const prefix = url.pathname.replace(/\/$/, '');
  url.pathname = `${prefix}/v1/evidence/cases/${encodeURIComponent(caseId)}/export`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function localOutputPath(candidate: string): string {
  if (URL_SCHEME.test(candidate) && !WINDOWS_DRIVE_PATH.test(candidate)) {
    return usage('--out must be a local file path, not a URL');
  }
  return candidate;
}

interface VerifyFlags {
  root?: string;
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
  url?: string;
  timeout?: string;
}

function readInput(file: string): Uint8Array {
  try {
    return file === '-' ? readFileSync(0) : readFileSync(file);
  } catch (err) {
    return usage(`cannot read ${file}: ${(err as Error).message}`);
  }
}

export function evidenceCommand(importer?: () => Promise<Record<string, unknown>>): Command {
  const cmd = new Command('evidence').description('Verify and export evidence packages');

  cmd
    .command('verify <package>')
    .description('Verify an evidence package against a trusted root (exits 1 on any break, 2 on usage errors)')
    .option('--root <root>', 'trusted package root, sha256:<64 hex> (required)')
    .option('--anchor <hash>', 'trusted anchor audit entry hash (64 hex)')
    .option('--require-anchor', 'fail when the package has no anchor')
    .option('--jwks <file>', 'JSON Web Key Set file to verify the service signature')
    .option('--require-signature', 'fail when the package is not signed')
    .option('--skip-signature', 'accept a signed package without checking its signature')
    .option('--max-bytes <n>', 'size limit in bytes (default 64 MiB)')
    .action(async (file: string, flags: VerifyFlags) => {
      if (flags.root === undefined || !ROOT.test(flags.root)) usage('--root must be the trusted package root, sha256:<64 lower-case hex digits>');
      if (flags.anchor !== undefined && !AUDIT_HASH.test(flags.anchor)) usage('--anchor must be 64 lower-case hex digits');
      let maxBytes: number | undefined;
      if (flags.maxBytes !== undefined) {
        maxBytes = Number(flags.maxBytes);
        if (!/^[0-9]+$/.test(flags.maxBytes) || !Number.isSafeInteger(maxBytes)) usage('--max-bytes must not be negative');
      }
      if (flags.skipSignature && (flags.jwks || flags.requireSignature)) usage('--skip-signature cannot be combined with --jwks or --require-signature');
      const evidence = await loadEvidence(importer);
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
      const options: EvidenceModule.VerifyOptions = {
        expectedRoot: flags.root,
        requireAnchor: flags.requireAnchor ?? false,
        requireSignature: flags.requireSignature ?? false,
        allowUnverifiedSignature: flags.skipSignature ?? false,
      };
      if (flags.anchor !== undefined) options.expectedAnchorHash = flags.anchor;
      if (jwks !== undefined) options.jwks = jwks;
      if (maxBytes !== undefined) options.maxBytes = maxBytes;
      const result = evidence.verifyPackage(data, options);
      printResult(evidence, result);
      if (!result.ok) process.exit(EXIT_FAILED);
    });

  cmd
    .command('export <caseId>')
    .description("Export a case's evidence package from the auth service")
    .option('-o, --out <file>', 'write the package here (default: <caseId>.evidence.json)')
    .addOption(new Option('--disclose <class...>', 'classes to include in the clear (needs permission on the service)').choices(IDENTIFIER_CLASSES))
    .option('--sign', 'ask the service to sign the package root and anchor')
    .option('--url <url>', 'auth service URL (default: configured URL or GRANTEX_URL)')
    .option('--timeout <seconds>', 'request timeout in seconds', '30')
    .action(async (caseId: string, flags: ExportFlags) => {
      const config = resolveConfig(await loadConfig(defaultConfigPath()));
      const baseUrl = flags.url ?? config?.baseUrl;
      const apiKey = flags.url === undefined ? config?.apiKey : process.env['GRANTEX_KEY'];
      if (flags.url !== undefined && !process.env['GRANTEX_KEY']) usage('--url requires GRANTEX_KEY so saved API keys are not sent to ad-hoc URLs');
      if (!baseUrl || !apiKey) usage('configure the CLI (grantex config set) or set GRANTEX_URL and GRANTEX_KEY');
      const outFile = localOutputPath(flags.out ?? (SAFE_FILE_STEM.test(caseId) ? `${caseId}.evidence.json` : usage('the case id is not a safe file name; pass --out')));
      const timeoutSeconds = Number(flags.timeout ?? '30');
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) usage('--timeout must be a positive number of seconds');
      const evidence = await loadEvidence(importer);
      const exportUrl = evidenceExportUrl(baseUrl, caseId);

      const body = { disclose: [...new Set(flags.disclose ?? [])].sort(), sign: flags.sign ?? false };
      let response: Response;
      let data: Uint8Array;
      try {
        // lgtm[js/file-access-to-http]
        response = await fetch(exportUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(Math.round(timeoutSeconds * 1000)),
        });
        data = new Uint8Array(await response.arrayBuffer());
      } catch (err) {
        console.error(`${chalk.red('FAILED')} export: ${(err as Error).message}`);
        process.exit(EXIT_FAILED);
      }
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
      // Refuse to save a package that does not verify against the root and anchor the service reported.
      const options: EvidenceModule.VerifyOptions = { expectedRoot: root, requireAnchor: true, allowUnverifiedSignature: true };
      if (anchor !== null) options.expectedAnchorHash = anchor;
      const result = evidence.verifyPackage(data, options);
      if (!result.ok) {
        printResult(evidence, result);
        process.exit(EXIT_FAILED);
      }
      try {
        // Evidence packages are byte-significant; data was verified against the trusted root and anchor above.
        // lgtm[js/http-to-file-access]
        writeFileSync(outFile, data);
      } catch (err) {
        usage(`cannot write ${outFile}: ${(err as Error).message}`);
      }
      if (isJsonMode()) {
        console.log(JSON.stringify({ path: outFile, root, anchor_hash: anchor, entry_count: result.entryCount }, null, 2));
      } else {
        console.log(`exported: ${outFile} (${result.entryCount} entries)`);
        console.log(`  root:   ${root}`);
        console.log(`  anchor: ${anchor ?? ''}`);
        console.log(`  verify: grantex evidence verify ${outFile} --root ${root}${anchor ? ` --anchor ${anchor}` : ''}`);
      }
    });

  return cmd;
}
