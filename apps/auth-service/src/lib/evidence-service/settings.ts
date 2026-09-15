/**
 * Evidence export settings (PRD G-5), read at request time so a deployment
 * can change them without a rebuild and tests can stub them.
 *
 * - EVIDENCE_EXPORT_ENABLED=true turns the evidence endpoints on (default off).
 * - EVIDENCE_EXPORT_DEVELOPER_IDS, when set, limits them to these developers
 *   (comma separated), for a staged per-tenant rollout.
 * - EVIDENCE_PSEUDONYMISATION_SECRET (at least 32 characters) derives each
 *   tenant's pseudonymisation key; without it only fully disclosed exports work.
 * - EVIDENCE_PSEUDONYMISATION_KEY_ID names the secret in packages (default v1).
 */
import { createHmac } from 'node:crypto';

export interface EvidenceSettings {
  enabled: boolean;
  developerIds: ReadonlySet<string> | null;
  keyId: string;
  secret: string | null;
}

const KEY_ID = /^[A-Za-z0-9._:-]{1,64}$/;

export function evidenceSettings(env: NodeJS.ProcessEnv = process.env): EvidenceSettings {
  const ids = (env['EVIDENCE_EXPORT_DEVELOPER_IDS'] ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const secret = env['EVIDENCE_PSEUDONYMISATION_SECRET'] ?? '';
  const keyId = env['EVIDENCE_PSEUDONYMISATION_KEY_ID'] ?? 'v1';
  return {
    enabled: env['EVIDENCE_EXPORT_ENABLED'] === 'true',
    developerIds: ids.length > 0 ? new Set(ids) : null,
    keyId: KEY_ID.test(keyId) ? keyId : 'v1',
    secret: secret.length >= 32 ? secret : null,
  };
}

export function evidenceEnabledFor(settings: EvidenceSettings, developerId: string): boolean {
  return settings.enabled && (settings.developerIds === null || settings.developerIds.has(developerId));
}

/** The tenant pseudonymisation key: HMAC-SHA256(secret, "grantex-evidence-tenant:" + developerId). */
export function tenantPseudonymisationKey(secret: string, developerId: string): Buffer {
  return createHmac('sha256', secret).update(`grantex-evidence-tenant:${developerId}`, 'utf8').digest();
}
