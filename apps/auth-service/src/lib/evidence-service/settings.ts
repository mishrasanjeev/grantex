/**
 * Evidence export settings (PRD G-5), read at request time so tests can stub
 * them; `evidenceConfigErrors` is also checked at startup so a malformed value
 * stops the service instead of being ignored.
 *
 * - EVIDENCE_EXPORT_ENABLED=true turns the evidence endpoints on (default off).
 * - EVIDENCE_EXPORT_DEVELOPER_IDS, when set, limits them to these developers.
 * - EVIDENCE_DISCLOSURE_DEVELOPER_IDS lists the developers an operator has
 *   allowed to export identifiers or content in the clear; nobody else may.
 * - EVIDENCE_PSEUDONYMISATION_SECRET (at least 32 characters) derives each
 *   tenant's pseudonymisation key; exports need it.
 * - EVIDENCE_PSEUDONYMISATION_KEY_ID names the secret in packages (default v1).
 */
import { createHmac } from 'node:crypto';

export interface EvidenceSettings {
  enabled: boolean;
  developerIds: ReadonlySet<string> | null;
  disclosureDeveloperIds: ReadonlySet<string>;
  keyId: string | null;
  secret: string | null;
}

const KEY_ID = /^[A-Za-z0-9._:-]{1,64}$/;

function idList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((id) => id.trim()).filter((id) => id.length > 0);
}

/** Configuration errors that must stop the service at startup. */
export function evidenceConfigErrors(env: NodeJS.ProcessEnv = process.env): string[] {
  const errors: string[] = [];
  const keyId = env['EVIDENCE_PSEUDONYMISATION_KEY_ID'];
  if (keyId !== undefined && !KEY_ID.test(keyId)) {
    errors.push('EVIDENCE_PSEUDONYMISATION_KEY_ID must be 1-64 characters of A-Z a-z 0-9 . _ : -');
  }
  const secret = env['EVIDENCE_PSEUDONYMISATION_SECRET'];
  if (secret !== undefined && secret !== '' && secret.length < 32) {
    errors.push('EVIDENCE_PSEUDONYMISATION_SECRET must be at least 32 characters');
  }
  const enabled = env['EVIDENCE_EXPORT_ENABLED'];
  if (enabled !== undefined && enabled !== 'true' && enabled !== 'false') {
    errors.push('EVIDENCE_EXPORT_ENABLED must be true or false');
  }
  return errors;
}

export function evidenceSettings(env: NodeJS.ProcessEnv = process.env): EvidenceSettings {
  const ids = idList(env['EVIDENCE_EXPORT_DEVELOPER_IDS']);
  const secret = env['EVIDENCE_PSEUDONYMISATION_SECRET'] ?? '';
  const keyId = env['EVIDENCE_PSEUDONYMISATION_KEY_ID'] ?? 'v1';
  return {
    enabled: env['EVIDENCE_EXPORT_ENABLED'] === 'true',
    developerIds: ids.length > 0 ? new Set(ids) : null,
    disclosureDeveloperIds: new Set(idList(env['EVIDENCE_DISCLOSURE_DEVELOPER_IDS'])),
    // An invalid key id fails startup; at request time it also refuses to export.
    keyId: KEY_ID.test(keyId) ? keyId : null,
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
