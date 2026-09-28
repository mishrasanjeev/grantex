// SPDX-License-Identifier: Apache-2.0
/**
 * The examples in spec/registry-federation.md ("Agent lookup", "Registry
 * manifest") and docs/relying-parties/verifying-agents.md are what the
 * registry serves: the lookup examples carry only the members the code may
 * emit, each documented request is one the routes answer, and the manifest
 * example is exactly what signRegistryManifest builds from the same content
 * and what verifyRegistryManifest accepts. The OpenAPI description and the
 * self-hosting guide carry the routes and the flag.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeProtectedHeader, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  PUBLIC_LOOKUP_MEMBERS,
  RELYING_PARTY_ATTESTATION_MEMBERS,
  RELYING_PARTY_LOOKUP_MEMBERS,
  parseLookupDid,
  parseLookupQuery,
} from '../src/lib/registry/lookup.js';
import {
  REGISTRY_MANIFEST_MEDIA_TYPE,
  REGISTRY_MANIFEST_PATH,
  signRegistryManifest,
  verifyRegistryManifest,
  type RegistryManifestClaims,
} from '../src/lib/registry/manifest.js';
import { buildTestApp, sqlMock } from './helpers.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (path: string) => readFileSync(join(root, path), 'utf-8').replace(/\r\n/g, '\n');
const SPEC = read('spec/registry-federation.md');
const GUIDE = read('docs/relying-parties/verifying-agents.md');
const OPENAPI = read('docs/openapi.yaml');
const SELF_HOSTING = read('docs/self-hosting.md');
const CHANGELOG = read('CHANGELOG.md');
const EXAMPLE_HOST = 'https://registry.example';
/** PUBLIC_BASE_URL and JWT_ISSUER in the test environment. */
const SERVICE_HOST = 'https://grantex.dev';

function specExample(name: string): Record<string, unknown> {
  const match = SPEC.match(new RegExp(`<!-- example: ${name} -->\\s*\`\`\`json\\n([\\s\\S]*?)\\n\`\`\``));
  if (!match) throw new Error(`spec/registry-federation.md has no example ${name}`);
  return JSON.parse(match[1]!) as Record<string, unknown>;
}

function guideBlock(lang: string, name: string): string {
  const match = GUIDE.match(new RegExp(`\`\`\`${lang} ${name}\\n([\\s\\S]*?)\`\`\``));
  if (!match) throw new Error(`the relying-party guide has no ${lang} ${name} block`);
  return match[1]!.trim();
}

function asService<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).split(EXAMPLE_HOST).join(SERVICE_HOST)) as T;
}

/** The URL a documented curl command requests. */
function curlUrl(name: string): URL {
  const match = guideBlock('bash', name).match(/^curl -s "([^"]+)"$/);
  if (!match) throw new Error(`the ${name} block is not a single curl command`);
  return new URL(match[1]!);
}

function expectPublicShape(body: Record<string, unknown>): void {
  for (const member of Object.keys(body)) expect(PUBLIC_LOOKUP_MEMBERS as readonly string[]).toContain(member);
  for (const attestation of body['attestations'] as Array<Record<string, unknown>>) {
    expect(Object.keys(attestation).sort()).toEqual(['expires_at', 'issuer', 'type']);
  }
  for (const key of body['keys'] as Array<Record<string, unknown>>) {
    expect(Object.keys(key).sort()).toEqual(['current', 'status', 'thumbprint']);
  }
}

let app: FastifyInstance;

beforeAll(async () => {
  vi.stubEnv('REGISTRY_PUBLIC_ENDPOINTS_ENABLED', 'true');
  app = await buildTestApp();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await app.close();
});

describe('spec/registry-federation.md: Agent lookup', () => {
  it('the public example carries only public members', () => {
    expectPublicShape(specExample('lookup-public'));
  });

  it('the relying-party example adds only the authenticated members', () => {
    const body = specExample('lookup-relying-party');
    const allowed = [...PUBLIC_LOOKUP_MEMBERS, ...RELYING_PARTY_LOOKUP_MEMBERS] as string[];
    for (const member of Object.keys(body)) expect(allowed).toContain(member);
    expect(Object.keys(body['provider'] as object).sort()).toEqual(['did', 'legal_identifiers', 'name']);
    for (const attestation of body['attestations'] as Array<Record<string, unknown>>) {
      expect(Object.keys(attestation).sort())
        .toEqual(['expires_at', 'issuer', 'type', ...RELYING_PARTY_ATTESTATION_MEMBERS].sort());
    }
  });
});

