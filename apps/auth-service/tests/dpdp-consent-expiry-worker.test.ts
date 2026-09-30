import { afterEach, describe, expect, it, vi } from 'vitest';
import { startDpdpConsentExpiryWorker, stopDpdpConsentExpiryWorker } from '../src/workers/dpdpConsentExpiry.js';

const quiet = {
  info: () => {}, error: () => {}, warn: () => {}, debug: () => {}, fatal: () => {}, child: () => quiet,
} as never;

afterEach(() => {
  stopDpdpConsentExpiryWorker();
  vi.unstubAllEnvs();
});

describe('the DPDP consent expiry worker', () => {
  it('does not start unless DPDP_CONSENT_EXPIRY_ENABLED is exactly true', () => {
    const sql = vi.fn() as never;
    expect(startDpdpConsentExpiryWorker(sql, quiet)).toBe(false);
    vi.stubEnv('DPDP_CONSENT_EXPIRY_ENABLED', '1');
    expect(startDpdpConsentExpiryWorker(sql, quiet)).toBe(false);
    vi.stubEnv('DPDP_CONSENT_EXPIRY_ENABLED', 'true');
    expect(startDpdpConsentExpiryWorker(sql, quiet)).toBe(true);
    // Once started, a second start is a no-op.
    expect(startDpdpConsentExpiryWorker(sql, quiet)).toBe(false);
  });
});
