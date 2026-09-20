/**
 * Decision grants (PRD G-3): the semantic action a person approves and its
 * hash. Specified in `spec/canonicalization.md` and `spec/decision-grant.md`.
 */
export {
  ACTION_FIELDS,
  ACTION_HASH_PREFIX,
  ActionValidationError,
  MAX_CASE_ID_LENGTH,
  MAX_EXTRA_FIELDS,
  MAX_SUBJECT_LENGTH,
  canonicalActionJson,
  computeActionHash,
  decisionActionFromToolCall,
  isActionHash,
  isInvisibleFormatCodePoint,
  parseDecisionAction,
  parseDecisionActionJson,
} from './action.js';
export type { ActionValidationCode, DecisionAction } from './action.js';
