// SPDX-License-Identifier: Apache-2.0
/**
 * The grant token profile (`spec/grant-token-0.6.md`) as this package reads
 * it: the algorithms a grant token is signed with, its `typ`, and its claims.
 * The standard `scope` and `urn:grantex:grant` are read first; the pre-0.6
 * aliases (`scp`, `agt`, `dev`, `grnt`, `delegationDepth`) only where the
 * standard claim is absent, so a resource server keeps working when the
 * issuer stops sending them (`GRANT_TOKEN_LEGACY_CLAIMS=false`, the 0.7
 * default).
 */

/** Claim holding Grantex's grant record fields (RFC 7519 §4.2 collision-resistant name). */
export const GRANT_CLAIM = 'urn:grantex:grant';

/**
 * The only algorithms a grant token is signed with (`spec/grant-token-0.6.md`,
 * "Header" and "Validation" step 1). JOSE only selects a JWK Set key of the
 * matching type under the token's `kid`: RSA for RS256, EC P-256 for ES256.
 */
export const GRANT_TOKEN_ALGORITHMS: readonly string[] = Object.freeze(['RS256', 'ES256']);

/** RFC 9068 §2.1: the `typ` of a JWT access token. */
export const GRANT_TOKEN_TYP = 'at+jwt';

/** A verified token whose header or claims are not a grant token's. The message names claims, never values. */
export class GrantTokenClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrantTokenClaimError';
  }
}

/**
 * The algorithms to verify grant tokens with: both, or a caller-supplied
 * subset. A list naming anything else is a configuration error and throws at
 * start-up. It is not silently intersected, so a server is never configured
 * to believe it accepts an algorithm that it refuses.
 */
export function grantTokenAlgorithms(requested: readonly string[] | undefined, label: string): string[] {
  if (requested === undefined) return [...GRANT_TOKEN_ALGORITHMS];
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new Error(`${label}: \`algorithms\` must list at least one of ${GRANT_TOKEN_ALGORITHMS.join(', ')}.`);
  }
  const unsupported = requested.filter((alg) => !GRANT_TOKEN_ALGORITHMS.includes(alg));
  if (unsupported.length > 0) {
    throw new Error(
      `${label}: \`algorithms\` may list only ${GRANT_TOKEN_ALGORITHMS.join(' and ')}, the algorithms grant tokens `
      + `are signed with (spec/grant-token-0.6.md); remove ${unsupported.map(String).join(', ')}.`,
    );
  }
  return [...new Set(requested)];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A token issued before 0.6: no `urn:grantex:grant`, and `scp`. Its `scope`,
 * when present, was `scp` joined with spaces, which splits a scope containing
 * whitespace into scopes the grant never had, so `scp` is authoritative
 * (`spec/grant-token-0.6.md`, "Legacy claim aliases").
 */
function isPre06Token(payload: Record<string, unknown>): boolean {
  return payload[GRANT_CLAIM] === undefined && payload['scp'] !== undefined;
}

/**
 * RFC 9068 §4: `typ` must be `at+jwt` or `application/at+jwt` (RFC 7515
 * §4.1.9 lets the prefix be omitted; media types compare case-insensitively).
 * This keeps other JWTs signed with the issuer's key, such as decision grants
 * and credentials, from being taken for grant tokens.
 *
 * The auth service sets `typ: at+jwt` on every grant token it signs, and has
 * since before `urn:grantex:grant` existed. Grant tokens signed before that
 * have no `typ`, and every one of them is a pre-0.6 token, so a missing `typ`
 * is accepted on a pre-0.6 token only. Any other value is always refused.
 *
 * @throws {GrantTokenClaimError}
 */
