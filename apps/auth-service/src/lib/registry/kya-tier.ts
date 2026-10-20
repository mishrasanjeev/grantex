// SPDX-License-Identifier: Apache-2.0
/**
 * KYA ("know your agent") tier on the Agent Passport (G54).
 *
 * Card networks and wallet schemes are defining agent assurance tiers; none
 * has published a tier specification Grantex can implement. So Grantex does
 * not define tiers. It maps the registry's trust marks to a tier label an
 * operator configures, pending the scheme specifications:
 *
 *   AGENT_PASSPORT_KYA_TIER_MAP = {
 *     "version": "<operator's mapping version>",
 *     "tiers": [
 *       { "tier": "<label>", "trust_marks": ["urn:grantex:tm:agent.identity", ...] },
 *       ...
 *     ]
 *   }
 *
 * Entries are read in order; the first whose trust marks are all held by
 * counted attestations of the agent (trust-level.ts computeAgentTrust: the
 * agent's own and its provider's, accepted, unexpired, status fresh and
 * valid) gives the tier. No entry matching, or an empty table (the
 * default), means no claim. The label is the operator's and is passed
 * through verbatim: Grantex attaches no meaning to it beyond the mapping.
 *
 * The claim is issued only with AGENT_PASSPORT_KYA_TIER_ENABLED=true and
 * reflects the registry at issuance; a relying party that needs the agent's
 * standing now reads the registry lookup.
 */
import { TRUST_MARK_TYPES } from './issuers.js';

export interface KyaTierEntry {
  tier: string;
  trust_marks: string[];
}

export interface KyaTierMap {
  version: string;
  tiers: KyaTierEntry[];
}

/** The claim on the passport's credentialSubject. */
export interface KyaTierClaim {
  tier: string;
  /** The trust marks the tier was mapped from. */
  trustMarks: string[];
  /** The operator's mapping version. */
  mappingVersion: string;
}

export const EMPTY_KYA_TIER_MAP: KyaTierMap = Object.freeze({ version: 'none', tiers: [] }) as KyaTierMap;
const LABEL = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_TIERS = 32;

export class KyaTierMapError extends Error {
  constructor(message: string) {
    super(`AGENT_PASSPORT_KYA_TIER_MAP: ${message}`);
    this.name = 'KyaTierMapError';
  }
}

/** Parses the mapping table; anything outside the shape is a configuration error. */
export function parseKyaTierMap(raw: string | undefined): KyaTierMap {
  if (raw === undefined || raw.trim() === '') return EMPTY_KYA_TIER_MAP;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new KyaTierMapError('is not JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new KyaTierMapError('must be an object');
  const { version, tiers } = value as Record<string, unknown>;
  for (const name of Object.keys(value)) if (name !== 'version' && name !== 'tiers') throw new KyaTierMapError(`has no member ${name}`);
  if (typeof version !== 'string' || !LABEL.test(version)) throw new KyaTierMapError('version must be 1 to 64 characters from A-Z a-z 0-9 . _ : -');
  if (!Array.isArray(tiers) || tiers.length > MAX_TIERS) throw new KyaTierMapError(`tiers must be an array of at most ${MAX_TIERS} entries`);
  const seen = new Set<string>();
  const out = tiers.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new KyaTierMapError(`tiers[${i}] must be an object`);
    const { tier, trust_marks: marks } = entry as Record<string, unknown>;
    for (const name of Object.keys(entry)) if (name !== 'tier' && name !== 'trust_marks') throw new KyaTierMapError(`tiers[${i}] has no member ${name}`);
    if (typeof tier !== 'string' || !LABEL.test(tier)) throw new KyaTierMapError(`tiers[${i}].tier must be 1 to 64 characters from A-Z a-z 0-9 . _ : -`);
    if (seen.has(tier)) throw new KyaTierMapError(`tier ${tier} is listed twice`);
    seen.add(tier);
    if (!Array.isArray(marks) || marks.length === 0) throw new KyaTierMapError(`tiers[${i}].trust_marks must name at least one trust mark`);
    for (const mark of marks) {
      if (typeof mark !== 'string' || !(TRUST_MARK_TYPES as readonly string[]).includes(mark)) {
        throw new KyaTierMapError(`tiers[${i}].trust_marks holds ${String(mark)}, which is not a trust mark type`);
      }
    }
    return { tier, trust_marks: [...new Set(marks as string[])].sort() };
  });
  return { version, tiers: out };
}

/** The tier the counted trust marks map to, or null. */
export function kyaTierFor(countedTrustMarks: readonly string[], map: KyaTierMap): KyaTierClaim | null {
  const held = new Set(countedTrustMarks);
  for (const entry of map.tiers) {
    if (entry.trust_marks.every((mark) => held.has(mark))) {
      return { tier: entry.tier, trustMarks: [...entry.trust_marks], mappingVersion: map.version };
    }
  }
  return null;
}
