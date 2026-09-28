// SPDX-License-Identifier: Apache-2.0
/**
 * The examples in docs/providers/registering-agents.md, run.
 *
 * The signing snippet is extracted from the page and executed against a
 * challenge the challenge route issues; its proof must verify exactly as the
 * prove route verifies it. Every documented request names a route that
 * exists, and every documented body and response has the shape the routes
 * read and write.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_ROTATION_OVERLAP_SECONDS,
  parseDeclaredRails,
  verifyKeyPossessionProof,
} from '../src/lib/registry/agent-keys.js';
import { jwkThumbprint } from '../src/lib/registry/jwk-thumbprint.js';
import { authHeader, buildTestApp, seedAuth, sqlMock, TEST_AGENT } from './helpers.js';

// Line endings normalised, so a checkout with CRLF reads the same as one with LF.
const page = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'providers', 'registering-agents.md'),
  'utf8',
).split(String.fromCharCode(13)).join('');

function blocks(language: string): string[] {
  return [...page.matchAll(new RegExp('```' + language + '\\n([\\s\\S]*?)```', 'g'))].map((match) => match[1]!);
}

interface HttpExample { method: string; path: string; body?: Record<string, unknown> }

function httpExamples(): HttpExample[] {
  return blocks('http').map((block) => {
    const [requestLine, ...rest] = block.split('\n');
    const [method, path] = requestLine!.split(' ');
    const blank = rest.indexOf('');
    const bodyText = blank === -1 ? '' : rest.slice(blank + 1).join('\n').trim();
    return { method: method!, path: path!, ...(bodyText ? { body: JSON.parse(bodyText) as Record<string, unknown> } : {}) };
  });
}

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

beforeEach(() => {
  sqlMock.mockReset();
  sqlMock.mockResolvedValue([]);
});

describe('docs/providers/registering-agents.md', () => {
  it('documents exactly the key routes, and each one exists', async () => {
    const examples = httpExamples();
    expect(examples.map((example) => `${example.method} ${example.path}`)).toEqual([
      'POST /v1/agents/{agentId}/keys',
      'PUT /v1/agents/{agentId}/declared-rails',
      'POST /v1/agents/{agentId}/keys/{thumbprint}/challenge',
      'POST /v1/agents/{agentId}/keys/{thumbprint}/prove',
      'POST /v1/agents/{agentId}/keys/{oldThumbprint}/rotate',
      'PATCH /v1/agents/{agentId}',
      'POST /v1/agents/{agentId}/keys/{thumbprint}/compromise',
      'GET /v1/agents/{agentId}/keys',
    ]);
    const thumbprint = 'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k';
    for (const example of examples) {
      seedAuth();
      sqlMock.mockResolvedValueOnce([]); // the agent lookup: not this developer's
      const url = example.path.replace('{agentId}', TEST_AGENT.id).replace(/\{\w*[tT]humbprint\}/, thumbprint);
      const body = example.path.endsWith('/rotate')
        ? { replacementThumbprint: thumbprint.replace('k', 'j') }
        : example.path.endsWith('/prove') ? { proof: 'a.b.c' }
          : (example.path.endsWith('/keys') && example.method === 'POST') || example.method === 'PATCH'
            ? { publicJwk: await exportJWK((await generateKeyPair('ES256')).publicKey) }
            : example.body;
      const res = await app.inject({
        method: example.method as 'GET' | 'POST' | 'PUT' | 'PATCH', url, headers: authHeader(), ...(body ? { payload: body } : {}),
      });
      // The route's own 404 (NOT_FOUND), not the router's.
      expect(res.statusCode, `${example.method} ${url}: ${res.body}`).toBe(404);
      expect(res.json(), `${example.method} ${url}`).toMatchObject({ code: 'NOT_FOUND' });
    }
  });

  it('has every key route in docs/openapi.yaml', () => {
    const openapi = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'openapi.yaml'),
      'utf8',
    );
    const lines = openapi.split(String.fromCharCode(10)).map((line) => line.trimEnd());
    const operation = (path: string, method: string) => {
      const at = lines.indexOf(`  ${path}:`);
      if (at === -1) return false;
      for (let i = at + 1; i < lines.length && !/^  \//.test(lines[i]!); i += 1) {
        if (lines[i] === `    ${method}:`) return true;
      }
      return false;
    };
    for (const [path, method] of [
      ['/v1/agents/{id}/keys', 'get'],
      ['/v1/agents/{id}/keys', 'post'],
      ['/v1/agents/{id}/declared-rails', 'put'],
      ['/v1/agents/{id}/keys/{thumbprint}/challenge', 'post'],
      ['/v1/agents/{id}/keys/{thumbprint}/prove', 'post'],
      ['/v1/agents/{id}/keys/{thumbprint}/rotate', 'post'],
      ['/v1/agents/{id}/keys/{thumbprint}/compromise', 'post'],
    ] as const) {
      expect(operation(path, method), `${method.toUpperCase()} ${path}`).toBe(true);
    }
    expect(openapi).toContain('enum: [agent-key-proof+jwt]');
  });

  it('documents request bodies the routes accept', () => {
    const bodies = Object.fromEntries(httpExamples()
      .filter((example) => example.method !== 'GET')
      .map((example) => [example.path.split('/').pop(), example.body]));
    expect(Object.keys(bodies['keys'] ?? {})).toEqual(['publicJwk']);
    expect(parseDeclaredRails(bodies['declared-rails']!['declaredRails'])).toEqual(['ap2', 'ucp']);
    expect(Object.keys(bodies['prove']!)).toEqual(['proof']);
    expect(bodies['rotate']!['overlapSeconds']).toBe(7 * 86_400);
    expect(bodies['rotate']!['overlapSeconds'] as number).toBeLessThanOrEqual(MAX_ROTATION_OVERLAP_SECONDS);
    expect(Object.keys(bodies['compromise']!)).toEqual(['reason']);
    // Making the replacement the registered key after a rotation: PATCH /v1/agents with publicJwk only.
    expect(Object.keys(bodies['{agentId}']!)).toEqual(['publicJwk']);
  });

  it('shows the challenge the route issues, and its signing snippet produces a proof that verifies', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const jwk = await exportJWK(publicKey);
    const thumbprint = jwkThumbprint(jwk);

    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: TEST_AGENT.id, did: TEST_AGENT.did, status: 'active', declared_rails: [], key_thumbprint: null }]);
    sqlMock.mockResolvedValueOnce([{ thumbprint, agent_id: TEST_AGENT.id, jwk, alg: 'ES256', status: 'pending' }]);
    sqlMock.mockResolvedValueOnce([]); // supersede earlier challenges
    sqlMock.mockResolvedValueOnce([{ expires_at: new Date(Date.now() + 300_000) }]);
    const res = await app.inject({
      method: 'POST', url: `/v1/agents/${TEST_AGENT.id}/keys/${thumbprint}/challenge`, headers: authHeader(),
    });
    expect(res.statusCode, res.body).toBe(201);
    const challenge = res.json<Record<string, string>>();

    const documented = JSON.parse(blocks('json')[0]!) as Record<string, string>;
    expect(Object.keys(challenge).sort()).toEqual(Object.keys(documented).sort());
    expect(challenge['typ']).toBe(documented['typ']);
    expect(challenge['audience']).toBe(documented['audience']);

    const snippet = blocks('js')[0]!;
    expect(snippet).toContain("import { SignJWT } from 'jose';");
    const body = snippet.replace("import { SignJWT } from 'jose';", '').replace('export async function', 'async function');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const signPossessionProof = new Function('SignJWT', `${body}\nreturn signPossessionProof;`)(SignJWT) as
      (key: unknown, challenge: Record<string, string>) => Promise<string>;
    const proof = await signPossessionProof(privateKey, challenge);

    const verified = await verifyKeyPossessionProof(proof, { jwk, alg: 'ES256', thumbprint }, {
      audience: challenge['audience']!, agentId: TEST_AGENT.id,
    });
    expect(verified.nonce).toBe(challenge['challenge']);
  });
});
