/**
 * OACP arbiter decisions (G16): the record of every decision AgenticOrg's
 * deterministic policy arbiter seals, and, for an `allow`, a machine-profile
 * decision grant countersigning it (spec/decision-grant.md section 10).
 *
 * The arbiter is authoritative; this service validates the record's shape,
 * stores it append-only (idempotent on `decision_id`: the same body answers
 * the same, a different body is refused 409), and signs a short-lived
 * `decision+jwt` for an `allow`. A `refuse` is recorded and nothing is
 * minted: a token is a permission. No path waits on a person.
 */
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { canonicalize } from '../decisions/canonical.js';
import { newDecisionGrantId } from '../decisions/store.js';
import {
  ARBITER_DECISION_GRANT_MAX_LIFETIME_SECONDS,
  POLICY_ARBITER_APPROVER_AUTH,
  signArbiterDecisionGrant,
  type ArbiterDecisionGrantClaims,
} from '../decisions/token.js';
import { CommerceHttpError } from './errors.js';

type Sql = ReturnType<typeof postgres>;

/** How far in the future `decided_at` may be, for clock skew between the services. */
export const ARBITER_DECIDED_AT_SKEW_SECONDS = 60;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ACTION_RE = /^[a-z][a-z0-9_.:-]{0,127}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const RULE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const TEXT_MAX = 256;
const MAX_RULES = 64;
const MAX_ARTIFACT_IDS = 64;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const EVIDENCE_KEYS = ['mandate_ref', 'mandate_hash', 'consent_ref', 'consent_status', 'passport_ref', 'artifact_ids'] as const;
const BODY_KEYS = [
  'decision_id', 'tenant_id', 'merchant_id', 'seller_agent_id', 'buyer_agent_id', 'action', 'action_hash',
  'outcome', 'rules_evaluated', 'failing_rule', 'evidence', 'decided_at', 'policy_version',
] as const;

export interface ArbiterEvidence {
  mandate_ref: string | null;
  mandate_hash: string | null;
  consent_ref: string | null;
  consent_status: string | null;
  passport_ref: string | null;
  artifact_ids: string[];
}

/** An arbiter decision as AgenticOrg posts it, validated and normalised. */
export interface ArbiterDecision {
  decision_id: string;
  tenant_id: string;
  merchant_id: string;
  seller_agent_id: string;
  buyer_agent_id: string;
  action: string;
  action_hash: string;
  outcome: 'allow' | 'refuse';
  rules_evaluated: string[];
  failing_rule: string | null;
  evidence: ArbiterEvidence;
  /** As sent; its instant is `decidedAtMs`. */
  decided_at: string;
  policy_version: string;
}

export type ArbiterDecisionAnswer =
  | { status: 201 | 200; body: { decision_id: string; outcome: 'allow'; decision_grant: string; jti: string; exp: number; expires_at: string } }
  | { status: 201 | 200; body: { decision_id: string; outcome: 'refuse'; recorded: true } };

