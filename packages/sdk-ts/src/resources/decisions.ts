/**
 * Auth-service API for decision grants (PRD G-3): `grantex.decisions`.
 * The auth service must run with `DECISION_GRANTS_ENABLED=true`.
 */
import { decodeJwt } from 'jose';
import type { HttpClient } from '../http.js';
import { GrantexApiError, GrantexError } from '../errors.js';
import { DecisionSubReason } from '../denials.js';
import { parseDecisionAction, type DecisionAction } from '../decisions/action.js';
import { DecisionGrantError, type DecisionGrantSet } from '../decisions/verify.js';

export const APPROVER_SESSION_HEADER = 'Grantex-Approver-Session';

const KNOWN_SUB_REASONS = new Set<string>(Object.values(DecisionSubReason));

/** The issuer's record that decision grants were consumed for one action. */
export interface ConsumedDecision {
  requestId: string;
  jtis: string[];
  actionHash: string;
  approvers: Record<string, unknown>[];
}

/** Consumes decision grants atomically at their issuer. */
export interface DecisionConsumer {
  consume(grants: DecisionGrantSet, options?: { agentId?: string; grantId?: string }): Promise<ConsumedDecision>;
}

export interface CreateDecisionRequestParams {
  action: DecisionAction;
  connector: string;
  caseVersion: string;
  /** The manifest's `four_eyes_on`; two approvals are required when it lists the decision. */
  fourEyesOn?: string[];
  approvalsRequired?: 1 | 2;
  expiresInSeconds?: number;
  memoRef?: string;
  policyScoreRef?: string;
  agentId?: string;
  grantId?: string;
}

export interface ConsumeDecisionParams {
  agentId?: string;
  grantId?: string;
}

function strip<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export class DecisionsClient {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  /** Exchange a step-up ID token (from an OIDC SSO connection) for an approver session. */
  createApproverSession(connectionId: string, idToken: string): Promise<Record<string, unknown>> {
    return this.#http.post('/v1/decisions/approver-sessions', { connectionId, idToken }, { retry: false });
  }

  revokeApproverSession(sessionId: string): Promise<void> {
    return this.#http.delete(`/v1/decisions/approver-sessions/${encodeURIComponent(sessionId)}`);
  }

  /** Register the case's current version; unconsumed grants for other versions are revoked. */
  setCaseVersion(caseId: string, caseVersion: string): Promise<Record<string, unknown>> {
    return this.#http.put(`/v1/decisions/cases/${encodeURIComponent(caseId)}`, { caseVersion });
  }

  /** Ask a person to decide one semantic action. Idempotent while the request is open. */
  createRequest(params: CreateDecisionRequestParams): Promise<Record<string, unknown>> {
    return this.#http.post('/v1/decisions/requests', strip({ ...params, action: parseDecisionAction(params.action) }));
  }

  /** Status and approvals; `decisionGrants` once fully approved and still usable. */
  getRequest(requestId: string): Promise<Record<string, unknown>> {
    return this.#http.get(`/v1/decisions/requests/${encodeURIComponent(requestId)}`);
  }

  cancelRequest(requestId: string): Promise<Record<string, unknown>> {
    return this.#http.post(`/v1/decisions/requests/${encodeURIComponent(requestId)}/cancel`);
  }

  /**
   * Approve the action the approver was shown; returns `decisionGrant`.
   * `actionHash` must be the hash displayed and `dwellMs` the time from
   * rendering the decision to the click.
   */
  approve(requestId: string, params: { approverSession: string; actionHash: string; dwellMs: number }): Promise<Record<string, unknown>> {
    return this.#http.post(
      `/v1/decisions/requests/${encodeURIComponent(requestId)}/approvals`,
      { actionHash: params.actionHash, dwellMs: params.dwellMs },
      { headers: { [APPROVER_SESSION_HEADER]: params.approverSession }, retry: false },
    );
  }

  /** One-time link to the auth service's approval page for this approver. */
  createPageTicket(requestId: string, approverSession: string): Promise<Record<string, unknown>> {
    return this.#http.post(
      `/v1/decisions/requests/${encodeURIComponent(requestId)}/page-tickets`,
      undefined,
      { headers: { [APPROVER_SESSION_HEADER]: approverSession }, retry: false },
    );
  }

  /**
   * Consume decision grants atomically at the auth service. Pass a verified
   * `DecisionGrantSet`, or the tokens with the action and case version.
   * Throws `DecisionGrantError` with the issuer's sub-reason when refused and
   * `consume_unavailable` when the issuer cannot be reached or answers
   * unexpectedly: an unconfirmed consumption is never treated as success.
   */
  async consume(
    grants: DecisionGrantSet | readonly string[],
    options: ConsumeDecisionParams & { action?: DecisionAction; caseVersion?: string } = {},
  ): Promise<ConsumedDecision> {
    let tokens: string[];
    let action: DecisionAction;
    let caseVersion: string;
    let expectedJtis: string[];
    if (Array.isArray(grants)) {
      if (options.action === undefined || options.caseVersion === undefined) {
        throw new Error('consume needs action and caseVersion when given tokens');
      }
      tokens = [...grants];
      action = parseDecisionAction(options.action);
      caseVersion = options.caseVersion;
      expectedJtis = tokens.map((t) => {
        try {
          const jti = decodeJwt(t).jti;
          return typeof jti === 'string' ? jti : '';
        } catch {
          return '';
        }
      });
    } else {
      const set = grants as DecisionGrantSet;
      tokens = set.grants.map((g) => g.token);
      action = set.action;
      caseVersion = set.caseVersion;
      expectedJtis = set.grants.map((g) => g.jti);
    }
    let data: unknown;
    try {
      data = await this.#http.post(
        '/v1/decisions/consume',
        strip({ decisionGrants: tokens, action, caseVersion, agentId: options.agentId, grantId: options.grantId }),
        { retry: false },
      );
    } catch (err) {
      if (err instanceof GrantexApiError) {
        const body = err.body as Record<string, unknown> | undefined;
        const subReason = body?.['subReason'];
        if ([400, 404, 409, 410].includes(err.statusCode) && typeof subReason === 'string' && KNOWN_SUB_REASONS.has(subReason)) {
          throw new DecisionGrantError(subReason as DecisionSubReason, err.message);
        }
      }
      if (err instanceof GrantexError) {
        throw new DecisionGrantError(DecisionSubReason.CONSUME_UNAVAILABLE, `decision grant could not be consumed: ${err.message}`);
      }
      throw err;
    }
    const record = data as Record<string, unknown> | null;
    if (!record || record['consumed'] !== true || !Array.isArray(record['jtis'])) {
      throw new DecisionGrantError(DecisionSubReason.CONSUME_UNAVAILABLE, 'unexpected response from the auth service');
    }
    const jtis = (record['jtis'] as unknown[]).map(String);
    if ([...jtis].sort().join(',') !== [...expectedJtis].sort().join(',')) {
      throw new DecisionGrantError(DecisionSubReason.CONSUME_UNAVAILABLE, 'the auth service consumed different decision grants');
    }
    const approvers = Array.isArray(record['approvers'])
      ? (record['approvers'] as unknown[]).filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
      : [];
    return {
      requestId: String(record['requestId'] ?? ''),
      jtis,
      actionHash: String(record['actionHash'] ?? ''),
      approvers,
    };
  }
}
