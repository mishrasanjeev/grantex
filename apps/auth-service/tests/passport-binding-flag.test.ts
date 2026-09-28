// SPDX-License-Identifier: Apache-2.0
/**
 * PASSPORT_BOUND_GRANTS_ENABLED and POST /v1/authorize, without a database.
 *
 * Off (unset, or any value but the exact string `true`), the `passport`
 * member is ignored exactly as main ignores every member it does not know:
 * the same queries run, the same row is written, the same answer comes back.
 * On, a `passport` that is not a bounded string is refused before anything
 * is read. The verification itself runs against real Postgres in
 * tests/passport-binding-postgres.integration.test.ts.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { config } from '../src/config.js';
import { MAX_PASSPORT_LENGTH } from '../src/lib/registry/passport-binding.js';
import { authHeader, buildTestApp, seedAuth, sqlMock, TEST_AGENT } from './helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function seedAuthorize(): void {
  seedAuth();
  sqlMock.mockResolvedValueOnce([]);                  // subscription lookup → free plan
  sqlMock.mockResolvedValueOnce([{ count: '0' }]);    // grant count → 0
  sqlMock.mockResolvedValueOnce([{ id: TEST_AGENT.id }]);
  sqlMock.mockResolvedValueOnce([]);                  // policy lookup
  sqlMock.mockResolvedValueOnce([]);                  // insert
}

async function authorize(extra: Record<string, unknown>) {
  const callsBefore = sqlMock.mock.calls.length;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/authorize',
    headers: authHeader(),
    payload: { agentId: TEST_AGENT.id, principalId: 'user_123', scopes: ['read'], ...extra },
  });
  const calls = sqlMock.mock.calls.slice(callsBefore).map((call) => String((call[0] as TemplateStringsArray).join('?')));
  return { res, calls };
}

describe('PASSPORT_BOUND_GRANTS_ENABLED', () => {
  it('is off unless set to exactly "true"', () => {
    vi.stubEnv('PASSPORT_BOUND_GRANTS_ENABLED', '');
    expect(config.passportBoundGrantsEnabled).toBe(false);
    for (const value of ['TRUE', '1', 'yes', 'true ']) {
      vi.stubEnv('PASSPORT_BOUND_GRANTS_ENABLED', value);
      expect(config.passportBoundGrantsEnabled).toBe(false);
    }
    vi.stubEnv('PASSPORT_BOUND_GRANTS_ENABLED', 'true');
    expect(config.passportBoundGrantsEnabled).toBe(true);
  });
});

describe('POST /v1/authorize with the flag off', () => {
  for (const value of [undefined, 'TRUE', '1']) {
    it(`ignores passport exactly as an unknown member (PASSPORT_BOUND_GRANTS_ENABLED=${String(value)})`, async () => {
      if (value !== undefined) vi.stubEnv('PASSPORT_BOUND_GRANTS_ENABLED', value);

      seedAuthorize();
      const plain = await authorize({});
      seedAuthorize();
      const withPassport = await authorize({ passport: 'not-a-passport~' });
      seedAuthorize();
      const withUnknown = await authorize({ somethingUnknown: 'not-a-passport~' });

      for (const run of [plain, withPassport, withUnknown]) expect(run.res.statusCode).toBe(201);
      expect(withPassport.calls).toEqual(plain.calls);
      expect(withUnknown.calls).toEqual(plain.calls);
      const insert = withPassport.calls.find((text) => text.includes('INSERT INTO auth_requests'))!;
      expect(insert).not.toContain('passport');
      const keys = (body: string) => Object.keys(JSON.parse(body) as Record<string, unknown>).sort();
      expect(keys(withPassport.res.body)).toEqual(keys(plain.res.body));
    });
  }

  it('ignores a passport of any type and size', async () => {
    for (const passport of [42, { compact: 'x' }, 'x'.repeat(MAX_PASSPORT_LENGTH + 1)]) {
      seedAuthorize();
      const { res } = await authorize({ passport });
      expect(res.statusCode).toBe(201);
    }
  });
});

describe('POST /v1/authorize with the flag on', () => {
  it('refuses a passport that is not a non-empty string before reading anything', async () => {
    vi.stubEnv('PASSPORT_BOUND_GRANTS_ENABLED', 'true');
    for (const passport of [42, '', null, ['a~'], { compact: 'a~' }]) {
      seedAuth();
      const { res, calls } = await authorize({ passport });
      expect(res.statusCode, String(passport)).toBe(400);
      expect(res.json<{ code: string; reason: string }>()).toMatchObject({ code: 'passport_malformed', reason: 'not_sd_jwt' });
      expect(calls.filter((text) => !text.includes('api_key'))).toEqual([]);
    }
  });

  it('refuses a passport longer than the bound', async () => {
    vi.stubEnv('PASSPORT_BOUND_GRANTS_ENABLED', 'true');
    seedAuth();
    const { res } = await authorize({ passport: `${'a'.repeat(MAX_PASSPORT_LENGTH)}~` });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string; reason: string }>()).toMatchObject({ code: 'passport_malformed', reason: 'too_large' });
  });
});