function invalid(field: string, message: string): CommerceHttpError {
  return new CommerceHttpError(422, 'arbiter_decision_invalid', `${field}: ${message}`, {
    retryable: false,
    details: { field },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matching(body: Record<string, unknown>, field: string, re: RegExp): string {
  const value = body[field];
  if (typeof value !== 'string' || !re.test(value)) throw invalid(field, 'is missing or malformed');
  return value;
}

function nullableText(body: Record<string, unknown>, field: string, re?: RegExp): string | null {
  const value = body[field];
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > TEXT_MAX || (re !== undefined && !re.test(value))) {
    throw invalid(field, 'must be null or a short string');
  }
  return value;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Validates and normalises a posted arbiter decision. Unknown members are refused. */
export function parseArbiterDecision(raw: unknown): ArbiterDecision & { decidedAtMs: number } {
  if (!isRecord(raw)) throw invalid('body', 'must be a JSON object');
  for (const key of Object.keys(raw)) {
    if (!(BODY_KEYS as readonly string[]).includes(key)) throw invalid(key, 'is not a member of an arbiter decision');
  }
  const decision_id = matching(raw, 'decision_id', ID_RE);
  const tenant_id = matching(raw, 'tenant_id', ID_RE);
  const merchant_id = matching(raw, 'merchant_id', ID_RE);
  const seller_agent_id = matching(raw, 'seller_agent_id', ID_RE);
  const buyer_agent_id = matching(raw, 'buyer_agent_id', ID_RE);
  const action = matching(raw, 'action', ACTION_RE);
  const action_hash = matching(raw, 'action_hash', HEX64_RE);
  const outcome = raw['outcome'];
  if (outcome !== 'allow' && outcome !== 'refuse') throw invalid('outcome', 'must be allow or refuse');
  const rules = raw['rules_evaluated'];
  if (!Array.isArray(rules) || rules.length === 0 || rules.length > MAX_RULES
      || !rules.every((r) => typeof r === 'string' && RULE_RE.test(r))) {
    throw invalid('rules_evaluated', `must list 1-${MAX_RULES} rule names`);
  }
  if (new Set(rules).size !== rules.length) throw invalid('rules_evaluated', 'names a rule twice');
  if (!('failing_rule' in raw)) throw invalid('failing_rule', 'is required (null for allow)');
  const failing_rule = nullableText(raw, 'failing_rule', RULE_RE);
  // A refusal names the rule that refused; an allow names none.
  if (outcome === 'allow' && failing_rule !== null) throw invalid('failing_rule', 'must be null when the outcome is allow');
  if (outcome === 'refuse' && failing_rule === null) throw invalid('failing_rule', 'must name the rule that refused');
  if (failing_rule !== null && !rules.includes(failing_rule)) throw invalid('failing_rule', 'must be one of rules_evaluated');

  const ev = raw['evidence'];
  if (!isRecord(ev)) throw invalid('evidence', 'must be an object');
  for (const key of Object.keys(ev)) {
    if (!(EVIDENCE_KEYS as readonly string[]).includes(key)) throw invalid(`evidence.${key}`, 'is not an evidence member');
  }
  for (const key of EVIDENCE_KEYS) {
    if (!(key in ev)) throw invalid(`evidence.${key}`, 'is required (null when absent)');
  }
  const artifactIds = ev['artifact_ids'];
  if (!Array.isArray(artifactIds) || artifactIds.length > MAX_ARTIFACT_IDS
      || !artifactIds.every((a) => typeof a === 'string' && ID_RE.test(a))) {
    throw invalid('evidence.artifact_ids', `must list at most ${MAX_ARTIFACT_IDS} artifact ids`);
  }
  const evidence: ArbiterEvidence = {
    mandate_ref: nullableText(ev, 'mandate_ref'),
    mandate_hash: nullableText(ev, 'mandate_hash'),
    consent_ref: nullableText(ev, 'consent_ref'),
    consent_status: nullableText(ev, 'consent_status'),
    passport_ref: nullableText(ev, 'passport_ref'),
    artifact_ids: artifactIds as string[],
  };
  const decidedAt = raw['decided_at'];
  if (typeof decidedAt !== 'string' || !ISO_RE.test(decidedAt) || !Number.isFinite(Date.parse(decidedAt))) {
    throw invalid('decided_at', 'must be an RFC 3339 timestamp');
  }
  const policyVersion = raw['policy_version'];
  if (typeof policyVersion !== 'string' || policyVersion.length === 0 || policyVersion.length > 128) {
    throw invalid('policy_version', 'must be 1-128 characters');
  }
  return {
    decision_id, tenant_id, merchant_id, seller_agent_id, buyer_agent_id, action, action_hash,
    outcome, rules_evaluated: rules as string[], failing_rule, evidence,
    decided_at: decidedAt, policy_version: policyVersion,
    decidedAtMs: Date.parse(decidedAt),
  };
}

/**
 * The `amr` of a machine-profile grant: which evidence the arbiter rested
 * on, in a fixed order. `mandate` needs both its reference and its hash.
 */
export function arbiterEvidenceMethods(evidence: ArbiterEvidence): string[] {
  const amr: string[] = [];
  if (evidence.mandate_ref !== null && evidence.mandate_hash !== null) amr.push('mandate');
  if (evidence.consent_ref !== null) amr.push('consent');
  if (evidence.passport_ref !== null) amr.push('passport');
  if (evidence.artifact_ids.length > 0) amr.push('oacp_artifact');
  return amr;
}

/** Lowercase hex SHA-256 of the RFC 8785 form of the decision, the idempotency fingerprint. */
export function arbiterDecisionFingerprint(decision: ArbiterDecision): string {
  const { decision_id, tenant_id, merchant_id, seller_agent_id, buyer_agent_id, action, action_hash, outcome,
    rules_evaluated, failing_rule, evidence, decided_at, policy_version } = decision;
  return sha256Hex(canonicalize({
    decision_id, tenant_id, merchant_id, seller_agent_id, buyer_agent_id, action, action_hash, outcome,
    rules_evaluated, failing_rule, evidence, decided_at, policy_version,
  }));
}

/** The claims as stored: `iss` and `aud` are the signer's, so they are not kept. */
type StoredArbiterClaims = Omit<ArbiterDecisionGrantClaims, 'iss' | 'aud'>;

interface StoredDecisionRow {
  decision_id: string;
  outcome: 'allow' | 'refuse';
  request_hash: string;
  grant_jti: string | null;
  grant_claims: StoredArbiterClaims | null;
}

async function answerFor(row: StoredDecisionRow, status: 200 | 201): Promise<ArbiterDecisionAnswer> {
  if (row.outcome === 'refuse') {
    return { status, body: { decision_id: row.decision_id, outcome: 'refuse', recorded: true } };
  }
  const claims = row.grant_claims;
  if (claims === null || row.grant_jti === null) throw new Error('allow decision stored without its grant');
  // The stored claims are re-signed, as decision grants of human decisions
  // are: the token is never stored, and a replay carries the same jti and exp.
  const decisionGrant = await signArbiterDecisionGrant(claims);
  return {
    status,
    body: {
      decision_id: row.decision_id,
      outcome: 'allow',
      decision_grant: decisionGrant,
      jti: claims.jti,
      exp: claims.exp,
      expires_at: new Date(claims.exp * 1000).toISOString(),
    },
  };
}

function conflict(decisionId: string): CommerceHttpError {
  return new CommerceHttpError(409, 'arbiter_decision_conflict',
    'This decision_id is already recorded with a different body', {
      retryable: false,
      details: { decision_id: decisionId },
    });
}

async function storedDecision(sql: Sql, decisionId: string): Promise<StoredDecisionRow | undefined> {
  const rows = await sql<StoredDecisionRow[]>`
    SELECT decision_id, outcome, request_hash, grant_jti, grant_claims
      FROM commerce_arbiter_decisions WHERE decision_id = ${decisionId}
  `;
  return rows[0];
}

/**
 * Records one arbiter decision and answers it. `serviceId` is the
 * authenticated caller, recorded beside the decision. `now` is for tests.
 */
export async function recordArbiterDecision(
  sql: Sql,
  raw: unknown,
  serviceId: string,
  now: Date = new Date(),
): Promise<ArbiterDecisionAnswer> {
  const decision = parseArbiterDecision(raw);
  const requestHash = arbiterDecisionFingerprint(decision);

  const existing = await storedDecision(sql, decision.decision_id);
  if (existing) {
    if (existing.request_hash !== requestHash) throw conflict(decision.decision_id);
    return answerFor(existing, 200);
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);
  const decidedAtSeconds = Math.floor(decision.decidedAtMs / 1000);
  if (decidedAtSeconds > nowSeconds + ARBITER_DECIDED_AT_SKEW_SECONDS) {
    throw invalid('decided_at', 'is in the future');
  }
  let claims: StoredArbiterClaims | null = null;
  if (decision.outcome === 'allow') {
    const amr = arbiterEvidenceMethods(decision.evidence);
    // An allow that rests on no evidence at all is not countersigned.
    if (amr.length === 0) throw invalid('evidence', 'an allow must rest on at least one evidence reference');
    // At most ten minutes, counted from the decision, never extended by a late post.
    const exp = Math.min(nowSeconds, decidedAtSeconds) + ARBITER_DECISION_GRANT_MAX_LIFETIME_SECONDS;
    if (exp <= nowSeconds) {
      throw new CommerceHttpError(422, 'arbiter_decision_stale',
        'The decision is older than a machine-profile decision grant may live; re-decide', { retryable: false });
    }
    claims = {
      sub: decision.buyer_agent_id,
      jti: newDecisionGrantId(),
      iat: nowSeconds,
      exp,
      approver_auth: POLICY_ARBITER_APPROVER_AUTH,
      amr,
      auth_time: decidedAtSeconds,
      action_hash: decision.action_hash,
      dwell_ms: 0,
      dwell_source: 'server',
      decision_request: decision.decision_id,
      arbiter: {
        tenant_id: decision.tenant_id,
        merchant_id: decision.merchant_id,
        seller_agent_id: decision.seller_agent_id,
        action: decision.action,
        policy_version: decision.policy_version,
        rules_evaluated: decision.rules_evaluated,
        evidence_hash: sha256Hex(canonicalize(decision.evidence)),
      },
    };
  }

  const inserted = await sql<StoredDecisionRow[]>`
    INSERT INTO commerce_arbiter_decisions (
      decision_id, tenant_id, merchant_id, seller_agent_id, buyer_agent_id, action, action_hash, outcome,
      rules_evaluated, failing_rule, evidence, decided_at, policy_version, request_hash,
      grant_jti, grant_claims, grant_expires_at, service_id
    ) VALUES (
      ${decision.decision_id}, ${decision.tenant_id}, ${decision.merchant_id}, ${decision.seller_agent_id},
      ${decision.buyer_agent_id}, ${decision.action}, ${decision.action_hash}, ${decision.outcome},
      ${sql.json(decision.rules_evaluated)}, ${decision.failing_rule},
      ${sql.json(decision.evidence as unknown as postgres.JSONValue)}, ${decision.decided_at},
      ${decision.policy_version}, ${requestHash},
      ${claims?.jti ?? null}, ${claims === null ? null : sql.json(claims as unknown as postgres.JSONValue)},
      ${claims === null ? null : new Date(claims.exp * 1000)}, ${serviceId}
    )
    ON CONFLICT (decision_id) DO NOTHING
    RETURNING decision_id, outcome, request_hash, grant_jti, grant_claims
  `;
  if (inserted[0]) return answerFor(inserted[0], 201);
  // A concurrent post of the same decision_id won the insert: answer as it did.
  const raced = await storedDecision(sql, decision.decision_id);
  if (!raced) throw new Error('arbiter decision insert conflicted but no row exists');
  if (raced.request_hash !== requestHash) throw conflict(decision.decision_id);
  return answerFor(raced, 200);
}
