/**
 * In-memory revocation registry for GDT tokens.
 *
 * Provides instant revocation checking during verification.
 * In production, this would be backed by an on-chain registry or DID-based status list.
 */

import type { RevocationRegistry, RevokedEntry } from './types.js';

/**
 * In-memory implementation of the RevocationRegistry interface.
 * Suitable for single-process deployments and testing.
 */
export class InMemoryRevocationRegistry implements RevocationRegistry {
  private readonly revoked = new Map<string, RevokedEntry>();

  async revoke(tokenId: string, reason?: string): Promise<void> {
    this.revoked.set(tokenId, {
      tokenId,
      revokedAt: new Date().toISOString(),
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  async isRevoked(tokenId: string): Promise<boolean> {
    return this.revoked.has(tokenId);
  }

  async listRevoked(): Promise<RevokedEntry[]> {
    return Array.from(this.revoked.values()).sort(
      (a, b) => new Date(b.revokedAt).getTime() - new Date(a.revokedAt).getTime(),
    );
  }

  /** Clear all entries (testing helper). */
  clear(): void {
    this.revoked.clear();
  }

  /** Number of revoked tokens. */
  get size(): number {
    return this.revoked.size;
  }
}

/** Singleton default registry used by the verify functions. */
let defaultRegistry: RevocationRegistry = new InMemoryRevocationRegistry();

/** Get the current default revocation registry. */
export function getRevocationRegistry(): RevocationRegistry {
  return defaultRegistry;
}

/** Replace the default revocation registry (e.g. with an on-chain implementation). */
export function setRevocationRegistry(registry: RevocationRegistry): void {
  defaultRegistry = registry;
}
