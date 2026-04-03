/**
 * E2E Tests: Principal Sessions
 *
 * Tests principal session creation, custom expiry, response shape,
 * and multiple sessions for different principals.
 * Run: npx vitest run tests/e2e/principal-sessions.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Grantex } from '@grantex/sdk';

const BASE_URL = process.env.E2E_BASE_URL ?? 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app';

let grantex: Grantex;

beforeAll(async () => {
  const account = await Grantex.signup({ name: `e2e-sessions-${Date.now()}`, mode: 'sandbox' }, { baseUrl: BASE_URL });
  grantex = new Grantex({ apiKey: account.apiKey, baseUrl: BASE_URL });
});

describe('E2E: Principal Session Creation', () => {
  it('creates a principal session with default expiry', async () => {
    const principalId = `user-${Date.now()}@example.com`;
    const session = await grantex.principalSessions.create({
      principalId,
    });

    expect(session).toBeDefined();
    expect(session.sessionToken).toBeDefined();
    expect(typeof session.sessionToken).toBe('string');
    expect(session.sessionToken.length).toBeGreaterThan(0);
    expect(session.dashboardUrl).toBeDefined();
    expect(typeof session.dashboardUrl).toBe('string');
    expect(session.dashboardUrl).toContain('http');
    expect(session.expiresAt).toBeDefined();
    expect(typeof session.expiresAt).toBe('string');

    // Verify the expiresAt is in the future
    const expiresAt = new Date(session.expiresAt);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('creates a session with custom 1-hour expiry', async () => {
    const principalId = `user-1h-${Date.now()}@example.com`;
    const session = await grantex.principalSessions.create({
      principalId,
      expiresIn: '1h',
    });

    expect(session.sessionToken).toBeDefined();
    expect(session.dashboardUrl).toBeDefined();
    expect(session.expiresAt).toBeDefined();

    // Verify expiry is approximately 1 hour from now (within 5-minute margin)
    const expiresAt = new Date(session.expiresAt);
    const expectedMin = Date.now() + 55 * 60 * 1000; // 55 minutes
    const expectedMax = Date.now() + 65 * 60 * 1000; // 65 minutes
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(expectedMin);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(expectedMax);
  });

  it('creates sessions for different principals independently', async () => {
    const session1 = await grantex.principalSessions.create({
      principalId: `user-a-${Date.now()}@example.com`,
    });
    const session2 = await grantex.principalSessions.create({
      principalId: `user-b-${Date.now()}@example.com`,
    });

    expect(session1.sessionToken).not.toBe(session2.sessionToken);
    expect(session1.dashboardUrl).toBeDefined();
    expect(session2.dashboardUrl).toBeDefined();
  });

  it('session token is a valid JWT-like string', async () => {
    const session = await grantex.principalSessions.create({
      principalId: `user-jwt-${Date.now()}@example.com`,
    });

    // JWT should have 3 parts separated by dots
    const parts = session.sessionToken.split('.');
    expect(parts.length).toBe(3);
  });

  it('dashboard URL contains the session context', async () => {
    const session = await grantex.principalSessions.create({
      principalId: `user-dash-${Date.now()}@example.com`,
    });

    // Dashboard URL should be a valid URL
    const url = new URL(session.dashboardUrl);
    expect(url.protocol).toMatch(/^https?:$/);
  });
});
