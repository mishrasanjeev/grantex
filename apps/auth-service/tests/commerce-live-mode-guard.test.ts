/**
 * P0-23 — central Commerce live-mode guard.
 *
 * Verifies the unit-level decision matrix (sandbox/live × mock/plural)
 * and asserts that every payment-touching route file actually imports
 * the guard. The latter check mirrors what
 * `scripts/check-live-mode-guard.mjs` enforces in the release preflight;
 * keeping it as a vitest spec means a missed guard call is caught by
 * the package test job too, not only by the release pipeline.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMMERCE_LIVE_READINESS_REQUIREMENTS,
  ensureCommerceLiveMode,
  getCommerceLiveReadinessSnapshot,
  getCommerceLiveModeStatus,
  isLiveCommerceSideEffect,
} from '../src/lib/commerce/live-mode-guard.js';
import { CommerceHttpError } from '../src/lib/commerce/errors.js';

// vitest.config.ts does NOT set COMMERCE_LIVE_MODE_ENABLED, so the
// default state across this suite is fail-closed (the production
// posture documented in README.md:42).

function stubLiveReadiness(): void {
  vi.stubEnv('COMMERCE_LIVE_MODE_ENABLED', 'true');
  vi.stubEnv('PLURAL_LIVE_ENABLED', 'true');
  for (const requirement of COMMERCE_LIVE_READINESS_REQUIREMENTS) {
    vi.stubEnv(requirement.env, 'true');
  }
}

describe('ensureCommerceLiveMode — decision matrix', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('passes through sandbox + mock (the default playground flow)', () => {
    expect(() =>
      ensureCommerceLiveMode({ environment: 'sandbox', providerKey: 'mock' }),
    ).not.toThrow();
  });

  it('passes through sandbox + no provider key', () => {
    expect(() => ensureCommerceLiveMode({ environment: 'sandbox' })).not.toThrow();
  });

  it('passes live + mock regardless of master switch (mock has no real side effect)', () => {
    vi.stubEnv('COMMERCE_LIVE_MODE_ENABLED', '');
    expect(() =>
      ensureCommerceLiveMode({ environment: 'live', providerKey: 'mock' }),
    ).not.toThrow();
  });

  it('rejects live + unspecified provider when COMMERCE_LIVE_MODE_ENABLED is unset', () => {
    vi.stubEnv('COMMERCE_LIVE_MODE_ENABLED', '');
    let captured: unknown;
    try {
      ensureCommerceLiveMode({ environment: 'live' });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(CommerceHttpError);
    const err = captured as CommerceHttpError;
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('commerce_live_mode_disabled');
    expect(err.options.retryable).toBe(false);
    expect(err.options.details).toMatchObject({ reason: 'live_mode_disabled' });
  });

  it('rejects live + plural when only the master flag is set', () => {
    vi.stubEnv('COMMERCE_LIVE_MODE_ENABLED', 'true');
    vi.stubEnv('PLURAL_LIVE_ENABLED', '');
    let captured: unknown;
    try {
      ensureCommerceLiveMode({ environment: 'live', providerKey: 'plural' });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(CommerceHttpError);
    const err = captured as CommerceHttpError;
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('plural_live_disabled');
    expect(err.options.details).toMatchObject({
      reason: 'plural_live_disabled',
      provider_key: 'plural',
    });
  });

  it('rejects live + plural when flags are set but readiness evidence is missing', () => {
    vi.stubEnv('COMMERCE_LIVE_MODE_ENABLED', 'true');
    vi.stubEnv('PLURAL_LIVE_ENABLED', 'true');
    let captured: unknown;
    try {
      ensureCommerceLiveMode({ environment: 'live', providerKey: 'plural' });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(CommerceHttpError);
    const err = captured as CommerceHttpError;
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('plural_live_disabled');
    expect(err.options.details).toMatchObject({
      reason: 'live_readiness_blocked',
      provider_key: 'plural',
    });
    expect((err.options.details as { blockers: string[] }).blockers)
      .toContain('missing_legal_approval_recorded');
  });

  it('passes live + plural only when flags and all readiness acknowledgements are set', () => {
    stubLiveReadiness();
    expect(() =>
      ensureCommerceLiveMode({ environment: 'live', providerKey: 'plural' }),
    ).not.toThrow();
  });

  it('treats an unspecified environment as live (fail-closed)', () => {
    vi.stubEnv('COMMERCE_LIVE_MODE_ENABLED', '');
    expect(() => ensureCommerceLiveMode({})).toThrow(CommerceHttpError);
  });

  it('rejects sandbox + plural unless PLURAL_SANDBOX_ENABLED is set', () => {
    vi.stubEnv('PLURAL_SANDBOX_ENABLED', '');
    let captured: unknown;
    try {
      ensureCommerceLiveMode({ environment: 'sandbox', providerKey: 'plural' });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(CommerceHttpError);
    const err = captured as CommerceHttpError;
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('plural_live_disabled');
    expect(err.options.details).toMatchObject({ reason: 'plural_sandbox_disabled' });
  });

  it('passes sandbox + plural when PLURAL_SANDBOX_ENABLED is set', () => {
    vi.stubEnv('PLURAL_SANDBOX_ENABLED', 'true');
    expect(() =>
      ensureCommerceLiveMode({ environment: 'sandbox', providerKey: 'plural' }),
    ).not.toThrow();
  });
});

describe('getCommerceLiveModeStatus / isLiveCommerceSideEffect', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reflects current env flags on every call (not cached)', () => {
    vi.stubEnv('COMMERCE_LIVE_MODE_ENABLED', '');
    expect(getCommerceLiveModeStatus().liveModeEnabled).toBe(false);
    vi.stubEnv('COMMERCE_LIVE_MODE_ENABLED', 'true');
    expect(getCommerceLiveModeStatus().liveModeEnabled).toBe(true);
  });

  it('classifies live and plural requests as side-effecting', () => {
    expect(isLiveCommerceSideEffect({ environment: 'sandbox', providerKey: 'mock' })).toBe(false);
    expect(isLiveCommerceSideEffect({ environment: 'sandbox' })).toBe(false);
    // Mock never has a real side effect, even with environment=live.
    expect(isLiveCommerceSideEffect({ environment: 'live', providerKey: 'mock' })).toBe(false);
    expect(isLiveCommerceSideEffect({ environment: 'sandbox', providerKey: 'plural' })).toBe(true);
    expect(isLiveCommerceSideEffect({ environment: 'live', providerKey: 'plural' })).toBe(true);
    expect(isLiveCommerceSideEffect({ environment: 'live' })).toBe(true);
  });

  it('reports a machine-readable live-readiness snapshot without secret values', () => {
    vi.stubEnv('COMMERCE_LIVE_MODE_ENABLED', 'true');
    vi.stubEnv('PLURAL_LIVE_ENABLED', 'true');
    const blocked = getCommerceLiveReadinessSnapshot();
    expect(blocked.startable).toBe(false);
    expect(blocked.blockers).toContain('missing_provider_contract_confirmed');
    expect(blocked.requiredEvidence.map((requirement) => requirement.env))
      .toContain('COMMERCE_LIVE_PROVIDER_CONTRACT_CONFIRMED');
    expect(JSON.stringify(blocked)).not.toMatch(/Bearer\s|sk_live_|pk_live_|-----BEGIN/i);

    stubLiveReadiness();
    const ready = getCommerceLiveReadinessSnapshot();
    expect(ready.startable).toBe(true);
    expect(ready.blockers).toEqual([]);
  });
});

// The inventory below mirrors scripts/check-live-mode-guard.mjs. If a
// new route file starts touching live provider state, add it here AND
// to the script so both gates fire on regressions.
const ROUTES_THAT_MUST_REFERENCE_GUARD = [
  'apps/auth-service/src/routes/commerce-cart-payment.ts',
  'apps/auth-service/src/routes/commerce-provider-credentials.ts',
  'apps/auth-service/src/routes/commerce-provider-webhooks.ts',
];

describe('static inventory: payment-touching routes import the guard', () => {
  for (const rel of ROUTES_THAT_MUST_REFERENCE_GUARD) {
    it(`${rel} imports live-mode-guard`, () => {
      // The test process runs with cwd = apps/auth-service (vitest.config
      // is rooted there), so walk back up to the repo root.
      const abs = join(process.cwd(), '..', '..', rel);
      const src = readFileSync(abs, 'utf-8');
      expect(src).toMatch(/from '\.\.\/lib\/commerce\/live-mode-guard\.js'/);
      expect(src).toMatch(/ensureCommerceLiveMode\s*\(/);
    });
  }
});
