#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// grantex-mock-issuer: the mock issuer for scripts and demos.
//
//   keys            print the entity id, status_list_base and the public JWKS
//   serve           serve the JWKS and the status lists on 127.0.0.1
//   issue-passport  prove possession of an agent key and issue a passport
//   attest          print (and optionally POST) the attestation of a passport
//   revoke | suspend | reinstate | status   change or read a passport's status entry
//
// Every command takes --dir (or MOCK_ISSUER_DIR): the directory with the
// issuer key and state. Output is JSON on stdout (attest prints the JWS);
// refusals go to stderr as "<code>: <message>" with exit status 1, usage
// errors with exit status 2. Private keys are never printed.

import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { jwkThumbprint, type Jwk } from '@grantex/agent-passport';
import { MockIssuerError } from './errors.ts';
import {
  MockIssuer,
  TRUST_MARK_AGENT_IDENTITY,
  TRUST_MARK_PROVIDER_ENTITY,
  type MockAttestationType,
  type MockIssuerOptions,
} from './issuer.ts';
import { signPossessionProof } from './possession.ts';
import { DEFAULT_ATTESTATION_PATH, postAttestation } from './registry-client.ts';
import { startMockIssuerServer } from './server.ts';

const USAGE = `usage: grantex-mock-issuer <command> [--dir DIR] [options]

commands:
  keys
  serve            [--port N] [--ttl SECONDS | --standard-ttl]
  issue-passport   (--agent-key FILE | --generate-agent-key) [--agent-did DID]
                   [--provider-did DID] [--provider-name NAME]
                   [--software-name NAME] [--software-version VERSION]
                   [--level LEVEL] [--declared-limits JSON] [--lifetime-days N]
                   [--out FILE]
  attest           --attestation-id ID [--type agent.identity|provider.entity]
                   [--registry URL] [--registry-path PATH]
  revoke | suspend | reinstate | status   --attestation-id ID

--dir defaults to $MOCK_ISSUER_DIR. attest --registry POSTs the compact JWS
as application/grantex-attestation+jwt; the registry takes no API key.`;

const FLAGS = new Set(['generate-agent-key', 'standard-ttl']);

class UsageError extends Error {}

function parse(argv: string[]): { command: string; options: Map<string, string> } {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') throw new UsageError('no command given');
  const options = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (!arg.startsWith('--')) throw new UsageError(`unexpected argument ${arg}`);
    const name = arg.slice(2);
    if (FLAGS.has(name)) {
      options.set(name, 'true');
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined) throw new UsageError(`--${name} needs a value`);
    options.set(name, value);
    i += 1;
  }
  return { command, options };
}

function required(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (value === undefined || value === '') throw new UsageError(`--${name} is required`);
  return value;
}

function positiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(n)) throw new UsageError(`--${name} must be a whole number`);
  return n;
}

