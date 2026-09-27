/**
 * Auth-service API for decision grants (PRD G-3): `grantex.decisions`.
 *
 * A platform creates decision requests and consumes decision grants with its
 * API key. It cannot approve: a person approves on the auth service's approval
 * page (`approvalPage` in the request) after signing in with an identity
 * provider the service administrator allow-listed. The auth service must run
 * with `DECISION_GRANTS_ENABLED=true`.
 *
 * When the auth service binds decision grants to the requesting agent
 * (`DECISION_GRANT_AGENT_BINDING=true`), the API key alone never receives a
 * decision grant: a request that names an agent (`agentId`, `grantId`)
 * releases its grants only to that agent's grant token (`getGrants`), and they
 * are consumed only for that agent and grant. A request that names none is the
 * platform's own and is consumed by its id (`consumeRequest`). `getGrants` and
 * `consumeRequest` work whether or not the binding is on.
 */
import { decodeJwt } from 'jose';
import type { HttpClient } from '../http.js';
import { GrantexApiError, GrantexError } from '../errors.js';
import { DecisionSubReason } from '../denials.js';
import { parseDecisionAction, type DecisionAction } from '../decisions/action.js';
import { DecisionGrantError, type DecisionGrantSet } from '../decisions/verify.js';

const KNOWN_SUB_REASONS = new Set<string>(Object.values(DecisionSubReason));

/** The issuer's record that decision grants were consumed for one action. */
export interface ConsumedDecision {
  requestId: string;
  jtis: string[];
  actionHash: string;
  approvers: Record<string, unknown>[];
}

/**
 * Consumes decision grants atomically at their issuer. `enforce()` passes
 * `agentDid` and `grantId` from the caller's verified grant token; an issuer
 * that binds decision grants to the requesting agent refuses a decision
 * requested for another agent or grant (`wrong_agent`).
 */
export interface DecisionConsumer {
  consume(grants: DecisionGrantSet, options?: ConsumeDecisionParams): Promise<ConsumedDecision>;
}

export interface CreateDecisionRequestParams {
  action: DecisionAction;
  connector: string;
  caseVersion: string;
  /** The manifest's `four_eyes_on`; two approvals are required when it lists the decision. */
  /** The memo the approver reviews (text). Stored with its hash and bound into the grant. */
  memo: { content: string; ref?: string };
  /** The policy score the approver reviews (a JSON object). Stored with its hash and bound into the grant. */
  policyScore: { content: Record<string, unknown>; ref?: string };
  fourEyesOn?: string[];
  approvalsRequired?: 1 | 2;
  expiresInSeconds?: number;
  /**
   * The Grantex agent id (`ag_...`) of the agent the decision is for. With the
   * binding on, only that agent's grant token can fetch the grants, and they
   * are consumed only for that agent.
   */
  agentId?: string;
  /** The grant the decision is for; with the binding on, consumed only under that grant. */
  grantId?: string;
}

export interface ConsumeDecisionParams {
  /**
   * The DID of the agent the call is made for, from its verified grant token
   * (what `enforce()` passes). Sent as `agentDid`, which an auth service that
   * does not bind decision grants to the requesting agent ignores, so it is
   * safe to send to any version.
   */
  agentDid?: string;
  /** The Grantex agent id (`ag_...`) of the agent the call is made for, when the platform knows it. */
  agentId?: string;
  /** The grant the call is made under, from the same token. */
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

  /** Register the case's current version; unconsumed grants for other versions are revoked. */
  setCaseVersion(caseId: string, caseVersion: string): Promise<Record<string, unknown>> {
    return this.#http.put(`/v1/decisions/cases/${encodeURIComponent(caseId)}`, { caseVersion });
  }

  /** Ask a person to decide one semantic action. Idempotent while the request is open. */
  createRequest(params: CreateDecisionRequestParams): Promise<Record<string, unknown>> {
    return this.#http.post('/v1/decisions/requests', strip({ ...params, action: parseDecisionAction(params.action) }));
  }

