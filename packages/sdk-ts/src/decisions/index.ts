/**
 * Decision grants (PRD G-3): the semantic action a person approves and its
 * hash. Specified in `spec/canonicalization.md` and `spec/decision-grant.md`.
 */
export {
  ACTION_FIELDS,
  ACTION_HASH_PREFIX,
  ActionValidationError,
  MAX_CASE_ID_LENGTH,
  MAX_SUBJECT_LENGTH,
  canonicalActionJson,
  computeActionHash,
  decisionActionFromToolCall,
  isActionHash,
  parseDecisionAction,
} from './action.js';
export type { ActionValidationCode, DecisionAction } from './action.js';
export {
  DECISION_GRANT_AUDIENCE,
  DECISION_GRANT_TYP,
  DecisionGrantError,
  verifyDecisionGrant,
  verifyDecisionGrants,
} from './verify.js';
export type {
  DecisionGrant,
  DecisionGrantSet,
  DecisionKey,
  FourEyes,
  VerifyDecisionGrantOptions,
  VerifyDecisionGrantsOptions,
} from './verify.js';
export { APPROVER_SESSION_HEADER, DecisionsClient } from '../resources/decisions.js';
export type {
  ConsumeDecisionParams,
  ConsumedDecision,
  CreateDecisionRequestParams,
  DecisionConsumer,
} from '../resources/decisions.js';
