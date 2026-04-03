/**
 * Named purpose registry — maps purpose definitions to required scopes.
 *
 * DPDP Act 2023, Section 4 — processing must be for a specific, clear,
 * and lawful purpose communicated to the data principal.
 */

import type { RegisteredPurpose, ConsentPurpose } from '../types.js';

export class PurposeRegistry {
  private readonly purposes = new Map<string, RegisteredPurpose>();

  /**
   * Register a named purpose with its required scopes.
   */
  register(purpose: RegisteredPurpose): void {
    this.purposes.set(purpose.purposeId, { ...purpose });
  }

  /**
   * Get a registered purpose by ID.
   */
  get(purposeId: string): RegisteredPurpose | undefined {
    return this.purposes.get(purposeId);
  }

  /**
   * List all registered purposes.
   */
  listAll(): RegisteredPurpose[] {
    return Array.from(this.purposes.values());
  }

  /**
   * Get the scopes required for a given purpose.
   * Returns `undefined` if the purpose is not registered.
   */
  getScopesForPurpose(purposeId: string): string[] | undefined {
    return this.purposes.get(purposeId)?.requiredScopes;
  }

  /**
   * Convert a registered purpose into a ConsentPurpose suitable for consent records.
   */
  toConsentPurpose(purposeId: string): ConsentPurpose | undefined {
    const rp = this.purposes.get(purposeId);
    if (!rp) return undefined;

    return {
      purposeId: rp.purposeId,
      name: rp.name,
      description: rp.description,
      legalBasis: rp.legalBasis,
      dataCategories: rp.dataCategories,
      retentionPeriod: rp.retentionPeriod,
      thirdPartySharing: rp.thirdPartySharing,
      ...(rp.thirdParties !== undefined ? { thirdParties: rp.thirdParties } : {}),
    };
  }
}
