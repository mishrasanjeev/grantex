/**
 * Decision-grant settings, read from the environment on every use so a bad
 * value fails the request that needs it (closed, with a reason) instead of
 * being silently defaulted.
 */
import { parseIntegerSetting } from '../../config.js';
import type { DwellPolicy, StepUpPolicy } from './policy.js';

export class DecisionSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionSettingsError';
  }
}

export interface DecisionSettings {
  enabled: boolean;
  stepUp: StepUpPolicy;
  dwell: DwellPolicy;
  pageTicketSeconds: number;
}

const METHOD_RE = /^[A-Za-z0-9_:.-]{1,255}$/;

function list(name: string, fallback: string): string[] {
  const raw = process.env[name] ?? fallback;
  const values = raw.split(',').map((v) => v.trim()).filter((v) => v.length > 0);
  for (const value of values) {
    if (!METHOD_RE.test(value)) throw new DecisionSettingsError(`${name} contains an invalid value`);
  }
  return values;
}

function integer(name: string, fallback: string, min: number, max: number): number {
  try {
    return parseIntegerSetting(name, process.env[name] ?? fallback, min, max);
  } catch (err) {
    throw new DecisionSettingsError(err instanceof Error ? err.message : `${name} is invalid`);
  }
}

/** Whether the decision-grant endpoints are enabled (`DECISION_GRANTS_ENABLED=true`, default off). */
export function decisionGrantsEnabled(): boolean {
  return process.env['DECISION_GRANTS_ENABLED'] === 'true';
}

export function decisionSettings(): DecisionSettings {
  const acrValues = list('DECISION_STEP_UP_ACR', '');
  const amrValues = list('DECISION_STEP_UP_AMR', 'mfa,hwk');
  if (acrValues.length === 0 && amrValues.length === 0) {
    throw new DecisionSettingsError('DECISION_STEP_UP_ACR and DECISION_STEP_UP_AMR cannot both be empty');
  }
  const minMs = integer('DECISION_MIN_DWELL_MS', '0', 0, 3_600_000);
  const maxMs = integer('DECISION_MAX_DWELL_MS', '86400000', 1_000, 86_400_000);
  if (minMs > maxMs) {
    throw new DecisionSettingsError('DECISION_MIN_DWELL_MS must not exceed DECISION_MAX_DWELL_MS');
  }
  return {
    enabled: decisionGrantsEnabled(),
    stepUp: {
      acrValues,
      amrValues,
      maxAgeSeconds: integer('DECISION_STEP_UP_MAX_AGE_SECONDS', '3600', 60, 43_200),
      idTokenMaxAgeSeconds: integer('DECISION_ID_TOKEN_MAX_AGE_SECONDS', '600', 30, 3_600),
    },
    dwell: { minMs, maxMs },
    pageTicketSeconds: integer('DECISION_PAGE_TICKET_SECONDS', '300', 30, 900),
  };
}
