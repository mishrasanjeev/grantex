/**
 * Purpose vocabulary and matching for purpose-bound grants.
 *
 * A grant carries one purpose from a controlled vocabulary, or a private term
 * `x-<org>.<term>`. A manifest tool may restrict the purposes it can be called
 * for with `allowed_purposes` patterns. Matching is by whole dot-separated
 * segments:
 *
 * - a pattern without a wildcard matches only the identical purpose;
 * - `prefix.*` matches any purpose that has `prefix` as its leading segments
 *   and at least one more segment: `aml.cdd.*` matches `aml.cdd.onboarding`
 *   but not `aml.cdd` itself and not `aml.cddx`.
 *
 * Every function returns a negative answer, never throws, for malformed input,
 * so a malformed pattern or purpose can only ever deny. The Python SDK
 * implements the same rules in `grantex.purpose`.
 */

import { isValidPurposePattern } from './manifest.js';

/** The controlled purpose vocabulary. Private terms use `x-<org>.<term>`. */
export const PURPOSE_VOCABULARY: ReadonlySet<string> = new Set([
  'aml.cdd.onboarding',
  'aml.cdd.ongoing',
  'aml.screening',
  'procurement.vendor_onboarding',
  'payments.payout',
]);

export const PRIVATE_PURPOSE_PREFIX = 'x-';

const SEG = '[a-z][a-z0-9_]*';
const ORG = 'x-[a-z0-9]+(?:-[a-z0-9]+)*';
const PURPOSE_RE = new RegExp(`^(?:${SEG}(?:\\.${SEG})*|${ORG}(?:\\.${SEG})+)$`);
const MAX_PURPOSE_LENGTH = 128;

/** Whether `value` is syntactically a purpose (no wildcard). */
export function isValidPurpose(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_PURPOSE_LENGTH && PURPOSE_RE.test(value);
}

/** Whether `value` is a vocabulary term or a well-formed private term. */
export function isKnownPurpose(value: unknown): value is string {
  return isValidPurpose(value) && (PURPOSE_VOCABULARY.has(value) || value.startsWith(PRIVATE_PURPOSE_PREFIX));
}

/** Whether `purpose` matches one `allowed_purposes` `pattern`. False when either is malformed. */
export function purposeMatches(pattern: unknown, purpose: unknown): boolean {
  if (!isValidPurposePattern(pattern) || !isValidPurpose(purpose)) return false;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1); // keep the trailing dot: "aml.cdd."
    return purpose.startsWith(prefix) && purpose.length > prefix.length;
  }
  return purpose === pattern;
}

/** The first pattern in `patterns` that `purpose` matches, or undefined. */
export function matchPurpose(patterns: readonly unknown[] | undefined, purpose: unknown): string | undefined {
  if (patterns === undefined) return undefined;
  for (const pattern of patterns) {
    if (purposeMatches(pattern, purpose)) return pattern as string;
  }
  return undefined;
}
