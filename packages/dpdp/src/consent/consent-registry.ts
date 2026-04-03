/**
 * In-memory immutable consent registry with caching.
 *
 * Provides a local cache of consent records that have been registered,
 * with lookup by record ID and by data principal ID.
 */

import type { DPDPConsentRecord } from '../types.js';

export interface ConsentRegistryStats {
  totalRecords: number;
  activeRecords: number;
  withdrawnRecords: number;
  expiredRecords: number;
  principalCount: number;
}

export class ConsentRegistry {
  private readonly records = new Map<string, DPDPConsentRecord>();
  private readonly byPrincipal = new Map<string, Set<string>>();

  /**
   * Register a consent record in the local cache.
   * Records are stored immutably — once registered, they cannot be updated
   * except through explicit withdrawal.
   */
  register(record: DPDPConsentRecord): void {
    if (this.records.has(record.recordId)) {
      throw new Error(`Consent record ${record.recordId} is already registered and is immutable`);
    }

    this.records.set(record.recordId, Object.freeze({ ...record }));

    let principalSet = this.byPrincipal.get(record.dataPrincipalId);
    if (!principalSet) {
      principalSet = new Set();
      this.byPrincipal.set(record.dataPrincipalId, principalSet);
    }
    principalSet.add(record.recordId);
  }

  /**
   * Get a consent record by ID.
   */
  get(recordId: string): DPDPConsentRecord | undefined {
    return this.records.get(recordId);
  }

  /**
   * List all consent records for a given data principal.
   */
  listForPrincipal(principalId: string): DPDPConsentRecord[] {
    const ids = this.byPrincipal.get(principalId);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.records.get(id)!)
      .filter(Boolean);
  }

  /**
   * Mark a record as withdrawn in the local cache. This replaces the frozen
   * record with a new frozen copy that has `status: 'withdrawn'`.
   */
  markWithdrawn(recordId: string, reason: string): void {
    const existing = this.records.get(recordId);
    if (!existing) {
      throw new Error(`Consent record ${recordId} not found`);
    }

    const updated: DPDPConsentRecord = Object.freeze({
      ...existing,
      status: 'withdrawn' as const,
      withdrawnAt: new Date(),
      withdrawnReason: reason,
    });

    this.records.set(recordId, updated);
  }

  /**
   * Get statistics about the registry.
   */
  getStats(): ConsentRegistryStats {
    let active = 0;
    let withdrawn = 0;
    let expired = 0;

    for (const record of this.records.values()) {
      switch (record.status) {
        case 'active':
          active++;
          break;
        case 'withdrawn':
          withdrawn++;
          break;
        case 'expired':
          expired++;
          break;
      }
    }

    return {
      totalRecords: this.records.size,
      activeRecords: active,
      withdrawnRecords: withdrawn,
      expiredRecords: expired,
      principalCount: this.byPrincipal.size,
    };
  }
}