function openIssuer(options: Map<string, string>): MockIssuer {
  const dir = options.get('dir') ?? process.env.MOCK_ISSUER_DIR;
  if (dir === undefined || dir === '') throw new UsageError('--dir (or MOCK_ISSUER_DIR) is required');
  const issuerOptions: MockIssuerOptions = { dir: resolve(dir) };
  if (options.has('ttl')) issuerOptions.ttlSeconds = positiveInt(options.get('ttl')!, 'ttl');
  else if (options.has('standard-ttl')) issuerOptions.ttlProfile = 'standard';
  return MockIssuer.create(issuerOptions);
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** The agent's key pair: read from a file, or generated and written (mode 0600) under the state directory. */
function agentKey(issuer: MockIssuer, options: Map<string, string>): { privateJwk: Jwk; publicJwk: Jwk; file: string } {
  let privateJwk: Jwk;
  let file: string;
  if (options.has('agent-key')) {
    file = resolve(options.get('agent-key')!);
    privateJwk = JSON.parse(readFileSync(file, 'utf8')) as Jwk;
  } else if (options.has('generate-agent-key')) {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    privateJwk = privateKey.export({ format: 'jwk' }) as Jwk;
    const agentsDir = join(issuer.dir!, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    file = join(agentsDir, `${jwkThumbprint(privateJwk)}.json`);
    writeFileSync(file, `${JSON.stringify(privateJwk)}\n`, { mode: 0o600, flag: 'wx' });
  } else {
    throw new UsageError('--agent-key FILE or --generate-agent-key is required');
  }
  if (typeof privateJwk.d !== 'string') throw new UsageError('the agent key file must hold a private JWK');
  const publicJwk: Jwk = { kty: privateJwk.kty };
  for (const member of ['crv', 'x', 'y'] as const) if (privateJwk[member] !== undefined) publicJwk[member] = privateJwk[member];
  return { privateJwk, publicJwk, file };
}

function attestationType(value: string | undefined): MockAttestationType {
  if (value === undefined || value === 'agent.identity' || value === TRUST_MARK_AGENT_IDENTITY) return TRUST_MARK_AGENT_IDENTITY;
  if (value === 'provider.entity' || value === TRUST_MARK_PROVIDER_ENTITY) return TRUST_MARK_PROVIDER_ENTITY;
  throw new UsageError('--type must be agent.identity or provider.entity');
}

async function run(argv: string[]): Promise<void> {
  const { command, options } = parse(argv);
  switch (command) {
    case 'keys': {
      const issuer = openIssuer(options);
      print({ entity_id: issuer.entityId, status_list_base: issuer.statusListBase, kid: issuer.kid, jwks: issuer.jwks() });
      return;
    }
    case 'serve': {
      const issuer = openIssuer(options);
      const port = options.has('port') ? positiveInt(options.get('port')!, 'port') : 0;
      const server = await startMockIssuerServer({ issuer, port });
      // One line, so a script can read it before the server's first request.
      process.stdout.write(`${JSON.stringify({
        origin: server.origin,
        entity_id: issuer.entityId,
        jwks_uri: `${server.origin}/.well-known/jwks.json`,
        status_list_base: issuer.statusListBase,
        ttl: issuer.ttlSeconds,
        origin_map: server.originMapEntry,
      })}\n`);
      const stop = () => void server.close().then(() => process.exit(0));
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      return;
    }
    case 'issue-passport': {
      const issuer = openIssuer(options);
      const agent = agentKey(issuer, options);
      const agentDid = options.get('agent-did') ?? 'did:web:provider.example:agents:shopper-01';
      // Both sides of the possession proof: the issuer's challenge, the agent's signature.
      const challenge = issuer.createPossessionChallenge({ agentDid, agentPublicJwk: agent.publicJwk });
      const possessionProof = signPossessionProof({ challenge, agentPrivateJwk: agent.privateJwk });
      const provider: { did: string; name?: string } = { did: options.get('provider-did') ?? 'did:web:provider.example' };
      if (options.has('provider-name')) provider.name = options.get('provider-name')!;
      const agentClaim: { software_name: string; software_version: string; declared_limits?: Record<string, unknown> } = {
        software_name: options.get('software-name') ?? 'Nimbus Shopper',
        software_version: options.get('software-version') ?? '2.4',
      };
      if (options.has('declared-limits')) {
        agentClaim.declared_limits = JSON.parse(options.get('declared-limits')!) as Record<string, unknown>;
      }
      const request = {
        agentDid,
        agentPublicJwk: agent.publicJwk,
        possessionProof,
        provider,
        agent: agentClaim,
        verification: { level: options.get('level') ?? 'standard' },
        ...(options.has('lifetime-days')
          ? { lifetimeSeconds: positiveInt(options.get('lifetime-days')!, 'lifetime-days') * 86_400 }
          : {}),
      };
      const issued = issuer.issuePassport(request);
      const output = {
        attestation_id: issued.attestationId,
        passport_id: issued.passportId,
        passport: issued.compact,
        external_credential_hash: issued.externalCredentialHash,
        key_thumbprint: issued.keyThumbprint,
        status: issued.status,
        iat: issued.iat,
        exp: issued.exp,
        agent_key_file: agent.file,
      };
      if (options.has('out')) {
        writeFileSync(resolve(options.get('out')!), `${JSON.stringify(output, null, 2)}\n`);
        process.stdout.write(`${issued.attestationId}\n`);
      } else {
        print(output);
      }
      return;
    }
    case 'attest': {
      const issuer = openIssuer(options);
      const attestation = issuer.buildAttestation({
        attestationId: required(options, 'attestation-id'),
        type: attestationType(options.get('type')),
      });
      process.stdout.write(`${attestation}\n`);
      if (options.has('registry')) {
        const result = await postAttestation({
          registryBaseUrl: options.get('registry')!,
          attestation,
          path: options.get('registry-path') ?? DEFAULT_ATTESTATION_PATH,
        });
        process.stderr.write(`${JSON.stringify({ registry_status: result.status, registry_body: result.body })}\n`);
      }
      return;
    }
    case 'revoke':
    case 'suspend':
    case 'reinstate':
    case 'status': {
      const issuer = openIssuer(options);
      const attestationId = required(options, 'attestation-id');
      const status =
        command === 'revoke'
          ? issuer.revokePassport(attestationId)
          : command === 'suspend'
            ? issuer.suspendPassport(attestationId)
            : command === 'reinstate'
              ? issuer.reinstatePassport(attestationId)
              : issuer.passportStatus(attestationId);
      print({ attestation_id: attestationId, status });
      return;
    }
    default:
      throw new UsageError(`unknown command ${command}`);
  }
}

run(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof UsageError) {
    process.stderr.write(`grantex-mock-issuer: ${error.message}\n\n${USAGE}\n`);
    process.exit(2);
  }
  if (error instanceof MockIssuerError) {
    const detail = error.httpStatus === undefined ? '' : ` (HTTP ${error.httpStatus})`;
    process.stderr.write(`grantex-mock-issuer: ${error.code}: ${error.message}${detail}\n`);
    process.exit(1);
  }
  // Anything else is a defect or an environment problem: report it and fail.
  process.stderr.write(`grantex-mock-issuer: ${(error as Error).message ?? String(error)}\n`);
  process.exit(1);
});
