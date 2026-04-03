import { Command } from 'commander';
import chalk from 'chalk';
import * as jose from 'jose';
import { readFileSync } from 'node:fs';
import { isJsonMode } from '../format.js';

interface GrantTokenClaims {
  iss?: string;
  sub?: string;
  agt?: string;
  dev?: string;
  scp?: string[];
  jti?: string;
  grnt?: string;
  iat?: number;
  exp?: number;
  aud?: string | string[];
  bdg?: number;
  parentAgt?: string;
  parentGrnt?: string;
  delegationDepth?: number;
}

interface VerifyResult {
  status: 'valid' | 'expired' | 'invalid_signature' | 'malformed';
  grantId?: string;
  agentDid?: string;
  principal?: string;
  developer?: string;
  scopes?: string[];
  issuedAt?: string;
  expiresAt?: string;
  tokenId?: string;
  budget?: number;
  delegation?: {
    depth: number;
    parentAgent?: string;
    parentGrant?: string;
  };
  algorithm?: string;
  keyId?: string;
  audience?: string | string[];
  revocation?: 'checked_valid' | 'checked_revoked' | 'not_checked';
  elapsedMs?: number;
  mode?: 'offline' | 'online';
  error?: string;
}

function readTokenInput(
  tokenArg: string | undefined,
  opts: { file?: string; stdin?: boolean },
): string {
  if (opts.stdin) {
    // Read from stdin (piped input)
    const fd = require('node:fs').openSync('/dev/stdin', 'r');
    const buf = Buffer.alloc(1024 * 64);
    const n = require('node:fs').readSync(fd, buf);
    require('node:fs').closeSync(fd);
    return buf.subarray(0, n).toString('utf8').trim();
  }
  if (opts.file) {
    return readFileSync(opts.file, 'utf8').trim();
  }
  if (tokenArg) {
    return tokenArg;
  }
  throw new Error('No token provided. Pass a token argument, --file <path>, or --stdin.');
}

function relativeTime(date: Date, now: Date): string {
  const diffMs = date.getTime() - now.getTime();
  const absDiff = Math.abs(diffMs);
  const hours = Math.floor(absDiff / 3600000);
  const minutes = Math.floor((absDiff % 3600000) / 60000);

  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return diffMs > 0 ? `in ${days}d` : `${days}d ago`;
  }
  if (hours > 0) {
    return diffMs > 0 ? `in ${hours}h${minutes > 0 ? ` ${minutes}m` : ''}` : `${hours}h${minutes > 0 ? ` ${minutes}m` : ''} ago`;
  }
  return diffMs > 0 ? `in ${minutes}m` : `${minutes}m ago`;
}

function formatUtcDate(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }) + ' ' + d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    hour12: false,
  }) + ' UTC';
}

