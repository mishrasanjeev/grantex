// SPDX-License-Identifier: Apache-2.0
/**
 * The parts of status-list reconciliation that need no database: the poll
 * interval floor (owner decision 5), the registry's decision for an
 * attestation, the start jitter, and the flag.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLL_MIN_INTERVAL_MS,
  DEV_POLL_MIN_INTERVAL_FLOOR_MS,
  PRODUCTION_POLL_MIN_INTERVAL_FLOOR_MS,
  deriveAcceptance,
  reconciliationStartDelayMs,
  reconciliationTickMs,
  statusPollMinIntervalConfigError,
  statusPollMinIntervalMs,
} from '../src/lib/registry/status-reconciliation.js';
import { config } from '../src/config.js';

const NOW = new Date('2026-09-28T12:00:00Z');
const active = { status: 'active' as const, suspendedEffectiveFrom: null };
/** A read of the issuer's list still fresh at NOW, and one that has run out. */
const FRESH = new Date(NOW.getTime() + 60_000);
const STALE = new Date(NOW.getTime());

describe('REGISTRY_STATUS_POLL_MIN_INTERVAL_MS', () => {
  it('defaults to the production floor of 30 s', () => {
    expect(DEFAULT_POLL_MIN_INTERVAL_MS).toBe(30_000);
    expect(PRODUCTION_POLL_MIN_INTERVAL_FLOOR_MS).toBe(30_000);
    expect(statusPollMinIntervalMs({ NODE_ENV: 'production' })).toBe(30_000);
    expect(statusPollMinIntervalConfigError({ NODE_ENV: 'production' })).toBeNull();
  });

  it('refuses less than 30 s outside development and tests', () => {
    for (const nodeEnv of ['production', undefined, 'staging']) {
      const env = { NODE_ENV: nodeEnv, REGISTRY_STATUS_POLL_MIN_INTERVAL_MS: '1000' };
      expect(statusPollMinIntervalConfigError(env)).toMatch(/REGISTRY_STATUS_POLL_MIN_INTERVAL_MS/);
      // Refused at startup; if it got past that, the floor still applies.
      expect(statusPollMinIntervalMs(env)).toBe(30_000);
    }
    expect(statusPollMinIntervalConfigError({ NODE_ENV: 'production', REGISTRY_STATUS_POLL_MIN_INTERVAL_MS: '600000' })).toBeNull();
    expect(statusPollMinIntervalMs({ NODE_ENV: 'production', REGISTRY_STATUS_POLL_MIN_INTERVAL_MS: '600000' })).toBe(600_000);
  });

  it('allows down to 1 s in development and tests (owner decision 5)', () => {
    expect(DEV_POLL_MIN_INTERVAL_FLOOR_MS).toBe(1_000);
    for (const nodeEnv of ['development', 'test']) {
      const env = { NODE_ENV: nodeEnv, REGISTRY_STATUS_POLL_MIN_INTERVAL_MS: '1000' };
      expect(statusPollMinIntervalConfigError(env)).toBeNull();
      expect(statusPollMinIntervalMs(env)).toBe(1_000);
      expect(statusPollMinIntervalConfigError({ ...env, REGISTRY_STATUS_POLL_MIN_INTERVAL_MS: '999' })).toMatch(/at least 1000/);
    }
  });

  it('refuses anything that is not a whole number of milliseconds', () => {
    for (const value of ['abc', '1.5e3', '-1', '1000.5', '', ' ']) {
      const env = { NODE_ENV: 'test', REGISTRY_STATUS_POLL_MIN_INTERVAL_MS: value };
      if (value.trim() === '') {
        expect(statusPollMinIntervalConfigError(env)).toBeNull();
      } else {
        expect(statusPollMinIntervalConfigError(env), value).toMatch(/REGISTRY_STATUS_POLL_MIN_INTERVAL_MS/);
      }
    }
  });

  it('ticks four times per interval, never faster than every 250 ms', () => {
    expect(reconciliationTickMs(1_000)).toBe(250);
    expect(reconciliationTickMs(30_000)).toBe(7_500);
  });
});

