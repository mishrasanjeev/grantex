/**
 * Runtime purpose enforcement.
 *
 * Checks whether a grant token's scopes satisfy the requirements for a
 * declared processing purpose. This is the guard that prevents an AI agent
 * from processing data beyond the scope of the user's consent.
 */

import type { DPDPConsentRecord } from '../types.js';
import type { PurposeRegistry } from './purpose-registry.js';
import { PurposeViolationError, DpdpError } from '../errors.js';

/**
 * Enforce that a grant's scopes satisfy a named purpose.
 *
 * @param grantScopes - scopes present on the grant token
 * @param purposeId - the purpose being invoked
 * @param purposeRegistry - the purpose registry containing scope mappings
 * @throws PurposeViolationError if the grant does not cover all required scopes
 */
export function enforcePurpose(
  grantScopes: string[],
  purposeId: string,
  purposeRegistry: PurposeRegistry,
): void {
  const requiredScopes = purposeRegistry.getScopesForPurpose(purposeId);
  if (!requiredScopes) {
    throw new DpdpError(
      `Purpose "${purposeId}" is not registered`,
      'PURPOSE_NOT_FOUND',
      404,
    );
  }

  const grantScopeSet = new Set(grantScopes);
  const missing = requiredScopes.filter((s) => !grantScopeSet.has(s));

  if (missing.length > 0) {
    throw new PurposeViolationError(purposeId, missing);
  }
}

/**
 * Check that a consent record has proper purpose definitions — every purpose
 * must have a non-empty name, description, legal basis, and data categories.
 *
 * @returns An array of validation error strings (empty if compliant).
 */
export function checkPurposeCompliance(record: DPDPConsentRecord): string[] {
  const errors: string[] = [];

  if (!record.purposes || record.purposes.length === 0) {
    errors.push('Consent record has no declared purposes');
    return errors;
  }

  if (record.status !== 'active') {
    errors.push(`Consent record is ${record.status}, not active`);
  }

  for (const p of record.purposes) {
    if (!p.purposeId) errors.push('Purpose missing purposeId');
    if (!p.name) errors.push(`Purpose "${p.purposeId || '?'}" missing name`);
    if (!p.description) errors.push(`Purpose "${p.purposeId || '?'}" missing description`);
    if (!p.legalBasis) errors.push(`Purpose "${p.purposeId || '?'}" missing legalBasis`);
    if (!p.dataCategories || p.dataCategories.length === 0) {
      errors.push(`Purpose "${p.purposeId || '?'}" missing dataCategories`);
    }
    if (!p.retentionPeriod) {
      errors.push(`Purpose "${p.purposeId || '?'}" missing retentionPeriod`);
    }
  }

  return errors;
}
