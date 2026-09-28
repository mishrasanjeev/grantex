// SPDX-License-Identifier: Apache-2.0
/**
 * The mock accredited issuer (packages/mock-issuer) and the Agent Passport
 * library (packages/agent-passport), loaded from their sources for tests.
 *
 * The service does not depend on either package, and its typecheck does not
 * reach into them: the modules are imported at run time by path, and only
 * the few members the tests use are typed here. vitest.config.ts resolves
 * the mock issuer's own `@grantex/agent-passport` import to the sources, so
 * nothing has to be built first.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'packages');

export type Jwk = Record<string, unknown>;

export interface PossessionChallenge {
  thumbprint: string;
  challenge: string;
  audience: string;
  subject: string;
}

export interface IssuedAgentPassport {
  attestationId: string;
  passportId: string;
  compact: string;
  externalCredentialHash: string;
  keyThumbprint: string;
  status: { status_list: { uri: string; idx: number } };
  iat: number;
  exp: number;
}

export interface MockIssuer {
  readonly entityId: string;
  readonly statusListBase: string;
  readonly kid: string;
  jwks(): { keys: Jwk[] };
  createPossessionChallenge(params: { agentDid: string; agentPublicJwk: Jwk }): PossessionChallenge;
  issuePassport(request: {
    agentDid: string;
    agentPublicJwk: Jwk;
    possessionProof: string;
    provider: { did: string; [member: string]: unknown };
    agent: { software_name: string; software_version: string; [member: string]: unknown };
    verification: { level: string; [member: string]: unknown };
    lifetimeSeconds?: number;
  }): IssuedAgentPassport;
  buildAttestation(params: { attestationId: string; type?: string }): string;
  revokePassport(attestationId: string): string;
  suspendPassport(attestationId: string): string;
  reinstatePassport(attestationId: string): string;
  /** The signed Token Status List token of list `list`, as the mock's server serves it. */
  tokenStatusList(list: number): string;
}

export interface MockIssuerServer {
  origin: string;
  originMapEntry: string;
  close(): Promise<void>;
}

export interface MockIssuerModule {
  MOCK_ISSUER_ENTITY_ID: string;
  TRUST_MARK_AGENT_IDENTITY: string;
  TRUST_MARK_PROVIDER_ENTITY: string;
  MockIssuer: { create(options?: { ttlSeconds?: number; clock?: () => number }): MockIssuer };
  signPossessionProof(params: { challenge: PossessionChallenge; agentPrivateJwk: Jwk }): string;
  startMockIssuerServer(options: { issuer: MockIssuer }): Promise<MockIssuerServer>;
}

export interface AgentPassportModule {
  issuePassport(params: {
    issuerKey: Jwk;
    iss: string;
    sub: string;
    cnfJwk: Jwk;
    iat: number;
    exp: number;
    status: { status_list: { uri: string; idx: number } };
    claims: Record<string, unknown>;
    vct?: string;
  }): { compact: string; issuerJwt: string };
  externalCredentialHash(compact: string): string;
  jwkThumbprint(jwk: Jwk): string;
}

async function load<T>(path: string): Promise<T> {
  // A computed specifier keeps the service's typecheck out of the package.
  const specifier = pathToFileURL(join(packagesDir, path)).href;
  return await import(/* @vite-ignore */ specifier) as T;
}

export function loadMockIssuer(): Promise<MockIssuerModule> {
  return load<MockIssuerModule>('mock-issuer/src/index.ts');
}

export function loadAgentPassport(): Promise<AgentPassportModule> {
  return load<AgentPassportModule>('agent-passport/src/index.ts');
}
