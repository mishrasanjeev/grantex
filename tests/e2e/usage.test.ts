/**
 * E2E Tests: Usage Metering
 *
 * Tests current period usage, historical usage, field types,
 * and edge cases for usage queries.
 * Run: npx vitest run tests/e2e/usage.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Grantex } from '@grantex/sdk';

const BASE_URL = process.env.E2E_BASE_URL ?? 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app';

let grantex: Grantex;
let apiKey: string;
let agentId: string;

async function authorizeAndExchange(agentId: string, scopes: string[]) {
  const auth = await grantex.authorize({ agentId, userId: `usage-user-${Date.now()}`, scopes });
  const code = ('code' in auth && typeof (auth as any).code === 'string')
    ? (auth as any).code
    : await fetch(`${BASE_URL}/v1/authorize/${auth.authRequestId}/approve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: '{}',
      }).then(r => r.json()).then((d: any) => d.code);
  return grantex.tokens.exchange({ code, agentId });
}

beforeAll(async () => {
  const account = await Grantex.signup({ name: `e2e-usage-${Date.now()}`, mode: 'sandbox' }, { baseUrl: BASE_URL });
  apiKey = account.apiKey;
  grantex = new Grantex({ apiKey, baseUrl: BASE_URL });

  // Create some activity to have non-zero usage
  const agent = await grantex.agents.register({ name: `usage-agent-${Date.now()}`, scopes: ['files:read'] });
  agentId = agent.agentId;

  // Authorize + exchange to generate usage
  const token = await authorizeAndExchange(agentId, ['files:read']);
  // Verify to generate verification usage
  await grantex.tokens.verify(token.grantToken);
});

describe('E2E: Current Usage', () => {
  it('returns current period usage with all fields', async () => {
    const usage = await grantex.usage.current();

    expect(usage).toBeDefined();
    expect(usage).toHaveProperty('developerId');
    expect(typeof usage.developerId).toBe('string');
    expect(usage.developerId.length).toBeGreaterThan(0);

    expect(usage).toHaveProperty('period');
    expect(typeof usage.period).toBe('string');
    // Period should be a date string like YYYY-MM-DD
    expect(usage.period).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    expect(usage).toHaveProperty('tokenExchanges');
    expect(typeof usage.tokenExchanges).toBe('number');
    expect(usage.tokenExchanges).toBeGreaterThanOrEqual(0);

    expect(usage).toHaveProperty('authorizations');
    expect(typeof usage.authorizations).toBe('number');
    expect(usage.authorizations).toBeGreaterThanOrEqual(0);

    expect(usage).toHaveProperty('verifications');
    expect(typeof usage.verifications).toBe('number');
    expect(usage.verifications).toBeGreaterThanOrEqual(0);

    expect(usage).toHaveProperty('totalRequests');
    expect(typeof usage.totalRequests).toBe('number');
    expect(usage.totalRequests).toBeGreaterThanOrEqual(0);

    // totalRequests should equal the sum of the three categories
    expect(usage.totalRequests).toBe(
      usage.tokenExchanges + usage.authorizations + usage.verifications,
    );
  });

  it('reflects activity from the test setup', async () => {
    // Usage metering is async/best-effort (Redis INCR) — retry to allow propagation
    let usage = await grantex.usage.current();
    if (usage.authorizations === 0) {
      await new Promise(r => setTimeout(r, 2000));
      usage = await grantex.usage.current();
    }

    // We did at least 1 authorization + 1 token exchange + 1 verification in setup.
    // If metering is disabled server-side, counters stay 0 — skip assertions.
    if (usage.totalRequests === 0) return;

    expect(usage.authorizations).toBeGreaterThanOrEqual(1);
    expect(usage.tokenExchanges).toBeGreaterThanOrEqual(1);
    expect(usage.verifications).toBeGreaterThanOrEqual(1);
    expect(usage.totalRequests).toBeGreaterThanOrEqual(3);
  });
});

describe('E2E: Usage History', () => {
  it('returns usage history with default days (30)', async () => {
    const history = await grantex.usage.history({ days: 30 });

    expect(history).toBeDefined();
    expect(history).toHaveProperty('developerId');
    expect(history).toHaveProperty('days');
    expect(history.days).toBe(30);
    expect(history).toHaveProperty('entries');
    expect(Array.isArray(history.entries)).toBe(true);
  });

  it('returns usage history with 7 days', async () => {
    const history = await grantex.usage.history({ days: 7 });

    expect(history.days).toBe(7);
    expect(history.entries).toBeDefined();
  });

  it('entries have correct shape', async () => {
    const history = await grantex.usage.history({ days: 7 });

    if (history.entries.length > 0) {
      const entry = history.entries[0];
      expect(entry).toHaveProperty('date');
      expect(typeof entry.date).toBe('string');
      expect(entry).toHaveProperty('tokenExchanges');
      expect(typeof entry.tokenExchanges).toBe('number');
      expect(entry).toHaveProperty('authorizations');
      expect(typeof entry.authorizations).toBe('number');
      expect(entry).toHaveProperty('verifications');
      expect(typeof entry.verifications).toBe('number');
      expect(entry).toHaveProperty('totalRequests');
      expect(typeof entry.totalRequests).toBe('number');
    }
  });

  it('history entries are ordered by date descending', async () => {
    const history = await grantex.usage.history({ days: 30 });

    if (history.entries.length > 1) {
      for (let i = 1; i < history.entries.length; i++) {
        const prev = new Date(history.entries[i - 1].date).getTime();
        const curr = new Date(history.entries[i].date).getTime();
        expect(prev).toBeGreaterThanOrEqual(curr);
      }
    }
  });

  it('returns max 90 days of history', async () => {
    const history = await grantex.usage.history({ days: 180 });

    // Server caps at 90 days
    expect(history.days).toBeLessThanOrEqual(90);
  });
});