function printPretty(result: VerifyResult, header?: jose.ProtectedHeaderParameters, claims?: GrantTokenClaims, verbose?: boolean): void {
  const line = '\u2500'.repeat(45);
  console.log('');
  console.log('  Grantex Grant Token');
  console.log(`  ${line}`);
  console.log('');

  // Status
  if (result.status === 'valid') {
    console.log(`  Status         ${chalk.green('\u2713 Valid')}`);
  } else if (result.status === 'expired') {
    console.log(`  Status         ${chalk.red('\u2717 Expired')}`);
  } else if (result.status === 'invalid_signature') {
    console.log(`  Status         ${chalk.red('\u2717 Invalid Signature')}`);
  } else {
    console.log(`  Status         ${chalk.red('\u2717 Not a valid JWT')}`);
  }

  if (result.grantId) {
    console.log(`  Grant ID       ${result.grantId}`);
  }
  if (result.agentDid) {
    console.log(`  Agent DID      ${result.agentDid}`);
  }
  if (result.principal) {
    console.log(`  Principal      ${result.principal}`);
  }
  if (result.developer) {
    console.log(`  Developer      ${result.developer}`);
  }

  const now = new Date();

  if (result.issuedAt) {
    const iatDate = new Date(result.issuedAt);
    console.log('');
    console.log(`  Issued         ${formatUtcDate(Math.floor(iatDate.getTime() / 1000))} (${relativeTime(iatDate, now)})`);
  }
  if (result.expiresAt) {
    const expDate = new Date(result.expiresAt);
    const expStr = formatUtcDate(Math.floor(expDate.getTime() / 1000));
    const rel = relativeTime(expDate, now);
    if (result.status === 'expired') {
      console.log(`  Expires        ${chalk.red(expStr)} (${chalk.red(rel)})`);
    } else {
      console.log(`  Expires        ${expStr} (${rel})`);
    }
  }

  // Scopes
  if (result.scopes && result.scopes.length > 0) {
    console.log('');
    console.log(`  Scopes (${result.scopes.length})`);
    result.scopes.forEach((scope, i) => {
      const prefix = i < result.scopes!.length - 1 ? '\u251C' : '\u2514';
      console.log(`  ${prefix} ${scope}`);
    });
  }

  // Budget
  if (result.budget !== undefined) {
    console.log('');
    console.log(`  Budget         ${result.budget} remaining`);
  }

  // Delegation
  if (result.delegation) {
    console.log('');
    console.log('  Delegation');
    const depthLabel = result.delegation.depth === 0
      ? 'depth: 0 (direct grant)'
      : `depth: ${result.delegation.depth}`;
    console.log(`  \u2514 ${depthLabel}`);
    if (result.delegation.parentAgent) {
      console.log(`    parent agent: ${result.delegation.parentAgent}`);
    }
    if (result.delegation.parentGrant) {
      console.log(`    parent grant: ${result.delegation.parentGrant}`);
    }
  }

  // Signature
  console.log('');
  if (result.algorithm) {
    const kidPart = result.keyId ? `  kid: ${result.keyId}` : '';
    if (result.status === 'valid') {
      console.log(`  Signature      ${result.algorithm} ${chalk.green('\u2713')}${kidPart}`);
    } else if (result.status === 'invalid_signature') {
      console.log(`  Signature      ${result.algorithm} ${chalk.red('\u2717')}${kidPart}`);
    } else {
      console.log(`  Signature      ${result.algorithm}${kidPart}`);
    }
  }

  // Revocation
  if (result.revocation === 'checked_valid') {
    console.log(`  Revocation     ${chalk.green('\u2713 Not revoked')}`);
  } else if (result.revocation === 'checked_revoked') {
    console.log(`  Revocation     ${chalk.red('\u2717 Revoked')}`);
  } else {
    console.log(`  Revocation     ${chalk.dim('\u25CB Not checked (use --check-revocation)')}`);
  }

  // Timing
  console.log('');
  console.log(`  ${line}`);
  if (result.elapsedMs !== undefined) {
    console.log(`  Verified in ${result.elapsedMs}ms (${result.mode ?? 'offline'})`);
  }

  // Verbose: raw JWT data
  if (verbose && header && claims) {
    console.log('');
    console.log(chalk.bold('  JWT Header'));
    console.log('  ' + JSON.stringify(header, null, 2).split('\n').join('\n  '));
    console.log('');
    console.log(chalk.bold('  JWT Claims'));
    console.log('  ' + JSON.stringify(claims, null, 2).split('\n').join('\n  '));
  }

  // Suggestions for error states
  if (result.status === 'expired') {
    console.log('');
    console.log(chalk.yellow('  Hint: Token has expired. Re-authorize to obtain a new grant token.'));
  } else if (result.status === 'invalid_signature') {
    console.log('');
    console.log(chalk.red('  Warning: Signature verification failed. This token may be tampered with.'));
  }
  console.log('');
}

