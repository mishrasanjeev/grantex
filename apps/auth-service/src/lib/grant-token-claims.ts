/**
 * Claims of `grantex-v1` grant tokens (SPEC §6, spec/grant-token-0.6.md).
 *
 * Standard form, always issued:
 *
 * - RFC 9068 / RFC 7519: `iss`, `sub` (principal), `aud` (when the grant is
 *   bound to a resource), `exp`, `iat`, `jti`, `client_id` (agent id) and
 *   `scope` (space-delimited).
 * - `cnf.jkt` (RFC 9449) when the agent's key is bound.
 * - `act` (RFC 8693) for delegated grants: `act.sub` is the agent that
 *   delegated to this token's client, and each nested `act` is the actor one
 *   hop further up the chain.
 * - `authorization_details` (RFC 9396): purpose, tools and caps
 *   (`urn:grantex:tools:v1`), budget, and decision references
 *   (`urn:grantex:decision:v1`).
 * - `urn:grantex:grant`: Grantex's own grant record fields (`grant_id`,
 *   `agent_did`, `developer_id`, and for delegated grants `parent_grant_id`
 *   and `delegation_depth`) under a collision-resistant name.
 *
 * Legacy aliases (`agt`, `dev`, `grnt`, `scp`, `parentAgt`, `parentGrnt`,
 * `delegationDepth`, `bdg`) are added while `GRANT_TOKEN_LEGACY_CLAIMS` is on:
 * the default for 0.6, off from 0.7.
 *
 * Reading accepts both forms, prefers the standard claim, and refuses a 0.6
 * token (one with `urn:grantex:grant`) whose standard claim and alias
 * disagree. A pre-0.6 token carries `scope` only as a lossy join of `scp`, so
 * its `scp` is authoritative.
 *
 * A grant whose scopes contain whitespace (allowed before 0.6) cannot be
 * expressed in the space-delimited `scope`: its tokens omit `scope` and always
 * carry `scp`, so standard-only readers refuse them rather than read a
 * different scope set.
 */

/** Whether any scope contains whitespace and so cannot be put in `scope`. */
export function hasUnrepresentableScope(scopes: readonly string[]): boolean {
  return scopes.some((scope) => /\s/.test(scope));
}

export const GRANT_CLAIM = 'urn:grantex:grant';

/** Legacy alias → the standard claim that replaces it. */
export const LEGACY_GRANT_TOKEN_CLAIMS: Readonly<Record<string, string>> = {
  agt: `${GRANT_CLAIM}.agent_did`,
  dev: `${GRANT_CLAIM}.developer_id`,
  grnt: `${GRANT_CLAIM}.grant_id`,
  scp: 'scope',
  parentAgt: 'act.sub',
  parentGrnt: `${GRANT_CLAIM}.parent_grant_id`,
  delegationDepth: `${GRANT_CLAIM}.delegation_depth`,
  bdg: 'authorization_details (urn:grantex:params:oauth:authorization-details:budget)',
};

/** Longest `act` chain accepted: the delegation hard cap (SPEC §9). */
export const MAX_ACTOR_CHAIN_DEPTH = 10;

export interface ActorClaim {
  sub: string;
  act?: ActorClaim;
  [member: string]: unknown;
}

export class GrantTokenClaimsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrantTokenClaimsError';
  }
}

export interface GrantTokenClaimsInput {
  agt: string;
  dev: string;
  clientId?: string;
  scp: string[];
  grnt?: string;
  cnf?: { jkt: string };
  act?: Record<string, unknown>;
  authorizationDetails?: Array<Record<string, unknown>>;
  parentAgt?: string;
  parentGrnt?: string;
  delegationDepth?: number;
  bdg?: number;
}

/**
 * The claims of a grant token other than `iss`, `sub`, `aud`, `jti`, `iat`
 * and `exp`, which the JWT builder sets.
 */
