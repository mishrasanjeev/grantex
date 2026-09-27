/**
 * The agent a decision-grant call is made for, established by this service
 * from that agent's grant token and never from a body field. Both endpoints
 * that act for an agent use it, so they establish the agent the same way:
 * the release of a request's decision grants
 * (`POST /v1/decisions/requests/:id/grants`) and, with
 * `DECISION_GRANT_AGENT_BINDING`, the consumption of presented decision grants
 * (`POST /v1/decisions/consume`). Both take the token in the `grantToken`
 * member of the body.
 */
import { checkActiveGrantToken, type ActiveGrantTokenCheckResult } from '../active-grant-token.js';
import { DecisionError, DecisionSubReason } from './policy.js';

/** The longest `grantToken` either endpoint reads. */
export const MAX_GRANT_TOKEN_LENGTH = 16_384;

/** Why a presented grant token established no agent: `checkActiveGrantToken`'s reason. */
export type GrantTokenFailure = Extract<ActiveGrantTokenCheckResult, { ok: false }>['reason'];

/** An agent established from a live grant token of the developer. */
export interface VerifiedCallingAgent {
  verified: true;
  /** The agent's DID, from the token (`urn:grantex:grant.agent_did`, legacy alias `agt`). */
  agentDid: string;
  /** The grant, from the token (`urn:grantex:grant.grant_id`, legacy alias `grnt`). */
  grantId: string;
}

/**
 * The calling agent, or why none was established: no grant token was
 * presented (`missing`), or the one presented is not a live grant token of
 * the developer.
 */
export type CallingAgent =
  | VerifiedCallingAgent
  | { verified: false; tokenCheck: GrantTokenFailure | 'missing' };

/** No grant token was presented, so no agent is established. */
export const NO_GRANT_TOKEN: CallingAgent = Object.freeze({ verified: false, tokenCheck: 'missing' });

/**
 * Whether a body member has the shape of a grant token: a non-empty string of
 * at most {@link MAX_GRANT_TOKEN_LENGTH} characters. Anything else is refused
 * as malformed (400) before the token is examined.
 */
export function isGrantTokenMember(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_GRANT_TOKEN_LENGTH;
}

/**
 * The agent and grant of a live grant token of `developerId`.
 * `checkActiveGrantToken` verifies the signature against the service's own
 * keys and the issuer, reads the claims (standard names and legacy aliases,
 * which must agree), and checks that the token is this developer's, that
 * neither the token nor its grant is revoked (revocation list and database),
 * that the grant is active and that the token has not expired. A token that
 * fails any of these establishes no agent, and the reason is returned for the
 * audit record.
 */
export async function callingAgentOf(
  grantToken: string,
  developerId: string,
): Promise<VerifiedCallingAgent | { verified: false; tokenCheck: GrantTokenFailure }> {
  const result = await checkActiveGrantToken(grantToken, { expectedDeveloperId: developerId });
  return result.ok
    ? { verified: true, agentDid: result.claims.agt, grantId: result.claims.grnt }
    : { verified: false, tokenCheck: result.reason };
}

/** The refusal (`wrong_agent`, 403) for a presented grant token that established no agent. */
export function notLiveGrantToken(tokenCheck: GrantTokenFailure): DecisionError {
  return new DecisionError(
    DecisionSubReason.WRONG_AGENT,
    403,
    `grantToken is not a live grant token of this developer (${tokenCheck})`,
  );
}