  /**
   * Status and approvals (by `jti`). With the binding on, also
   * `decisionGrantsReady` and never the decision grants themselves: use
   * `getGrants` with the requesting agent's grant token. With it off, also
   * `decisionGrants` once fully approved and still usable.
   */
  getRequest(requestId: string): Promise<Record<string, unknown>> {
    return this.#http.get(`/v1/decisions/requests/${encodeURIComponent(requestId)}`);
  }

  /**
   * The request with `decisionGrantsReady`, plus `decisionGrants` once fully
   * approved and still usable. Released only for a request that names an
   * agent, and only against a live grant token of that agent and grant:
   * anything else is refused with `wrong_agent`. Every hand-out and refusal is
   * recorded in the audit chain.
   */
  getGrants(requestId: string, grantToken: string): Promise<Record<string, unknown>> {
    return this.#http.post(`/v1/decisions/requests/${encodeURIComponent(requestId)}/grants`, { grantToken });
  }

  cancelRequest(requestId: string): Promise<Record<string, unknown>> {
    return this.#http.post(`/v1/decisions/requests/${encodeURIComponent(requestId)}/cancel`);
  }

  /**
   * Consume decision grants atomically at the auth service. Pass a verified
   * `DecisionGrantSet`, or the tokens with the action and case version.
   * Throws `DecisionGrantError` with the issuer's sub-reason when refused and
   * `consume_unavailable` when the issuer cannot be reached or answers
   * unexpectedly: an unconfirmed consumption is never treated as success.
   *
   * Consumption spends the grants. If the response is lost after the auth
   * service consumed them, or the tool call fails afterwards, they stay spent
   * and a person has to approve again.
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
    const record = await this.#consume(
      '/v1/decisions/consume',
      strip({ decisionGrants: tokens, action, caseVersion, agentId: options.agentId, agentDid: options.agentDid, grantId: options.grantId }),
    );
    const jtis = (record['jtis'] as unknown[]).map(String);
    if ([...jtis].sort().join(',') !== [...expectedJtis].sort().join(',')) {
      throw new DecisionGrantError(DecisionSubReason.CONSUME_UNAVAILABLE, 'the auth service consumed different decision grants');
    }
    return receipt(record, jtis);
  }

  /**
   * Consume the grants of a decision request that names no agent, by its id:
   * the platform that asked for the decision spends it without ever holding
   * the tokens. A request that names an agent is refused (`wrong_agent`); its
   * grants are consumed only as that agent presents them. Errors and the
   * no-retry rule are as for `consume`.
   */
  async consumeRequest(requestId: string, options: { action: DecisionAction; caseVersion: string }): Promise<ConsumedDecision> {
    const record = await this.#consume(`/v1/decisions/requests/${encodeURIComponent(requestId)}/consume`, {
      action: parseDecisionAction(options.action),
      caseVersion: options.caseVersion,
    });
    const jtis = (record['jtis'] as unknown[]).map(String);
    if (record['requestId'] !== requestId || jtis.length === 0) {
      throw new DecisionGrantError(DecisionSubReason.CONSUME_UNAVAILABLE, 'the auth service consumed another decision');
    }
    return receipt(record, jtis);
  }

  /** POSTs a consumption once; anything but a confirmed one throws `DecisionGrantError`. */
  async #consume(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    let data: unknown;
    try {
      data = await this.#http.post(path, body, { retry: false });
    } catch (err) {
      if (err instanceof GrantexApiError) {
        const errorBody = err.body as Record<string, unknown> | undefined;
        const subReason = errorBody?.['subReason'];
        if ([400, 403, 404, 409, 410].includes(err.statusCode) && typeof subReason === 'string' && KNOWN_SUB_REASONS.has(subReason)) {
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
    return record;
  }
}

function receipt(record: Record<string, unknown>, jtis: string[]): ConsumedDecision {
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