export function verifyCommand(): Command {
  const cmd = new Command('verify')
    .description('Verify a Grantex grant token and display rich information')
    .argument('[token]', 'Grant token (JWT) to verify')
    .option('--verbose', 'Show full JWT header and claims')
    .option('--json', 'Machine-readable JSON output')
    .option('--check-revocation', 'Perform live revocation check via API')
    .option('--jwks <url>', 'JWKS endpoint URL (overrides auto-discovery)')
    .option('--jwks-file <path>', 'Path to local JWKS JSON file')
    .option('--file <path>', 'Read token from a file')
    .option('--stdin', 'Read token from stdin')
    .action(async (tokenArg: string | undefined, opts: {
      verbose?: boolean;
      json?: boolean;
      checkRevocation?: boolean;
      jwks?: string;
      jwksFile?: string;
      file?: string;
      stdin?: boolean;
    }) => {
      const startTime = performance.now();
      const useJson = opts.json || isJsonMode();

      // Read token
      let token: string;
      try {
        token = readTokenInput(tokenArg, { file: opts.file, stdin: opts.stdin });
      } catch (err) {
        if (useJson) {
          console.log(JSON.stringify({ status: 'error', error: (err as Error).message }));
        } else {
          console.error(chalk.red('\u2717') + ` ${(err as Error).message}`);
        }
        process.exit(1);
        return;
      }

      // Decode header + payload
      let header: jose.ProtectedHeaderParameters;
      let claims: GrantTokenClaims;
      try {
        header = jose.decodeProtectedHeader(token);
        claims = jose.decodeJwt(token) as unknown as GrantTokenClaims;
      } catch {
        const result: VerifyResult = {
          status: 'malformed',
          error: 'Not a valid JWT',
          elapsedMs: Math.round(performance.now() - startTime),
        };
        if (useJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          printPretty(result);
        }
        process.exit(1);
        return;
      }

      // Check expiration
      const now = Math.floor(Date.now() / 1000);
      const isExpired = claims.exp !== undefined && claims.exp < now;

      // Attempt signature verification
      let signatureValid = false;
      let mode: 'offline' | 'online' = 'offline';
      try {
        if (opts.jwksFile) {
          // Offline JWKS file
          const jwksData = JSON.parse(readFileSync(opts.jwksFile, 'utf8'));
          const keySet = jose.createLocalJWKSet(jwksData);
          await jose.jwtVerify(token, keySet, { currentDate: isExpired ? new Date(0) : undefined });
          signatureValid = true;
        } else {
          // Remote JWKS
          const jwksUrl = opts.jwks
            ?? (claims.iss ? `${claims.iss.replace(/\/$/, '')}/.well-known/jwks.json` : undefined);
          if (jwksUrl) {
            mode = 'online';
            const keySet = jose.createRemoteJWKSet(new URL(jwksUrl));
            await jose.jwtVerify(token, keySet, { currentDate: isExpired ? new Date(0) : undefined });
            signatureValid = true;
          }
          // If no jwksUrl, we skip signature verification (offline decode only)
        }
      } catch (err) {
        // Signature verification failed (but token was parseable)
        if (err instanceof jose.errors.JWSSignatureVerificationFailed) {
          signatureValid = false;
        }
        // Other errors (network, etc.) — treat as not verified
      }

      let status: VerifyResult['status'];
      if (!signatureValid && (opts.jwks || opts.jwksFile || claims.iss)) {
        status = isExpired ? 'expired' : 'invalid_signature';
      } else if (isExpired) {
        status = 'expired';
      } else {
        status = signatureValid ? 'valid' : 'valid'; // If no JWKS available, we decoded OK
      }
      // If signature was explicitly checked and failed, override
      if (!signatureValid && (opts.jwks || opts.jwksFile)) {
        status = 'invalid_signature';
      }

      // Revocation check
      let revocation: VerifyResult['revocation'] = 'not_checked';
      if (opts.checkRevocation) {
        try {
          // Dynamically import to avoid requiring config when not needed
          const { requireClient } = await import('../client.js');
          const client = await requireClient();
          const res = await client.tokens.verify(token);
          revocation = res.valid ? 'checked_valid' : 'checked_revoked';
          mode = 'online';
        } catch {
          // If revocation check fails, note it
          revocation = 'not_checked';
        }
      }

      const grantId = claims.grnt ?? claims.jti;
      const result: VerifyResult = {
        status: revocation === 'checked_revoked' ? 'invalid_signature' : status,
        grantId,
        agentDid: claims.agt,
        principal: claims.sub,
        developer: claims.dev,
        scopes: claims.scp,
        issuedAt: claims.iat ? new Date(claims.iat * 1000).toISOString() : undefined,
        expiresAt: claims.exp ? new Date(claims.exp * 1000).toISOString() : undefined,
        tokenId: claims.jti,
        budget: claims.bdg,
        audience: claims.aud,
        ...(claims.delegationDepth !== undefined ? {
          delegation: {
            depth: claims.delegationDepth,
            parentAgent: claims.parentAgt,
            parentGrant: claims.parentGrnt,
          },
        } : {}),
        algorithm: header.alg,
        keyId: header.kid,
        revocation,
        elapsedMs: Math.round(performance.now() - startTime),
        mode,
      };

      if (useJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printPretty(result, header, claims, opts.verbose);
      }

      if (result.status === 'expired' || result.status === 'invalid_signature' || result.status === 'malformed') {
        process.exit(1);
      }
    });

  return cmd;
}
