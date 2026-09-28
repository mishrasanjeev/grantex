// SPDX-License-Identifier: Apache-2.0
/**
 * REGISTRY_STATUS_POLL_MIN_INTERVAL_MS, the floor under how often status
 * reconciliation (status-reconciliation.ts) reads an issuer's status list.
 * Kept apart, with no imports, so config.ts can validate it at startup.
 */

export const POLL_MIN_INTERVAL_ENV = 'REGISTRY_STATUS_POLL_MIN_INTERVAL_MS';
/** Owner decision 5: production polls each issuer at its ttl, never more often than every 30 s. */
export const PRODUCTION_POLL_MIN_INTERVAL_FLOOR_MS = 30_000;
export const DEFAULT_POLL_MIN_INTERVAL_MS = PRODUCTION_POLL_MIN_INTERVAL_FLOOR_MS;
/** Owner decision 5: 1 s polling, for the mock issuer and CI only. */
export const DEV_POLL_MIN_INTERVAL_FLOOR_MS = 1_000;
/** The longest minimum interval: the registry relies on one read for a day at most. */
export const MAX_POLL_MIN_INTERVAL_MS = 86_400_000;

const DEV_ENVIRONMENTS = new Set(['development', 'test']);

/**
 * Why REGISTRY_STATUS_POLL_MIN_INTERVAL_MS cannot be used, or null. A whole
 * number of milliseconds, at most a day, and at least 30 000; at least 1 000
 * when NODE_ENV is development or test (owner decision 5: the 1 s interval
 * is for the mock issuer and CI only). validateConfig refuses to start on it.
 */
export function statusPollMinIntervalConfigError(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[POLL_MIN_INTERVAL_ENV];
  if (raw === undefined || raw.trim() === '') return null;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return `${POLL_MIN_INTERVAL_ENV} must be a whole number of milliseconds`;
  const value = Number(text);
  if (value > MAX_POLL_MIN_INTERVAL_MS) return `${POLL_MIN_INTERVAL_ENV} must be at most ${MAX_POLL_MIN_INTERVAL_MS}`;
  if (DEV_ENVIRONMENTS.has(env['NODE_ENV'] ?? '')) {
    if (value < DEV_POLL_MIN_INTERVAL_FLOOR_MS) {
      return `${POLL_MIN_INTERVAL_ENV} must be at least ${DEV_POLL_MIN_INTERVAL_FLOOR_MS}`;
    }
    return null;
  }
  if (value < PRODUCTION_POLL_MIN_INTERVAL_FLOOR_MS) {
    return `${POLL_MIN_INTERVAL_ENV} must be at least ${PRODUCTION_POLL_MIN_INTERVAL_FLOOR_MS} unless NODE_ENV is development or test `
      + `(down to ${DEV_POLL_MIN_INTERVAL_FLOOR_MS} there, for the mock issuer and CI only)`;
  }
  return null;
}

/** The minimum poll interval in force. A value validateConfig would refuse reads as the default. */
export function statusPollMinIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[POLL_MIN_INTERVAL_ENV];
  if (raw === undefined || raw.trim() === '' || statusPollMinIntervalConfigError(env) !== null) return DEFAULT_POLL_MIN_INTERVAL_MS;
  return Number(raw.trim());
}
