/**
 * Named purpose registry — maps purpose definitions to required scopes.
 *
 * DPDP Act 2023, s.4 — personal data may be processed only for a lawful
 * purpose (s.4(2): one not expressly forbidden by law), with the data
 * principal's consent or for a legitimate use.
 *
 * The registry holds the local purpose model. Only `{ code: purposeId,
 * description }` is ever sent to the server (see `toWirePurpose`).
 */

import type { RegisteredPurpose, ConsentPurpose, WirePurpose } from '../types.js';

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
   * Convert a registered purpose into the local `ConsentPurpose` model.
   * Its fields beyond `purposeId` and `description` are local-only.
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

  /**
   * The wire shape `{ code, description }` of a registered purpose, as the
   * server stores it. Returns `undefined` if the purpose is not registered.
   */
  toWirePurpose(purposeId: string): WirePurpose | undefined {
    const rp = this.purposes.get(purposeId);
    if (!rp) return undefined;
    return { code: rp.purposeId, description: rp.description };
  }
}
