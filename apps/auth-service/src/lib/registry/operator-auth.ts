// SPDX-License-Identifier: Apache-2.0
/**
 * Registry operator keys: the credential for the registry's write routes
 * (accrediting, suspending and withdrawing issuers, revoking their keys).
 *
 * REGISTRY_OPERATOR_API_KEYS is a comma-separated list, so a key can be
 * rotated by adding the new one, moving callers over and removing the old
 * one. It is separate from ADMIN_API_KEY on purpose: whoever runs the
 * registry need not hold the platform admin key, and the reverse.
 *
 * Read at request time, like the feature flags, so tests can stub it. A list
 * with any key shorter than MIN_OPERATOR_KEY_LENGTH counts as no list: the
 * routes answer 503 rather than accept a guessable key, and validateConfig
 * refuses to start with one.
 */
import crypto from 'node:crypto';

export const REGISTRY_OPERATOR_KEYS_ENV = 'REGISTRY_OPERATOR_API_KEYS';
export const MIN_OPERATOR_KEY_LENGTH = 32;

function splitKeys(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value.split(',').map((key) => key.trim()).filter((key) => key.length > 0);
}

/** Why the configured list cannot be used, or null when it can (or is unset). */
export function registryOperatorKeysConfigError(value: string | undefined): string | null {
  const keys = splitKeys(value);
  if (keys.some((key) => key.length < MIN_OPERATOR_KEY_LENGTH)) {
    return `${REGISTRY_OPERATOR_KEYS_ENV} keys must each be at least ${MIN_OPERATOR_KEY_LENGTH} characters`;
  }
  if (new Set(keys).size !== keys.length) {
    return `${REGISTRY_OPERATOR_KEYS_ENV} lists the same key twice`;
  }
  return null;
}

/** The usable operator keys; empty when none are configured or the list is invalid. */
export function registryOperatorKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  const value = env[REGISTRY_OPERATOR_KEYS_ENV];
  // Fail closed: a list with one bad key is not trusted for any of them.
  if (registryOperatorKeysConfigError(value) !== null) return [];
  return splitKeys(value);
}

function digest(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Whether the Authorization header carries one of `keys` as a bearer token.
 *
 * Both sides are hashed to 32 bytes first, so `timingSafeEqual` always runs
 * on equal lengths and the presented length is not revealed by an early
 * return, and every key is compared with no short-circuit, so the time taken
 * does not say which key, if any, matched.
 */
export function operatorKeyMatches(authorization: string | undefined, keys: readonly string[]): boolean {
  const presented = digest(authorization ?? '');
  let matched = false;
  for (const key of keys) {
    const equal = crypto.timingSafeEqual(presented, digest(`Bearer ${key}`));
    matched = matched || equal;
  }
  return matched;
}