describe('docs/relying-parties/verifying-agents.md', () => {
  it('each documented lookup is a request the registry accepts and answers', async () => {
    sqlMock.mockResolvedValue([]);
    const did = curlUrl('lookup-by-did');
    expect(parseLookupDid(decodeURIComponent(did.pathname.split('/').pop()!))).toMatchObject({ by: 'did' });
    expect(parseLookupQuery(Object.fromEntries(curlUrl('lookup-by-key').searchParams))).toMatchObject({ by: 'key_thumbprint' });
    expect(parseLookupQuery(Object.fromEntries(curlUrl('lookup-by-credential').searchParams)))
      .toEqual({
        by: 'credential',
        issuer: 'https://issuer.example',
        externalCredentialId: 'case-000123',
        hash: 'sha-256:OiVR9AjgZRd6DJ8n_6dpLox_0KzFKt7gZ9MHpgHXOKQ',
      });
    for (const name of ['lookup-by-did', 'lookup-by-key', 'lookup-by-credential']) {
      const url = curlUrl(name);
      expect(url.origin).toBe(EXAMPLE_HOST);
      const res = await app.inject({ method: 'GET', url: `${url.pathname}${url.search}`, remoteAddress: '192.0.2.10' });
      // The empty store has no such agent: the route exists and parsed the request.
      expect(res.statusCode, name).toBe(404);
      expect(res.json<Record<string, unknown>>()['code']).toBe('NOT_FOUND');
    }
    const manifest = curlUrl('manifest');
    expect(manifest.pathname).toBe(REGISTRY_MANIFEST_PATH);
    const res = await app.inject({ method: 'GET', url: manifest.pathname, remoteAddress: '192.0.2.10' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain(REGISTRY_MANIFEST_MEDIA_TYPE);
  });

  it('the documented answer carries only public members', () => {
    expectPublicShape(JSON.parse(guideBlock('json', 'lookup-by-key-response')) as Record<string, unknown>);
  });
});

describe('spec/registry-federation.md: Registry manifest', () => {
  it('the payload example is what the registry builds from the same state, and it verifies', async () => {
    const documented = specExample('manifest-payload') as unknown as RegistryManifestClaims;
    const listId = documented.acceptance_status_lists[0]!.token_status_list.split('/').pop()!;
    const now = new Date((documented.iat + 90) * 1000);
    const signed = await signRegistryManifest({
      issuers: documented.issuers,
      acceptanceListIds: [listId],
      lastChange: new Date(documented.iat * 1000),
    }, now);
    expect(signed.claims).toEqual(asService(documented));

    const header = decodeProtectedHeader(signed.token);
    const documentedHeader = specExample('manifest-header');
    expect(header.typ).toBe(documentedHeader['typ']);
    expect(Object.keys(header).sort()).toEqual(Object.keys(documentedHeader).sort());

    const jwks = (await app.inject({ method: 'GET', url: '/.well-known/jwks.json' })).json<{ keys: JWK[] }>();
    await expect(verifyRegistryManifest(signed.token, jwks, now, { issuer: SERVICE_HOST })).resolves.toEqual(signed.claims);
  });
});

describe('reference documentation', () => {
  it('docs/openapi.yaml describes the lookup and the manifest', () => {
    expect(OPENAPI).toContain('  /v1/registry/agents/{did}:');
    expect(OPENAPI).toContain('  /v1/registry/agents:');
    expect(OPENAPI).toContain('  /.well-known/agent-registry.json:');
    expect(OPENAPI).toContain(REGISTRY_MANIFEST_MEDIA_TYPE);
  });

  it('the self-hosting guide, .env.example and the changelog name the flag', () => {
    expect(SELF_HOSTING).toContain('`REGISTRY_PUBLIC_ENDPOINTS_ENABLED`');
    expect(read('apps/auth-service/.env.example')).toContain('REGISTRY_PUBLIC_ENDPOINTS_ENABLED');
    const unreleased = CHANGELOG.slice(CHANGELOG.indexOf('## Unreleased'), CHANGELOG.indexOf('\n## ', CHANGELOG.indexOf('## Unreleased') + 5));
    expect(unreleased).toContain('REGISTRY_PUBLIC_ENDPOINTS_ENABLED');
    expect(unreleased).toContain('/.well-known/agent-registry.json');
  });
});
