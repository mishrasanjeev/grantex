/**
 * What the client knows is revoked.
 *
 * `enforce()` verifies a grant token offline, so on its own it cannot see a
 * revocation: the token stays cryptographically valid until it expires. This
 * set is the answer — a small in-memory index of the grants and tokens the
 * auth service says are no longer usable, kept current by the revocation feed.
 */

export type RevocationAction = 'revoked' | 'suspended' | 'resumed' | 'token_revoked';

export interface RevocationEntry {
  seq: number;
  action: RevocationAction;
  grantId: string | null;
  jti: string | null;
  expiresAt: string | null;
  at: string;
}

export interface CredentialRef {
  grantId?: string | undefined;
  tokenId?: string | undefined;
  parentGrantId?: string | undefined;
}

export interface RevocationMatch {
  /** Which identifier matched: the grant, the token, or the parent grant. */
  kind: 'grant' | 'token' | 'parent_grant';
  id: string;
  action: RevocationAction;
}

/** The identifiers a client believes are revoked or suspended, with when they expire. */
export class RevokedSet {
  readonly #grants = new Map<string, { until: number; action: RevocationAction }>();
  readonly #tokens = new Map<string, { until: number; action: RevocationAction }>();

  get size(): number {
    return this.#grants.size + this.#tokens.size;
  }

  /**
   * Apply one feed entry. `resumed` removes a suspension; a revocation is
   * never undone, and the auth service never emits `resumed` for one.
   */
  apply(entry: RevocationEntry): void {
    const until = entry.expiresAt === null ? Number.POSITIVE_INFINITY : Date.parse(entry.expiresAt);
    const valid = Number.isNaN(until) ? Number.POSITIVE_INFINITY : until;
    if (entry.action === 'resumed') {
      if (entry.grantId !== null) this.#grants.delete(entry.grantId);
      return;
    }
    if (entry.action === 'token_revoked') {
      if (entry.jti !== null) this.#tokens.set(entry.jti, { until: valid, action: entry.action });
      return;
    }
    if (entry.grantId !== null) this.#grants.set(entry.grantId, { until: valid, action: entry.action });
  }

  applyAll(entries: readonly RevocationEntry[]): void {
    for (const entry of entries) this.apply(entry);
  }

  /** Why this credential must not be used, or `null` if this set knows nothing against it. */
  match(ref: CredentialRef, now: number = Date.now()): RevocationMatch | null {
    const grant = ref.grantId === undefined ? undefined : this.#grants.get(ref.grantId);
    if (grant && grant.until > now) return { kind: 'grant', id: ref.grantId!, action: grant.action };
    const token = ref.tokenId === undefined ? undefined : this.#tokens.get(ref.tokenId);
    if (token && token.until > now) return { kind: 'token', id: ref.tokenId!, action: token.action };
    // A cascade revokes children too, so a parent entry alone should never
    // decide a call — but honouring it costs nothing and closes the window
    // where a child's own entry has not arrived yet.
    const parent = ref.parentGrantId === undefined ? undefined : this.#grants.get(ref.parentGrantId);
    if (parent && parent.until > now) return { kind: 'parent_grant', id: ref.parentGrantId!, action: parent.action };
    return null;
  }

  /** Forget entries whose credential has expired; it can no longer be used anyway. */
  prune(now: number = Date.now()): void {
    for (const [id, entry] of this.#grants) if (entry.until <= now) this.#grants.delete(id);
    for (const [id, entry] of this.#tokens) if (entry.until <= now) this.#tokens.delete(id);
  }

  clear(): void {
    this.#grants.clear();
    this.#tokens.clear();
  }
}