export function checkGrantTokenType(header: { typ?: unknown }, payload: Record<string, unknown>): void {
  const typ = header.typ;
  if (typ === undefined && isPre06Token(payload)) return;
  if (typeof typ !== 'string' || typ.toLowerCase().replace(/^application\//, '') !== GRANT_TOKEN_TYP) {
    throw new GrantTokenClaimError(`Token typ must be ${GRANT_TOKEN_TYP}`);
  }
}

/** Grant claims read from a verified token. */
export interface GrantTokenClaims {
  scopes: string[];
  agentDid?: string;
  developerId?: string;
  grantId?: string;
  delegationDepth?: number;
}

/**
 * A string member of `urn:grantex:grant` (`label` `urn:grantex:grant.`) or a
 * legacy alias (`label` empty). Absent is `undefined`; present with any other
 * value, including `null` and `''`, is refused, as by the SDK verifiers
 * (`spec/grant-token-0.6.md`, "Null and mistyped claims").
 */
function stringClaim(record: Record<string, unknown>, name: string, label: string): string | undefined {
  const value = record[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new GrantTokenClaimError(`Token ${label}${name} must be a non-empty string`);
  }
  return value;
}

/** A delegation depth, read like `stringClaim`. */
function depthClaim(record: Record<string, unknown>, name: string, label: string): number | undefined {
  const value = record[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new GrantTokenClaimError(`Token ${label}${name} must be a non-negative integer`);
  }
  return value;
}

/**
 * The standard claim, else its legacy alias. Both are issued with identical
 * values, so a token on which they differ was not issued by the auth service
 * and is refused rather than read either way (`spec/grant-token-0.6.md`).
 */
function standardFirst<T>(standardName: string, standard: T | undefined, aliasName: string, alias: T | undefined): T | undefined {
  if (standard !== undefined && alias !== undefined && JSON.stringify(standard) !== JSON.stringify(alias)) {
    throw new GrantTokenClaimError(`Token ${standardName} claim disagrees with its legacy alias ${aliasName}`);
  }
  return standard ?? alias;
}

/**
 * Reads the scopes and grant record fields of a verified grant token.
 *
 * A grant token carries `urn:grantex:grant` (0.6) or `scp` (before 0.6); a
 * token with neither is refused. That keeps out the auth service's OAuth
 * access tokens, which are `at+jwt` with a `scope` and a `cnf.jkt` that this
 * package does not check, so admitting them would let a stolen
 * sender-constrained token be replayed as a bearer token.
 *
 * Scopes: a pre-0.6 token is read from `scp`. A 0.6 token is read from the
 * space-delimited `scope` (RFC 9068 §2.2.3), falling back to `scp` when
 * `scope` is absent, which is how a 0.6 grant with a scope containing
 * whitespace is issued. A token from which neither yields a scope set is
 * refused. An empty `scope` is an empty set, as the SDK verifiers read it:
 * the guard's `scopes` and `tools` options deny it.
 *
 * Grant fields come from `urn:grantex:grant`, then from `agt`, `dev`, `grnt`
 * and `delegationDepth`. A 0.6 token must name its agent and developer in
 * one form or the other, as the SDK verifiers require. A pre-0.6 token need
 * not: the guard has always accepted one that carries only `scp`.
 *
 * A claim present with the wrong type or `null`, legacy aliases included, is
 * refused rather than treated as absent.
 *
 * @throws {GrantTokenClaimError}
 */
export function readGrantTokenClaims(payload: Record<string, unknown>): GrantTokenClaims {
  const rawGrant = payload[GRANT_CLAIM];
  if (rawGrant !== undefined && !isPlainObject(rawGrant)) {
    throw new GrantTokenClaimError(`Token ${GRANT_CLAIM} claim must be an object`);
  }
  if (rawGrant === undefined && payload['scp'] === undefined) {
    throw new GrantTokenClaimError(`Token is not a grant token: it has neither ${GRANT_CLAIM} nor scp`);
  }
  const rawScope = payload['scope'];
  if (rawScope !== undefined && typeof rawScope !== 'string') {
    throw new GrantTokenClaimError('Token scope claim must be a space-delimited string');
  }
  // `scp` must be a string array, matching @grantex/sdk: a string marks a
  // foreign token from the same issuer.
  const rawScp = payload['scp'];
  if (rawScp !== undefined && !(Array.isArray(rawScp) && rawScp.every((s) => typeof s === 'string'))) {
    throw new GrantTokenClaimError('Token scp claim must be an array of strings');
  }
  const scp = rawScp as string[] | undefined;

  const scopes = isPre06Token(payload)
    ? scp
    : standardFirst('scope', rawScope?.split(' ').filter((s) => s.length > 0), 'scp', scp);
  if (scopes === undefined) {
    throw new GrantTokenClaimError('Token has no scope or scp claim');
  }

  const grant = rawGrant ?? {};
  const member = `${GRANT_CLAIM}.`;
  const agentDid = standardFirst(`${member}agent_did`, stringClaim(grant, 'agent_did', member), 'agt', stringClaim(payload, 'agt', ''));
  const developerId = standardFirst(`${member}developer_id`, stringClaim(grant, 'developer_id', member), 'dev', stringClaim(payload, 'dev', ''));
  const grantId = standardFirst(`${member}grant_id`, stringClaim(grant, 'grant_id', member), 'grnt', stringClaim(payload, 'grnt', ''));
  const delegationDepth = standardFirst(
    `${member}delegation_depth`,
    depthClaim(grant, 'delegation_depth', member),
    'delegationDepth',
    depthClaim(payload, 'delegationDepth', ''),
  );
  if (rawGrant !== undefined && (agentDid === undefined || developerId === undefined)) {
    throw new GrantTokenClaimError(
      `Token has no ${member}agent_did (or agt) or no ${member}developer_id (or dev) claim`,
    );
  }

  return {
    scopes,
    ...(agentDid !== undefined ? { agentDid } : {}),
    ...(developerId !== undefined ? { developerId } : {}),
    ...(grantId !== undefined ? { grantId } : {}),
    ...(delegationDepth !== undefined ? { delegationDepth } : {}),
  };
}
