/**
 * Decision-grant settings, read from the environment on every use so a bad
 * value fails the request that needs it (closed, with a reason) instead of
 * being silently defaulted.
 */
import { config, parseIntegerSetting } from '../../config.js';
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
  loginStateSeconds: number;
  /** Browser origin of the approval page (from PUBLIC_BASE_URL). */
  publicOrigin: string;
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
  const minMs = integer('DECISION_MIN_DWELL_MS', '2000', 0, 3_600_000);
  const maxMs = integer('DECISION_MAX_DWELL_MS', '86400000', 1_000, 86_400_000);
  if (minMs > maxMs) {
    throw new DecisionSettingsError('DECISION_MIN_DWELL_MS must not exceed DECISION_MAX_DWELL_MS');
  }
  // Approver email hashes and names are protected with the vault key.
  if (!config.vaultEncryptionKey) {
    throw new DecisionSettingsError('VAULT_ENCRYPTION_KEY is required for decision grants');
  }
  let publicOrigin: string;
  try {
    const url = new URL(config.publicBaseUrl);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
      throw new Error('insecure');
    }
    publicOrigin = url.origin;
  } catch {
    throw new DecisionSettingsError('PUBLIC_BASE_URL must be an https URL (or http on localhost) for decision grants');
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
    loginStateSeconds: integer('DECISION_LOGIN_STATE_SECONDS', '600', 60, 1_800),
    publicOrigin,
  };
}