describe('the registry decision for an attestation', () => {
  it('follows the issuer status list', () => {
    expect(deriveAcceptance({ issuerStatusFreshUntil: FRESH, issuerStatus: 'valid', issuer: active }, NOW)).toEqual({ status: 'valid', cause: 'issuer_status' });
    expect(deriveAcceptance({ issuerStatusFreshUntil: FRESH, issuerStatus: 'suspended', issuer: active }, NOW)).toEqual({ status: 'suspended', cause: 'issuer_status' });
    expect(deriveAcceptance({ issuerStatusFreshUntil: FRESH, issuerStatus: 'revoked', issuer: active }, NOW)).toEqual({ status: 'invalid', cause: 'issuer_status' });
  });

  it('suspends while the issuer is suspended or withdrawn, from the time the suspension takes effect', () => {
    const suspended = { status: 'suspended' as const, suspendedEffectiveFrom: new Date(NOW.getTime() - 1) };
    const later = { status: 'suspended' as const, suspendedEffectiveFrom: new Date(NOW.getTime() + 60_000) };
    const withdrawn = { status: 'withdrawn' as const, suspendedEffectiveFrom: null };
    expect(deriveAcceptance({ issuerStatusFreshUntil: FRESH, issuerStatus: 'valid', issuer: suspended }, NOW)).toEqual({ status: 'suspended', cause: 'issuer' });
    expect(deriveAcceptance({ issuerStatusFreshUntil: FRESH, issuerStatus: 'valid', issuer: later }, NOW)).toEqual({ status: 'valid', cause: 'issuer_status' });
    expect(deriveAcceptance({ issuerStatusFreshUntil: FRESH, issuerStatus: 'valid', issuer: withdrawn }, NOW)).toEqual({ status: 'suspended', cause: 'issuer' });
    // A revoked passport stays INVALID whatever the issuer's state.
    expect(deriveAcceptance({ issuerStatusFreshUntil: FRESH, issuerStatus: 'revoked', issuer: suspended }, NOW)).toEqual({ status: 'invalid', cause: 'issuer_status' });
  });

  it('never returns VALID on a read that is no longer fresh (fail closed)', () => {
    const suspended = { status: 'suspended' as const, suspendedEffectiveFrom: new Date(NOW.getTime() - 1) };
    // valid, but read before its freshness ran out: the entry stays as it
    // is (null), so a SUSPENDED entry is not made VALID on an old read.
    expect(deriveAcceptance({ issuerStatusFreshUntil: STALE, issuerStatus: 'valid', issuer: active }, NOW)).toBeNull();
    expect(deriveAcceptance({ issuerStatusFreshUntil: new Date(NOW.getTime() - 60_000), issuerStatus: 'valid', issuer: active }, NOW)).toBeNull();
    // Anything that is not VALID is still decided on an old read.
    expect(deriveAcceptance({ issuerStatusFreshUntil: STALE, issuerStatus: 'suspended', issuer: active }, NOW)).toEqual({ status: 'suspended', cause: 'issuer_status' });
    expect(deriveAcceptance({ issuerStatusFreshUntil: STALE, issuerStatus: 'revoked', issuer: active }, NOW)).toEqual({ status: 'invalid', cause: 'issuer_status' });
    expect(deriveAcceptance({ issuerStatusFreshUntil: STALE, issuerStatus: 'valid', issuer: suspended }, NOW)).toEqual({ status: 'suspended', cause: 'issuer' });
  });

  it('reads an issuer status it does not know as revoked (fail closed)', () => {
    expect(deriveAcceptance({ issuerStatusFreshUntil: FRESH, issuerStatus: 'unknown' as never, issuer: active }, NOW)).toEqual({ status: 'invalid', cause: 'issuer_status' });
  });
});

describe('start jitter', () => {
  it('is uniform below the bound', () => {
    expect(reconciliationStartDelayMs(30_000, () => 0)).toBe(0);
    expect(reconciliationStartDelayMs(30_000, () => 0.5)).toBe(15_000);
    expect(reconciliationStartDelayMs(30_000, () => 0.999999)).toBeLessThan(30_000);
    expect(reconciliationStartDelayMs(0, () => 0.5)).toBe(0);
  });
});

describe('REGISTRY_STATUS_RECONCILIATION_ENABLED', () => {
  it('is on only for the exact value true', () => {
    const before = process.env['REGISTRY_STATUS_RECONCILIATION_ENABLED'];
    try {
      for (const [value, on] of [[undefined, false], ['false', false], ['TRUE', false], ['1', false], ['true', true]] as const) {
        if (value === undefined) delete process.env['REGISTRY_STATUS_RECONCILIATION_ENABLED'];
        else process.env['REGISTRY_STATUS_RECONCILIATION_ENABLED'] = value;
        expect(config.registryStatusReconciliationEnabled, String(value)).toBe(on);
      }
    } finally {
      if (before === undefined) delete process.env['REGISTRY_STATUS_RECONCILIATION_ENABLED'];
      else process.env['REGISTRY_STATUS_RECONCILIATION_ENABLED'] = before;
    }
  });
});
