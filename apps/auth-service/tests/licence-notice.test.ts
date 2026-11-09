// SPDX-License-Identifier: LicenseRef-Orchestrum-Personal-Use-1.0
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { LICENCE_STARTUP_NOTICE, logLicenceNotice } from '../src/lib/licence-notice.js';

describe('startup licence notice', () => {
  it('states the licence, the agreement requirement and where to look', () => {
    expect(LICENCE_STARTUP_NOTICE).toContain('Orchestrum Personal Use License 1.0');
    expect(LICENCE_STARTUP_NOTICE).toContain('signed agreement with Orchestrum Technologies LLP');
    expect(LICENCE_STARTUP_NOTICE).toContain('COMMERCIAL-LICENSE.md');
    expect(LICENCE_STARTUP_NOTICE).toContain('sanjeev@orchestrum.in');
    expect(LICENCE_STARTUP_NOTICE).not.toMatch(/open source/i);
  });

  it('is logged once at warning level', () => {
    const warn = vi.fn();
    logLicenceNotice(warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(`[licence] ${LICENCE_STARTUP_NOTICE}`);
  });

  it('defaults to console.warn', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      logLicenceNotice();
      expect(spy).toHaveBeenCalledWith(`[licence] ${LICENCE_STARTUP_NOTICE}`);
    } finally {
      spy.mockRestore();
    }
  });

  it('is logged by the service entry point before configuration is validated', () => {
    const entry = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const main = entry.indexOf('async function main()');
    const notice = entry.indexOf('logLicenceNotice();', main);
    expect(main).toBeGreaterThan(0);
    expect(notice).toBeGreaterThan(main);
    expect(notice).toBeLessThan(entry.indexOf('validateConfig();', main));
  });
});