export function buildGrantTokenClaims(
  input: GrantTokenClaimsInput,
  options: { legacyClaims: boolean },
): Record<string, unknown> {
  const grant: Record<string, unknown> = {
    ...(input.grnt !== undefined ? { grant_id: input.grnt } : {}),
    agent_did: input.agt,
    developer_id: input.dev,
    ...(input.parentGrnt !== undefined ? { parent_grant_id: input.parentGrnt } : {}),
    ...(input.delegationDepth !== undefined ? { delegation_depth: input.delegationDepth } : {}),
  };
  const unrepresentable = hasUnrepresentableScope(input.scp);
  return {
    ...(input.clientId !== undefined ? { client_id: input.clientId } : {}),
    ...(unrepresentable ? {} : { scope: input.scp.join(' ') }),
    ...(input.cnf !== undefined ? { cnf: input.cnf } : {}),
    ...(input.act !== undefined ? { act: input.act } : {}),
    ...(input.authorizationDetails !== undefined
      ? { authorization_details: input.authorizationDetails }
      : {}),
    [GRANT_CLAIM]: grant,
    ...(unrepresentable && !options.legacyClaims ? { scp: input.scp } : {}),
    ...(options.legacyClaims
      ? {
          agt: input.agt,
          dev: input.dev,
          scp: input.scp,
          ...(input.grnt !== undefined ? { grnt: input.grnt } : {}),
          ...(input.parentAgt !== undefined ? { parentAgt: input.parentAgt } : {}),
          ...(input.parentGrnt !== undefined ? { parentGrnt: input.parentGrnt } : {}),
          ...(input.delegationDepth !== undefined ? { delegationDepth: input.delegationDepth } : {}),
          ...(input.bdg !== undefined ? { bdg: input.bdg } : {}),
        }
      : {}),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate an RFC 8693 `act` claim: an object with a string `sub`, nested at most `MAX_ACTOR_CHAIN_DEPTH` deep. */
export function parseActorClaim(value: unknown): ActorClaim {
  let current: unknown = value;
  for (let depth = 1; ; depth += 1) {
    if (!isPlainObject(current) || typeof current['sub'] !== 'string' || current['sub'].length === 0) {
      throw new GrantTokenClaimsError('act must be an object with a non-empty string sub');
    }
    if (current['act'] === undefined) break;
    if (depth >= MAX_ACTOR_CHAIN_DEPTH) {
      throw new GrantTokenClaimsError(`act chain is deeper than ${MAX_ACTOR_CHAIN_DEPTH}`);
    }
    current = current['act'];
  }
  return value as ActorClaim;
}

/**
 * The `act` claim for a grant delegated by `delegatorAgentDid`, whose own
 * token carried `delegatorAct` (the earlier actors).
 */
export function delegatedActorClaim(delegatorAgentDid: string, delegatorAct: unknown): ActorClaim {
  const act: ActorClaim = {
    sub: delegatorAgentDid,
    ...(delegatorAct !== undefined && delegatorAct !== null ? { act: parseActorClaim(delegatorAct) } : {}),
  };
  return parseActorClaim(act);
}

function agree<T>(name: string, standard: T | undefined, legacy: T | undefined): T | undefined {
  if (standard !== undefined && legacy !== undefined && JSON.stringify(standard) !== JSON.stringify(legacy)) {
    throw new GrantTokenClaimsError(`Grant token claim ${name} disagrees with its legacy alias`);
  }
  return standard ?? legacy;
}

function optionalString(record: Record<string, unknown>, name: string, where: string): string | undefined {
  const value = record[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new GrantTokenClaimsError(`${where}${name} must be a non-empty string`);
  }
  return value;
}

function optionalDepth(record: Record<string, unknown>, name: string, where: string): number | undefined {
  const value = record[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new GrantTokenClaimsError(`${where}${name} must be a non-negative integer`);
  }
  return value;
}

export interface NormalizedGrantTokenClaims {
  agt: string;
  dev: string;
  scp: string[];
  grnt: string | undefined;
  parentAgt?: string;
  parentGrnt?: string;
  delegationDepth?: number;
  act?: ActorClaim;
}

/**
 * Read the grant fields from a verified payload in either form. Returns
 * `null` when a required field is missing from both forms; throws
 * `GrantTokenClaimsError` when a claim is malformed or the forms disagree.
 */
export function normalizeGrantTokenClaims(payload: Record<string, unknown>): NormalizedGrantTokenClaims | null {
  const rawGrant = payload[GRANT_CLAIM];
  if (rawGrant !== undefined && !isPlainObject(rawGrant)) {
    throw new GrantTokenClaimsError(`${GRANT_CLAIM} must be an object`);
  }
  const grant = rawGrant ?? {};
  const where = `${GRANT_CLAIM}.`;

  const rawScope = payload['scope'];
  if (rawScope !== undefined && typeof rawScope !== 'string') {
    throw new GrantTokenClaimsError('scope must be a string');
  }
  const scope = rawScope === undefined ? undefined : rawScope.split(' ').filter((value) => value.length > 0);
  const rawScp = payload['scp'];
  if (rawScp !== undefined && (!Array.isArray(rawScp) || rawScp.some((value) => typeof value !== 'string'))) {
    throw new GrantTokenClaimsError('scp must be an array of strings');
  }
  // A pre-0.6 token's scope is a lossy join of scp; only 0.6 tokens must agree.
  const scp = rawGrant === undefined && rawScp !== undefined
    ? rawScp as string[]
    : agree('scope', scope, rawScp as string[] | undefined);

  const agt = agree('agent_did', optionalString(grant, 'agent_did', where), optionalString(payload, 'agt', ''));
  const dev = agree('developer_id', optionalString(grant, 'developer_id', where), optionalString(payload, 'dev', ''));
  const grnt = agree('grant_id', optionalString(grant, 'grant_id', where), optionalString(payload, 'grnt', ''));
  const parentGrnt = agree(
    'parent_grant_id',
    optionalString(grant, 'parent_grant_id', where),
    optionalString(payload, 'parentGrnt', ''),
  );
  const delegationDepth = agree(
    'delegation_depth',
    optionalDepth(grant, 'delegation_depth', where),
    optionalDepth(payload, 'delegationDepth', ''),
  );
  const act = payload['act'] === undefined ? undefined : parseActorClaim(payload['act']);
  const legacyParentAgt = optionalString(payload, 'parentAgt', '');
  if (legacyParentAgt !== undefined && act !== undefined && act.sub !== legacyParentAgt) {
    throw new GrantTokenClaimsError('Grant token claim act.sub disagrees with its legacy alias');
  }
  const parentAgt = legacyParentAgt ?? (parentGrnt !== undefined ? act?.sub : undefined);

  if (agt === undefined || dev === undefined || scp === undefined) return null;
  return {
    agt,
    dev,
    scp,
    grnt,
    ...(parentAgt !== undefined ? { parentAgt } : {}),
    ...(parentGrnt !== undefined ? { parentGrnt } : {}),
    ...(delegationDepth !== undefined ? { delegationDepth } : {}),
    ...(act !== undefined ? { act } : {}),
  };
}

/** Start-up notices about grant token claims. */
export function grantTokenClaimsStartupNotices(settings: { grantTokenLegacyClaims: boolean }): string[] {
  return settings.grantTokenLegacyClaims
    ? ['GRANT_TOKEN_LEGACY_CLAIMS=true: grant tokens also carry the deprecated claim aliases agt, dev, grnt, scp, '
      + 'parentAgt, parentGrnt, delegationDepth and bdg. The default becomes false in 0.7; move resource servers '
      + 'to the standard claims (docs/migration-0.6.md).']
    : [];
}
