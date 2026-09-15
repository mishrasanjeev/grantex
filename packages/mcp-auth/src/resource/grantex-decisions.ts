/**
 * Reference `DecisionVerifier` for Grantex decision grants (PRD G-3,
 * `spec/decision-grant.md`).
 *
 * The verifier reads the decision grant(s) from a request header, derives
 * the semantic action from the `tools/call` (tool name plus the arguments'
 * `case_id`, `decision`, `subject` and `amount`), verifies the grants offline
 * and then consumes them at the issuer. It answers `valid` only after the
 * issuer confirmed the consumption, so one decision grant never authorises
 * two calls.
 *
 * Verification and consumption are injected so this package does not pin a
 * `@grantex/sdk` version: pass `verifyDecisionGrants` and
 * `grantex.decisions.consume` from `@grantex/sdk` (0.6 or later), or your own
 * implementations of the same contract.
 */
import type { DecisionCheck, DecisionOutcome, DecisionVerifier } from './guard.js';

/** Default request header carrying the decision grant(s), comma-separated. */
export const DECISION_GRANT_HEADER = 'grantex-decision-grant';

/** The semantic action a decision grant approves. */
export interface SemanticAction {
  case_id: string;
  action: string;
  decision: string;
  subject: string;
  amount?: number | string;
}

/** The subset of `@grantex/sdk`'s `DecisionGrantSet` this verifier needs. */
export interface VerifiedDecisionGrants {
  grants: readonly { jti: string }[];
}

export interface GrantexDecisionVerifierOptions<Set extends VerifiedDecisionGrants = VerifiedDecisionGrants> {
  /** Expected issuer of decision grants (the Grantex auth service). */
  issuer: string;
  /** JWKS URL of the issuer. Defaults to `{issuer}/.well-known/jwks.json`. */
  jwksUri?: string;
  /**
   * Offline verification, e.g. `verifyDecisionGrants` from `@grantex/sdk`.
   * Must throw an error with a string `subReason` for a refused grant.
   */
  verify: (
    tokens: string[],
    action: SemanticAction,
    caseVersion: string,
    options: {
      issuer: string;
      jwksUri: string;
      developerId?: string;
      connector?: string;
      approvalsRequired: 1 | 2;
    },
  ) => Promise<Set>;
  /**
   * Atomic consumption at the issuer, e.g. `(set) => grantex.decisions.consume(set)`.
   * Must throw (with a string `subReason` when the issuer refused) unless the
   * issuer confirmed that every grant in the set was consumed.
   */
  consume: (grants: Set, context: { grantId?: string }) => Promise<unknown>;
  /**
   * The case's current version from the server's own case state (never from
   * the call's arguments). Returning `undefined` refuses the call.
   */
  caseVersion: (caseId: string, check: DecisionCheck) => string | undefined | Promise<string | undefined>;
  /** Header carrying the grant(s). Default `grantex-decision-grant`. */
  header?: string;
}

const SUB_REASON_RE = /^[a-z][a-z0-9_]{0,63}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

function subReasonOf(err: unknown): string | undefined {
  const value = (err as { subReason?: unknown } | null)?.subReason;
  return typeof value === 'string' && SUB_REASON_RE.test(value) ? value : undefined;
}

function actionFrom(check: DecisionCheck): SemanticAction | undefined {
  const args = check.arguments;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined;
  const a = args as Record<string, unknown>;
  const { case_id: caseId, decision, subject, amount } = a;
  if (typeof caseId !== 'string' || typeof decision !== 'string' || typeof subject !== 'string') return undefined;
  if (amount !== undefined && amount !== null && typeof amount !== 'number' && typeof amount !== 'string') return undefined;
  return {
    case_id: caseId,
    action: check.requirement.tool,
    decision,
    subject,
    ...(amount !== undefined && amount !== null ? { amount } : {}),
  };
}

/** Builds the reference `DecisionVerifier`. */
export function grantexDecisionVerifier<Set extends VerifiedDecisionGrants>(
  options: GrantexDecisionVerifierOptions<Set>,
): DecisionVerifier {
  const headerName = options.header ?? DECISION_GRANT_HEADER;
  const jwksUri = options.jwksUri ?? `${options.issuer.replace(/\/$/, '')}/.well-known/jwks.json`;
  return {
    async verify(check: DecisionCheck): Promise<DecisionOutcome> {
      const raw = check.header(headerName);
      if (raw === undefined || raw.trim() === '') return { status: 'absent' };
      const tokens = raw.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
      if (tokens.length === 0) return { status: 'absent' };
      if (tokens.length > 2 || !tokens.every((t) => t.length <= 16_384 && TOKEN_RE.test(t))) {
        return { status: 'invalid', subReason: 'malformed' };
      }
      const action = actionFrom(check);
      if (action === undefined) return { status: 'invalid', subReason: 'malformed' };
      const caseVersion = await options.caseVersion(action.case_id, check);
      if (typeof caseVersion !== 'string' || caseVersion.length === 0) {
        return { status: 'invalid', subReason: 'case_changed' };
      }
      const approvalsRequired: 1 | 2 = check.requirement.fourEyesOn?.includes(action.decision) ? 2 : 1;

      let verified: Set;
      try {
        verified = await options.verify(tokens, action, caseVersion, {
          issuer: options.issuer,
          jwksUri,
          ...(check.grant.developerId !== undefined ? { developerId: check.grant.developerId } : {}),
          ...(check.requirement.connector !== undefined ? { connector: check.requirement.connector } : {}),
          approvalsRequired,
        });
      } catch (err) {
        const subReason = subReasonOf(err);
        if (subReason === 'absent') return { status: 'absent' };
        if (subReason !== undefined) return { status: 'invalid', subReason };
        throw err;
      }
      if (!verified || !Array.isArray(verified.grants) || verified.grants.length !== tokens.length) {
        throw new Error('decision grant verification returned an unexpected result');
      }
      try {
        await options.consume(verified, check.grant.grantId !== undefined ? { grantId: check.grant.grantId } : {});
      } catch (err) {
        return { status: 'invalid', subReason: subReasonOf(err) ?? 'consume_unavailable' };
      }
      return { status: 'valid' };
    },
  };
}
